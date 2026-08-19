"""
FEU-COMPASS AI Engine — standalone demo.

This is the visual + semantic matching microservice extracted from FEU-COMPASS,
a Laravel-based campus lost-and-found and student-conduct system. In production
this service runs alongside a Laravel app that handles auth (Microsoft Azure AD),
SharePoint sync, and the registry database — none of that is needed here. This
file is 100% standalone: it loads a couple of images, scores them, and answers.

Two matching modes:

  POST /match      Visual similarity between a "lost" item photo and a batch of
                    "found" item photos. Combines SIFT/RootSIFT keypoint matching
                    with RANSAC/USAC_MAGSAC geometric verification, a subject-
                    isolated colour histogram, and a CLIP semantic fallback for
                    smooth/featureless objects SIFT can't get a grip on.

  POST /semantic    3-tier identity verification for found ID cards / documents:
                    Tier 1 exact ID-number match, Tier 2 Tesseract OCR with a
                    confusion-tolerant digit comparison (0/O, 1/I/l, etc.),
                    Tier 3 Gemini Vision as a fallback when OCR can't read the
                    document confidently.

  GET  /health      Liveness check.

Run it:
  pip install -r requirements.txt
  cp .env.example .env        # add your own GOOGLE_API_KEY if you want Tier 3
  uvicorn app.server:app --reload --port 8001

Then see demo/run_demo.py for a runnable example against your own sample images.
"""
import os
import re
import time
import difflib
import threading
import hashlib
import warnings

import cv2
import numpy as np
from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Optional
from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Optional imports — the service degrades gracefully if a package or API key
# isn't available, same as production. You can run pure-OpenCV matching with
# zero API keys, or add GOOGLE_API_KEY to unlock the Gemini fallback tier.
# ---------------------------------------------------------------------------

try:
    from PIL import Image as PILImage
    import pytesseract
    TESSERACT_AVAILABLE = True
except ImportError:
    TESSERACT_AVAILABLE = False

try:
    from google import genai as _genai
    _api_key = os.environ.get("GOOGLE_API_KEY")
    if _api_key:
        GEMINI_CLIENT = _genai.Client(api_key=_api_key)
        GEMINI_MODEL = "gemini-2.5-flash"
    else:
        GEMINI_CLIENT = None
        GEMINI_MODEL = None
    GEMINI_AVAILABLE = GEMINI_CLIENT is not None
except ImportError:
    GEMINI_AVAILABLE = False
    GEMINI_CLIENT = None
    GEMINI_MODEL = None

try:
    from rembg import new_session, remove as rembg_remove
    REMBG_AVAILABLE = True
except ImportError:
    REMBG_AVAILABLE = False

# CLIP is loaded lazily on first use, not at startup, so idle memory stays low
# until a match actually needs the featureless-object fallback.
_clip_model = None
_clip_preprocess = None
_clip_load_lock = threading.Lock()

try:
    import torch
    import open_clip
    CLIP_AVAILABLE = True
except Exception:
    CLIP_AVAILABLE = False


def _ensure_clip_loaded() -> bool:
    global _clip_model, _clip_preprocess
    if _clip_model is not None:
        return True
    with _clip_load_lock:
        if _clip_model is not None:
            return True
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                _clip_model, _, _clip_preprocess = open_clip.create_model_and_transforms(
                    "ViT-B-32", pretrained="openai"
                )
            _clip_model.eval()
            return True
        except Exception:
            return False


PORT = int(os.environ.get("PORT", 8001))

# Cache directory is local to this repo instead of the production Azure path
# (/home/site/wwwroot/storage/...) — descriptors and CLIP embeddings are cached
# here so re-running the demo on the same images is instant the second time.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESCRIPTOR_CACHE_DIR = os.path.join(BASE_DIR, ".cache", "descriptors")
os.makedirs(DESCRIPTOR_CACHE_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Pre-load heavy objects once at startup — stays warm across requests
# ---------------------------------------------------------------------------

CLAHE = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(8, 8))
SIFT = cv2.SIFT_create(nfeatures=2500)
FLANN = cv2.FlannBasedMatcher(dict(algorithm=1, trees=5), dict(checks=50))

