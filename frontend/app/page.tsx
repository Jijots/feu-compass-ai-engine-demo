"use client";

import { useEffect, useState } from "react";
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

export default function Home() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);

  const [targetFile, setTargetFile] = useState<File | null>(null);
  const [candidateFiles, setCandidateFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<MatchResult[] | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/health`)
      .then((r) => r.json())
      .then((data: HealthResponse) => setHealth(data))
      .catch(() => setHealthError(true));
  }, []);

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
      const resp = await fetch(`${API_BASE}/match-upload`, {
        method: "POST",
        body: formData,
      });
      const data: MatchResponse = await resp.json();

      if (data.error) {
        setErrorMsg(data.message ?? "Matching failed.");
      } else {
        setResults(data.matches ?? []);
      }
    } catch {
      setErrorMsg(
        `Couldn't reach the AI engine at ${API_BASE}. Is the FastAPI server running?`
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.title}>FEU-COMPASS AI Engine</h1>
        <p className={styles.subtitle}>
          Visual lost-and-found item matching — SIFT/RootSIFT keypoint
          matching, RANSAC geometric verification, and a CLIP semantic
          fallback for featureless objects.
        </p>

        <div className={styles.healthBadge}>
          {healthError && (
            <span className={styles.badgeDown}>
              ● API unreachable — start the backend with{" "}
              <code>uvicorn app.server:app --port 8001</code>
            </span>
          )}
          {health && (
            <span className={styles.badgeUp}>
              ● API online — tesseract: {health.tesseract ? "on" : "off"} ·
              clip: {health.clip ? "on" : "off"} · gemini:{" "}
              {health.gemini ? "on" : "off"} · rembg:{" "}
              {health.rembg ? "on" : "off"}
            </span>
          )}
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          <label className={styles.field}>
            <span>Target photo (the &quot;lost&quot; item)</span>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setTargetFile(e.target.files?.[0] ?? null)}
            />
          </label>

          <label className={styles.field}>
            <span>Candidate photos (the &quot;found&quot; registry to search)</span>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) =>
                setCandidateFiles(Array.from(e.target.files ?? []))
              }
            />
          </label>

          <button type="submit" disabled={loading} className={styles.button}>
            {loading ? "Scoring…" : "Find Matches"}
          </button>
        </form>

        {errorMsg && <p className={styles.error}>{errorMsg}</p>}

        {results && (
          <div className={styles.results}>
            <h2>Results</h2>
            {results.length === 0 ? (
              <p>No candidates scored above the confidence threshold.</p>
            ) : (
              <ul className={styles.resultList}>
                {results.map((m) => (
                  <li key={m.item_id} className={styles.resultCard}>
                    <div className={styles.resultHeader}>
                      <span className={styles.filename}>{m.filename}</span>
                      <span
                        className={styles.score}
                        style={{
                          color:
                            m.confidence_score >= 80
                              ? "#1a7f37"
                              : m.confidence_score >= 65
                                ? "#9a6700"
                                : "#57606a",
                        }}
                      >
                        {m.confidence_score}%
                      </span>
                    </div>
                    <p className={styles.breakdown}>{m.breakdown}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
