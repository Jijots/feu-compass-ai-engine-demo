"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8001";

type MatchResult = {
  item_id: number;
  confidence_score: number;
  breakdown: string;
  filename: string;
};

type MatchResponse = {
  error: boolean;
  message?: string;
  matches?: MatchResult[];
};

type HealthResponse = {
  status: string;
  tesseract: boolean;
  gemini: boolean;
  clip: boolean;
  rembg: boolean;
};

function scoreColors(score: number) {
  if (score >= 85) return { stripe: "#22c55e", badgeBg: "#dcfce7", badgeFg: "#15803d", badgeBorder: "#bbf7d0" };
  if (score >= 50) return { stripe: "#f59e0b", badgeBg: "#fef9c3", badgeFg: "#92400e", badgeBorder: "#fef08a" };
  return { stripe: "#ef4444", badgeBg: "#fee2e2", badgeFg: "#b91c1c", badgeBorder: "#fecaca" };
}

function UploadDropzone({
  label,
  hint,
  multiple,
  onFiles,
  previews,
}: {
  label: string;
  hint: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  previews: string[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  function handleFiles(fileList: FileList | null) {
    if (!fileList) return;
    onFiles(Array.from(fileList));
  }

  return (
    <div>
      <label className={styles.fieldLabel}>{label}</label>
      <div
        className={`${styles.dropzone} ${dragActive ? styles.dropzoneActive : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        {previews.length > 0 ? (
          previews.length === 1 ? (
            <img src={previews[0]} alt="preview" className={styles.previewImg} />
          ) : (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", marginBottom: 8 }}>
              {previews.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={i}
                  src={src}
                  alt="preview"
                  style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 8, border: "1px solid #e2e8f0" }}
                />
              ))}
            </div>
          )
        ) : (
          <div className={styles.dropzoneIcon}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}
        <p className={styles.dropzoneText}>
          {previews.length > 0 ? "Click to change" : `Select ${multiple ? "photo(s)" : "a photo"}`}
        </p>
        <p className={styles.dropzoneHint}>{hint}</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple={multiple}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
    </div>
  );
}

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);

  const [targetFile, setTargetFile] = useState<File | null>(null);
  const [targetPreview, setTargetPreview] = useState<string | null>(null);
  const [candidateFiles, setCandidateFiles] = useState<File[]>([]);
  const [candidatePreviews, setCandidatePreviews] = useState<string[]>([]);

  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<MatchResult[] | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((r) => r.json())
      .then((data: HealthResponse) => setHealth(data))
      .catch(() => setHealthError(true));
  }, []);

  function handleTargetFiles(files: File[]) {
    const file = files[0] ?? null;
    setTargetFile(file);
    setTargetPreview(file ? URL.createObjectURL(file) : null);
  }

  function handleCandidateFiles(files: File[]) {
    setCandidateFiles(files);
    setCandidatePreviews(files.map((f) => URL.createObjectURL(f)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!targetFile || candidateFiles.length === 0) {
      setErrorMsg("Pick a target photo and at least one candidate photo.");
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setResults(null);

    const formData = new FormData();
    formData.append("target", targetFile);
    candidateFiles.forEach((f) => formData.append("candidates", f));

    try {
      const resp = await fetch(`${API_BASE}/match-upload`, { method: "POST", body: formData });
      const data: MatchResponse = await resp.json();
      if (data.error) {
        setErrorMsg(data.message ?? "Matching failed.");
      } else {
        setResults(data.matches ?? []);
      }
    } catch {
      setErrorMsg(`Couldn't reach the AI engine at ${API_BASE}. Is the FastAPI server running?`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.header}>
          <p className={styles.overline}>Lost &amp; Found · AI Engine Demo</p>
          <h1 className={styles.title}>Smart Match Finder</h1>
          <p className={styles.subtitle}>
            Standalone demo of the FEU-COMPASS visual matching engine — SIFT/RootSIFT keypoint matching, RANSAC
            geometric verification, and a CLIP semantic fallback for featureless objects.
          </p>

          {healthError && (
            <div className={`${styles.healthBadge} ${styles.healthDown}`}>
              <span className={styles.dot} />
              API unreachable — start the backend with <code>uvicorn app.server:app --port 8001</code>
            </div>
          )}
          {health && (
            <div className={`${styles.healthBadge} ${styles.healthUp}`}>
              <span className={styles.dot} />
              API online — tesseract {health.tesseract ? "✓" : "✕"} · clip {health.clip ? "✓" : "✕"} · gemini{" "}
              {health.gemini ? "✓" : "✕"} · rembg {health.rembg ? "✓" : "✕"}
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.formGrid}>
            <UploadDropzone
              label="Target Photo (the item being searched for)"
              hint="JPG or PNG"
              onFiles={handleTargetFiles}
              previews={targetPreview ? [targetPreview] : []}
            />
            <UploadDropzone
              label="Candidate Photos (the registry to search)"
              hint="Select multiple"
              multiple
              onFiles={handleCandidateFiles}
              previews={candidatePreviews}
            />
          </div>

          <button type="submit" disabled={loading} className={styles.submitBtn}>
            {loading ? "Scanning registry…" : "Run Smart Match"}
          </button>

          {errorMsg && <p className={styles.error}>{errorMsg}</p>}
        </form>

        {/* Score explanation panel — styled after the real matches.blade.php panel */}
        <div className={styles.scorePanel}>
          <button type="button" className={styles.scorePanelHeader} onClick={() => setPanelOpen((o) => !o)}>
            <div className={styles.scorePanelTitle}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--feu-gold, #fecb02)" strokeWidth="2">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                />
              </svg>
              <span className={styles.scorePanelBadge}>How the Confidence Score Works</span>
            </div>
            <svg
              className={`${styles.chevron} ${panelOpen ? styles.chevronOpen : ""}`}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {panelOpen && (
            <div className={styles.scorePanelBody}>
              <div className={styles.scoreStep}>
                <p className={styles.scoreStepLabel}>Step 1 — Visual Feature Extraction</p>
                <p className={styles.scoreStepBody}>
                  SIFT extracts hundreds of keypoints from both images — corners, edges, textures — then converts
                  them to RootSIFT for a meaningfully better match under the Hellinger kernel.
                </p>
              </div>
              <div className={styles.scoreStep}>
                <p className={styles.scoreStepLabel}>Step 2 — FLANN + RANSAC</p>
                <p className={styles.scoreStepBody}>
                  FLANN matches keypoints between the two images; RANSAC/USAC_MAGSAC then verifies the matches
                  actually form a consistent geometric transform, not just coincidental local matches.
                </p>
              </div>
              <div className={styles.scoreStep}>
                <p className={styles.scoreStepLabel}>Step 3 — CLIP Semantic Fallback</p>
                <p className={styles.scoreStepBody}>
                  For smooth, low-texture objects SIFT can&apos;t get a grip on, CLIP embeddings and cosine
                  similarity take over, capturing meaning beyond pixels.
                </p>
              </div>
              <div className={styles.scoreLegend}>
                <span className={styles.legendPill} style={{ background: "#dcfce7", color: "#15803d" }}>
                  85–100% Very High
                </span>
                <span className={styles.legendPill} style={{ background: "#fef9c3", color: "#92400e" }}>
                  50–84% Moderate
                </span>
                <span className={styles.legendPill} style={{ background: "#fee2e2", color: "#b91c1c" }}>
                  Below 50% Low
                </span>
              </div>
            </div>
          )}
        </div>

        {results && (
          <div>
            <h2 className={styles.resultsHeading}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fecb02" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Top Suggested Matches
            </h2>

            {results.length === 0 ? (
              <div className={styles.emptyState}>No candidates scored above the confidence threshold.</div>
            ) : (
              <ul className={styles.resultList}>
                {results.map((m, i) => {
                  const c = scoreColors(m.confidence_score);
                  return (
                    <li key={m.item_id} className={styles.resultCard}>
                      <div className={styles.resultStripe} style={{ background: c.stripe }} />
                      <div className={styles.resultTop}>
                        <span className={styles.rankBadge}>#{i + 1}</span>
                        <span
                          className={styles.scoreBadge}
                          style={{ background: c.badgeBg, color: c.badgeFg, borderColor: c.badgeBorder }}
                        >
                          {m.confidence_score}% Match
                        </span>
                        <span className={styles.filenameLabel}>{m.filename}</span>
                      </div>
                      <div className={styles.insightBox}>
                        <p className={styles.insightLabel}>System Insight</p>
                        <p className={styles.insightText}>&quot;{m.breakdown}&quot;</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