REMBG_SESSION = None
if REMBG_AVAILABLE:
    try:
        REMBG_SESSION = new_session("u2netp")
    except Exception:
        REMBG_SESSION = None

app = FastAPI(title="FEU-COMPASS AI Engine (demo)")

print(
    f"[matcher] OpenCV {cv2.__version__} | "
    f"rembg={'on' if REMBG_SESSION else 'off'} | "
    f"clip={'lazy' if CLIP_AVAILABLE else 'off'} | "
    f"tesseract={'on' if TESSERACT_AVAILABLE else 'off'} | "
    f"gemini={'on' if GEMINI_AVAILABLE else 'off'} | "
    f"port {PORT}",
    flush=True,
)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class MatchRequest(BaseModel):
    target_img: str
    batch_json: str


class PrecomputeRequest(BaseModel):
    image_path: str


class StudentRecord(BaseModel):
    id: int
    name: str
    id_number: str


class SemanticRequest(BaseModel):
    image_path: str
    students: List[StudentRecord]
    id_hint: Optional[str] = ""
    name_hint: Optional[str] = ""


# ---------------------------------------------------------------------------
# RootSIFT — L1-normalize then sqrt, converts SIFT to the Hellinger kernel,
# which compares meaningfully better on real-world lost & found photos than
# raw SIFT distances do.
# ---------------------------------------------------------------------------

def apply_rootsift(des):
    if des is None or len(des) == 0:
        return des
    des = des.astype(np.float32)
    des /= (des.sum(axis=1, keepdims=True) + 1e-7)
    return np.sqrt(des)


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------

def resize_to_max_dim(image, max_dim=800):
    h, w = image.shape[:2]
    if max(h, w) <= max_dim:
        return image
    scale = max_dim / float(max(h, w))
    return cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


def _mask_from_rembg(img_bgr):
    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    raw = rembg_remove(PILImage.fromarray(img_rgb), session=REMBG_SESSION, only_mask=True)
    mask = np.array(raw)
    _, binary = cv2.threshold(mask, 128, 255, cv2.THRESH_BINARY)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=1)
    return binary


def _mask_from_grabcut(img_bgr):
    h, w = img_bgr.shape[:2]
    rect = (int(w * 0.10), int(h * 0.10), int(w * 0.80), int(h * 0.80))
    mask = np.zeros(img_bgr.shape[:2], np.uint8)
    bgd_mdl = np.zeros((1, 65), np.float64)
    fgd_mdl = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(img_bgr, mask, rect, bgd_mdl, fgd_mdl, 3, cv2.GC_INIT_WITH_RECT)
        return np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), np.uint8(255), np.uint8(0))
    except Exception:
        return np.ones(img_bgr.shape[:2], dtype=np.uint8) * 255


def get_subject_mask(img_bgr):
    """Isolate the item from its background before scoring — a plain white
    mug photographed on a wood desk vs. a marble counter shouldn't score low
    just because the backgrounds differ."""
    min_coverage = img_bgr.shape[0] * img_bgr.shape[1] * 0.03
    if REMBG_SESSION is not None:
        try:
            mask = _mask_from_rembg(img_bgr)
            if np.sum(mask > 0) >= min_coverage:
                return mask
        except Exception:
            pass
    try:
        mask = _mask_from_grabcut(img_bgr)
        if np.sum(mask > 0) >= min_coverage:
            return mask
    except Exception:
        pass
    return np.ones(img_bgr.shape[:2], dtype=np.uint8) * 255


# ---------------------------------------------------------------------------
# Descriptor / CLIP embedding cache
# ---------------------------------------------------------------------------

def _descriptor_cache_path(img_path):
    digest = hashlib.md5(img_path.encode()).hexdigest()
    return os.path.join(DESCRIPTOR_CACHE_DIR, digest + ".npz")


