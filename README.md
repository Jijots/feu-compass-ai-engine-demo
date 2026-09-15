# FEU-COMPASS AI Engine — Demo

A standalone extraction of the visual + semantic matching engine from
**FEU-COMPASS**, a Laravel-based campus lost-and-found and student-conduct
system built for FEU Manila's Office of Student Discipline
and Guidance Counseling Office.

In production this microservice runs alongside a Laravel front end that
handles authentication (Microsoft Azure AD), SharePoint sync, and the
registry database. **None of that is needed to run this repo** — the AI
engine itself is a plain FastAPI service that reads image paths off disk and
returns match scores. This exists so the matching logic can be demoed and
reviewed on its own, independent of the larger system (and of whatever's
currently paid for or not on the Azure side).

## What it actually does

Two matching problems, two pipelines:

### 1. Visual item matching (`POST /match`)

Given a photo of a lost item and a batch of candidate "found" item photos,
score how likely each candidate is the same physical object.

- **Subject isolation** — `rembg` (U2-Net) or OpenCV GrabCut as a fallback,
  so background clutter doesn't get compared along with the item itself
- **SIFT → RootSIFT** — keypoint detection with CLAHE contrast enhancement
  first (handles inconsistent phone-camera lighting), then converts raw SIFT
  descriptors to RootSIFT (L1-normalize + sqrt) for a meaningfully better
  match under the Hellinger kernel
- **FLANN matching + Lowe's ratio test** — filters keypoint matches down to
  confident ones
- **RANSAC / USAC_MAGSAC geometric verification** — confirms the matched
  keypoints actually form a consistent geometric transform, not just a pile
  of coincidental local matches
- **Colour histogram comparison** — a secondary signal, weighted in when
  keypoint matching is inconclusive
- **CLIP embedding fallback** — for smooth, low-texture objects (a plain
  water bottle, a blank notebook) where SIFT can't find enough keypoints to
  work with at all, cosine similarity between CLIP embeddings takes over

### 2. Identity document matching (`POST /semantic`)

Given a photo of an ID/COR/other document presented as proof of ownership, a
3-tier cascade decides who it belongs to:

1. **Tier 1 — exact match**: if an ID number was already captured at
   intake, check it directly, no image processing needed
2. **Tier 2 — Tesseract OCR**: reads the document, with a confusion-tolerant
   digit comparison (`O`→`0`, `I`/`l`→`1`, etc. — the character
   substitutions Tesseract commonly makes on phone photos of ID cards) so a
   slightly misread character doesn't fail the match outright
3. **Tier 3 — Gemini Vision**: if OCR can't confidently read the document
   (bad lighting, glare, an unfamiliar document format), falls back to
   asking Gemini to extract the name/ID number directly from the image

Each tier only runs if the one before it didn't produce a confident result,
keeping the common case fast and cheap, and only reaching for a paid API
call when the deterministic and local-OCR paths genuinely can't resolve it.

## Running it

```bash
pip install -r requirements.txt
cp .env.example .env      # optional — add GOOGLE_API_KEY to enable Tier 3
uvicorn app.server:app --reload --port 8001
```

The visual matcher and Tiers 1-2 of the semantic matcher work with **zero
API keys** — pure OpenCV and Tesseract. Gemini is only needed for the Tier 3
fallback.

Then, in another terminal, either the CLI demo:

```bash
python demo/run_demo.py --target demo/sample_images/lost.jpg \
    --candidates demo/sample_images/found_1.jpg demo/sample_images/found_2.jpg
```

(`demo/sample_images/` is empty in this repo — drop in your own item photos
to try it against something real. Any two photos of the same object from
different angles, plus a couple of decoys, work well for seeing the scoring
in action.)

...or the web UI:

```bash
cd frontend
npm install
npm run dev
```

Then open `http://localhost:3000` (or whatever port it prints — it'll pick
the next free one if 3000 is taken), upload a target photo and one or more
candidate photos through the file pickers, and it calls the backend directly
from the browser. Built with **React + TypeScript + Next.js** (App Router).
The frontend talks to `http://127.0.0.1:8001` by default; see
`frontend/.env.local.example` if you're running the backend somewhere else.

## Live demo

| | |
|---|---|
| Web UI | https://feu-compass-ai-demo.vercel.app |
| API | https://feu-compass-ai-engine-z8ve.onrender.com |

Hosted on free tiers, so the first request after 15 minutes of inactivity
wakes the container and takes about a minute to answer. Uploaded images are
scored in memory and not retained.

The hosted instance runs a reduced build. See "Hosting constraints" below.

## API reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness check, reports which optional features (Tesseract/Gemini/CLIP/rembg) are actually available |
| `/match` | POST | Score a target image against a batch of candidates (server-side file paths), returns top 5 by confidence |
| `/match-upload` | POST | Same as `/match`, but takes real multipart file uploads — what the web UI calls |
| `/precompute` | POST | Pre-compute and cache SIFT/CLIP descriptors for an image ahead of time |
| `/semantic` | POST | 3-tier identity match for a presented document against a list of known students |

## Hosting constraints

The public demo runs on a 512MB instance. The PyTorch build does not fit inside
that: the Linux torch wheel is 554MB before its seven CUDA dependencies, and
CLIP ViT-B/32 in fp32 is a further 605MB of weights. The rembg package is a
smaller version of the same problem, pulling scipy, scikit-image, pymatting and
pooch, roughly 100MB of dependencies, to drive one 4.6MB model.

Rather than drop those features, the deployed build runs both on ONNX Runtime,
a 24MB wheel, against pre-exported models fetched at image build time from the
repo's `models-v1` release:

| | |
|---|---|
| CLIP ViT-B/32 vision tower, int8 | 97MB |
| u2netp | 4.6MB |
| Whole process, both models loaded, SIFT running | ~250MB peak |

The vision tower is exported from the same `open_clip` openai weights the torch
path used, so the embedding space is unchanged, and the unused text tower is
dropped. Agreement with the fp32 original is 0.9915 mean cosine, with no flips
across the 0.90 threshold the CLIP fallback uses. The u2netp masks are
pixel-identical to `rembg.remove(..., only_mask=True)`.

Two details worth knowing if you reproduce this. ONNX Runtime's CPU arena
allocator has to be disabled; with it on, u2netp inference alone grew RSS past
590MB and would OOM the instance. And only `MatMul` nodes are quantised, since
dynamic quantisation turns the patch-embedding `Conv` into a `ConvInteger` that
the CPU provider has no kernel for.

`requirements.txt` remains the original torch-based set for local use, and
`/health` reports exactly which optional features are live on any given
instance, so the demo never claims a capability it is not running.

## What's deliberately not in this repo

- The Laravel application (registry CRUD, user management, Microsoft Graph/
  SharePoint sync, Azure AD OAuth) — this repo is the AI engine only
- Real student data or item photos — `demo/sample_images/` ships empty
- Production deployment config — the original service runs on Azure App
  Service; this demo runs anywhere `pip install` works