def load_cached_descriptors(img_path):
    cache = _descriptor_cache_path(img_path)
    if not os.path.exists(cache):
        return None, None
    try:
        data = np.load(cache, allow_pickle=False)
        kp_arr = data["kp"]
        des = data["des"]
        kp = [
            cv2.KeyPoint(x=p[0], y=p[1], size=p[2], angle=p[3], response=p[4], octave=int(p[5]), class_id=int(p[6]))
            for p in kp_arr
        ]
        return kp, des
    except Exception:
        return None, None


def save_descriptors(img_path, kp, des):
    if des is None or len(des) == 0:
        return
    kp_arr = np.array(
        [[p.pt[0], p.pt[1], p.size, p.angle, p.response, p.octave, p.class_id] for p in kp], dtype=np.float32
    )
    np.savez_compressed(_descriptor_cache_path(img_path), kp=kp_arr, des=des)


_clip_cache_lock = threading.Lock()


def _clip_cache_path(img_path):
    digest = hashlib.md5(img_path.encode()).hexdigest()
    return os.path.join(DESCRIPTOR_CACHE_DIR, digest + "_clip.npy")


def load_cached_clip(img_path):
    cache = _clip_cache_path(img_path)
    if not os.path.exists(cache):
        return None
    try:
        return np.load(cache)
    except Exception:
        return None


def get_clip_embedding(img_path):
    if not _ensure_clip_loaded():
        return None
    cached = load_cached_clip(img_path)
    if cached is not None:
        return cached
    with _clip_cache_lock:
        cached = load_cached_clip(img_path)
        if cached is not None:
            return cached
        try:
            img_pil = PILImage.open(img_path).convert("RGB")
            tensor = _clip_preprocess(img_pil).unsqueeze(0)
            with torch.no_grad():
                emb = _clip_model.encode_image(tensor)
                emb = emb / emb.norm(dim=-1, keepdim=True)
            result = emb.squeeze().numpy()
            np.save(_clip_cache_path(img_path), result)
            return result
        except Exception:
            return None


# ---------------------------------------------------------------------------
# Visual matching
# ---------------------------------------------------------------------------

def _precompute_descriptors(img_path: str) -> dict:
    if not os.path.exists(img_path):
        return {"error": True, "message": "Image not found."}
    img = cv2.imread(img_path)
    if img is None:
        return {"error": True, "message": "Image could not be read."}
    img = resize_to_max_dim(img)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    kp, des = SIFT.detectAndCompute(CLAHE.apply(gray), None)
    des = apply_rootsift(des)
    save_descriptors(img_path, kp, des)
    if CLIP_AVAILABLE:
        get_clip_embedding(img_path)
    return {"error": False, "keypoints": len(kp) if kp else 0}


def _score_item(item, img_target, h_target_norm, kp_t, des_t, clip_emb_t):
    db_img_path = item.get("image_path", "")
    if not os.path.exists(db_img_path):
        return None

    img_db_src = cv2.imread(db_img_path)
    if img_db_src is None:
        return None
    img_db = resize_to_max_dim(img_db_src)

    h_db = cv2.calcHist([img_db], [0, 1, 2], None, [8, 8, 8], [0, 256, 0, 256, 0, 256])
    color_score = max(0.0, cv2.compareHist(h_target_norm, cv2.normalize(h_db, h_db), cv2.HISTCMP_CORREL)) * 100.0

    kp_db, des_db = load_cached_descriptors(db_img_path)
    if des_db is None:
        gray_db = cv2.cvtColor(img_db, cv2.COLOR_BGR2GRAY)
        kp_db, des_db = SIFT.detectAndCompute(CLAHE.apply(gray_db), None)
        des_db = apply_rootsift(des_db)
        save_descriptors(db_img_path, kp_db, des_db)

    final_score = 0.0
    human_msg = "The item's physical characteristics do not match the target."
    has_des = des_t is not None and len(des_t) > 0 and des_db is not None and len(des_db) > 0

    if has_des:
        raw_matches = FLANN.knnMatch(des_t, des_db, k=2)
        good = [mn[0] for mn in raw_matches if len(mn) == 2 and mn[0].distance < 0.75 * mn[1].distance]
        match_score = min(100.0, (len(good) / 20.0) * 100.0)

        if len(good) >= 10:
            src_pts = np.float32([kp_t[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
            dst_pts = np.float32([kp_db[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
            _, mask_geo = cv2.findHomography(src_pts, dst_pts, cv2.USAC_MAGSAC, 5.0)
            inliers = int(np.sum(mask_geo)) if mask_geo is not None else 0
            inlier_ratio = inliers / len(good) if len(good) > 0 else 0

            if inlier_ratio >= 0.50 and inliers >= 8:
                final_score, human_msg = 90.0, "Exceptional match. Unique physical details are almost identical."
            elif inlier_ratio >= 0.35 and inliers >= 8:
                final_score, human_msg = 80.0, "Strong match. Visual patterns show a high level of consistency."
            elif inlier_ratio >= 0.20 and inliers >= 3:
                final_score = (65 * 0.60) + (color_score * 0.40)
                human_msg = "Likely match. System detected significant physical similarities."
            else:
                final_score = (match_score * 0.4 * 0.60) + (color_score * 0.40)
                human_msg = "Possible match. Keypoint similarity detected but geometry is inconclusive."
        else:
            if color_score >= 75:
                final_score, human_msg = color_score * 0.95, "Strong colour match. Item appearance is highly consistent."
            elif color_score >= 50:
                final_score, human_msg = color_score * 0.75, "Moderate colour match. Item appearance shows similarities."
            else:
                final_score = color_score * 0.50
    else:
        if color_score >= 75:
            final_score, human_msg = color_score * 0.95, "Strong colour match. Item appearance is highly consistent."
        elif color_score >= 50:
            final_score, human_msg = color_score * 0.75, "Moderate colour match. Item appearance shows similarities."
        else:
            final_score = color_score * 0.50

    # CLIP semantic fallback — kicks in when the classical pipeline scores low,
    # e.g. two visually similar but not identical items (a green vs. teal bottle).
    if CLIP_AVAILABLE and clip_emb_t is not None and final_score < 80.0:
        clip_emb_db = get_clip_embedding(db_img_path)
        if clip_emb_db is not None:
            cosine = float(np.dot(clip_emb_t, clip_emb_db))
            if cosine >= 0.90:
                clip_score, clip_msg = 90.0, "Strong semantic match. Items are visually very similar."
            elif cosine >= 0.82:
                clip_score, clip_msg = 82.0, "Good semantic match. Items share strong visual characteristics."
            elif cosine >= 0.75:
                clip_score, clip_msg = 76.0, "Possible semantic match. Items appear visually similar."
            else:
                clip_score, clip_msg = cosine * 70.0, ""
            if clip_score > final_score:
                final_score, human_msg = clip_score, clip_msg

    final_score = min(98.0, max(0.0, final_score))
    if final_score >= 75:
        return {"item_id": item.get("id"), "confidence_score": int(final_score), "breakdown": human_msg}
    return None


def _process_batch(target_img_path: str, database_items: list) -> dict:
    t0 = time.time()
    if not os.path.exists(target_img_path):
        return {"error": True, "message": "Reference image not found."}
    if not database_items:
        return {"error": False, "matches": [], "message": "No pending reports to compare."}

    img_target_src = cv2.imread(target_img_path)
    if img_target_src is None:
        return {"error": True, "message": "Reference image could not be read."}

    img_target = resize_to_max_dim(img_target_src)
    mask_target = get_subject_mask(img_target)
    h_target = cv2.calcHist([img_target], [0, 1, 2], mask_target, [8, 8, 8], [0, 256, 0, 256, 0, 256])
    h_target_norm = cv2.normalize(h_target, h_target)

    gray_t = cv2.cvtColor(img_target, cv2.COLOR_BGR2GRAY)
    kp_t, des_t = SIFT.detectAndCompute(CLAHE.apply(gray_t), None)
    des_t = apply_rootsift(des_t)
    clip_emb_t = get_clip_embedding(target_img_path) if CLIP_AVAILABLE else None

    results = []
    for item in database_items:
        result = _score_item(item, img_target, h_target_norm, kp_t, des_t, clip_emb_t)
        if result is not None:
            results.append(result)

    results.sort(key=lambda x: x["confidence_score"], reverse=True)
    print(f"[matcher] scored {len(database_items)} candidates, {len(results)} matches, {time.time()-t0:.1f}s", flush=True)
    return {"error": False, "matches": results[:5]}


# ---------------------------------------------------------------------------
# Semantic (ID / document) matching — 3-tier cascade
# ---------------------------------------------------------------------------

def _semantic_similarity(ocr_text: str, target: str) -> float:
    if not ocr_text or not target:
        return 0.0
    t1 = str(ocr_text).upper().replace(" ", "").replace("\n", "")
    t2 = str(target).upper().replace(" ", "")
    if len(t2) > 4 and t2 in t1:
        return 0.95
    return difflib.SequenceMatcher(None, t1, t2).ratio()


# Characters Tesseract commonly emits in place of digits on ID/COR photos.
_OCR_DIGIT_MAP = str.maketrans({
    "O": "0", "o": "0", "Q": "0", "D": "0",
    "I": "1", "l": "1", "L": "1", "|": "1", "i": "1",
    "Z": "2", "z": "2", "S": "5", "s": "5",
    "B": "8", "G": "6", "T": "7", "A": "4",
})


def _digit_stream(text: str) -> str:
    return re.sub(r"\D", "", str(text).translate(_OCR_DIGIT_MAP))


def _ocr_read(image_path: str) -> str:
    try:
        img = PILImage.open(image_path).convert("L")
        w, h = img.size
        longest = max(w, h)
        if longest and longest < 1600:
            scale = 1600.0 / longest
            img = img.resize((int(w * scale), int(h * scale)))
        try:
            from PIL import ImageOps
            img = ImageOps.autocontrast(img)
        except Exception:
            pass
    except Exception:
        img = PILImage.open(image_path)

    text = pytesseract.image_to_string(img)
    try:
        digits = pytesseract.image_to_string(img, config="--psm 6 -c tessedit_char_whitelist=0123456789")
    except Exception:
        digits = ""
    return text + "\n" + digits


def _id_match_score(ocr_text: str, id_number: str):
    target = re.sub(r"\D", "", str(id_number))
    if len(target) < 5:
        return 0.0, False
    stream = _digit_stream(ocr_text)
    if not stream:
        return 0.0, False
    if target in stream:
        return 0.95, True
    L = len(target)
    best = 0.0
    for i in range(0, len(stream) - L + 1):
        window = stream[i:i + L]
        matches = sum(1 for a, b in zip(window, target) if a == b)
        ratio = matches / L
        if ratio > best:
            best = ratio
    return best, False


def _process_semantic(image_path: str, students: list, id_hint: str) -> dict:
    # Tier 1 — exact ID hint
    if id_hint:
        clean_hint = id_hint.replace("-", "").strip()
        for s in students:
            if clean_hint == str(s["id_number"]).replace("-", "").strip():
                return {
                    "matched_student_id": s["id"],
                    "confidence_score": 100,
                    "breakdown": f"The ID number {id_hint} is an exact match to this student's record.",
                }

    if not os.path.exists(image_path):
        return {"matched_student_id": None, "confidence_score": 0, "breakdown": "Image not found for semantic analysis."}

    # Tier 2 — Tesseract OCR, confusion-tolerant digit matching
    if TESSERACT_AVAILABLE:
        try:
            ocr_text = _ocr_read(image_path)
            best = {"score": 0.0, "id": None, "field": None, "value": None, "exact": False}
            for s in students:
                id_score, id_exact = _id_match_score(ocr_text, s["id_number"])
                name_score = _semantic_similarity(ocr_text, s["name"])
                if id_score >= name_score:
                    cand_score, field, value, exact = id_score, "student number", s["id_number"], id_exact
                else:
                    cand_score, field, value, exact = name_score, "name", s["name"], name_score >= 0.95
                if cand_score > best["score"]:
                    best = {"score": cand_score, "id": s["id"], "field": field, "value": value, "exact": exact}

            CONFIDENT_FLOOR = 0.80
            if best["exact"] or best["score"] >= CONFIDENT_FLOOR:
                pct = int(best["score"] * 100)
                return {
                    "matched_student_id": best["id"],
                    "confidence_score": pct,
                    "breakdown": f"OCR read the {best['field']} '{best['value']}' from the presented document "
                                 f"({pct}% confidence match to this student's record).",
                }
        except Exception:
            pass  # fall through to Gemini

    # Tier 3 — Gemini Vision fallback
    if GEMINI_AVAILABLE and GEMINI_CLIENT is not None:
        try:
            img_pil = PILImage.open(image_path)
            prompt = (
                "Analyze this image of an identity document presented as proof of ownership. "
                "1. VISUAL CHECK: Does this look like a legitimate identity document? "
                "2. SEMANTIC CHECK: If yes, extract the exact full Name and ID/Document Number printed on it. "
                'Return ONLY raw JSON: {"is_valid_id_card": true/false, "extracted_id_number": "...", "extracted_name": "..."}'
            )
            response = GEMINI_CLIENT.models.generate_content(model=GEMINI_MODEL, contents=[prompt, img_pil])
            result_text = response.text.strip()
            if result_text.startswith("```json"):
                result_text = result_text[7:-3].strip()
            elif result_text.startswith("```"):
                result_text = result_text[3:-3].strip()

            import json as _json
            ai_data = _json.loads(result_text)

            if not ai_data.get("is_valid_id_card"):
                return {"matched_student_id": None, "confidence_score": 15,
                        "breakdown": "Gemini: image does not appear to be a valid identity document."}

            extracted_id = str(ai_data.get("extracted_id_number", "")).strip()
            if extracted_id:
                for s in students:
                    if extracted_id.replace("-", "") == str(s["id_number"]).replace("-", ""):
                        return {"matched_student_id": s["id"], "confidence_score": 95,
                                "breakdown": f"Gemini extracted ID {extracted_id}, matching this student's record."}

            extracted_name = str(ai_data.get("extracted_name", "")).strip()
            if extracted_name:
                best_score, best_id, best_name = 0.0, None, None
                for s in students:
                    score = _semantic_similarity(extracted_name, s["name"])
                    if score > best_score:
                        best_score, best_id, best_name = score, s["id"], s["name"]
                if best_score >= 0.80:
                    return {"matched_student_id": best_id, "confidence_score": int(best_score * 100),
                            "breakdown": f"Gemini-extracted name is a {int(best_score * 100)}% match to {best_name}'s record."}
        except Exception as e:
            return {"matched_student_id": None, "confidence_score": 0, "breakdown": f"Gemini tier error: {e}"}

    return {"matched_student_id": None, "confidence_score": 0, "breakdown": "All three tiers exhausted. No match found."}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {
        "status": "ok",
        "tesseract": TESSERACT_AVAILABLE,
        "gemini": GEMINI_AVAILABLE,
        "clip": CLIP_AVAILABLE,
        "rembg": REMBG_SESSION is not None,
    }


@app.post("/precompute")
def precompute(req: PrecomputeRequest):
    return _precompute_descriptors(req.image_path)


@app.post("/match")
def match(req: MatchRequest):
    import json as _json
    with open(req.batch_json, "r") as f:
        database_items = _json.load(f)
    return _process_batch(req.target_img, database_items)


@app.post("/semantic")
def semantic(req: SemanticRequest):
    students = [s.model_dump() for s in req.students]
    return _process_semantic(req.image_path, students, req.id_hint or "")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
