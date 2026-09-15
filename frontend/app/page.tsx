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

/* ── Icons. One drawn set, 1.5 stroke throughout. ───────────────── */

type IconProps = { size?: number; className?: string };

const svgBase = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function IconCheck({ size = 13, className }: IconProps) {
  return (
    <svg {...svgBase} width={size} height={size} className={className} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" strokeWidth={2.5} />
    </svg>
  );
}

function IconOff({ size = 13, className }: IconProps) {
  return (
    <svg {...svgBase} width={size} height={size} className={className} aria-hidden="true">
      <path d="M5 12h14" strokeWidth={2.5} />
    </svg>
  );
}

function IconImage({ size = 30, className }: IconProps) {
  return (
    <svg {...svgBase} width={size} height={size} className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m3.5 16.5 4.2-4.2a2 2 0 0 1 2.8 0l3 3M14 15l1.7-1.7a2 2 0 0 1 2.8 0l2 2" />
    </svg>
  );
}

function IconStack({ size = 30, className }: IconProps) {
  return (
    <svg {...svgBase} width={size} height={size} className={className} aria-hidden="true">
      <rect x="7" y="3" width="14" height="13" rx="2.5" />
      <path d="M17 19.5A2.5 2.5 0 0 1 14.5 22H6a3 3 0 0 1-3-3V8.5A2.5 2.5 0 0 1 5.5 6" />
    </svg>
  );
}

function IconSearch({ size = 15, className }: IconProps) {
  return (
    <svg {...svgBase} width={size} height={size} className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="7" strokeWidth={2} />
      <path d="m20 20-3.6-3.6" strokeWidth={2} />
    </svg>
  );
}

function IconEmpty({ size = 34, className }: IconProps) {
  return (
    <svg {...svgBase} width={size} height={size} className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6M8.5 11h5" />
    </svg>
  );
}

/* ── Reveal. Default state is visible; motion is only armed once JS
      confirms the visitor has not asked for reduced motion. ─────── */

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [state, setState] = useState<"idle" | "armed" | "in">("idle");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    setState("armed");
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setState("in");
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);

    // Armed stages sit at opacity 0 until they intersect. If the observer
    // never fires (bfcache restore, a browser that throttles it, a stage
    // that never quite clears the threshold) that content would be gone for
    // good, so an entrance effect is never allowed to outlive this timer.
    const failsafe = window.setTimeout(() => {
      setState("in");
      io.disconnect();
    }, 2500);

    return () => {
      io.disconnect();
      window.clearTimeout(failsafe);
    };
  }, []);

  const cls =
    state === "armed" ? styles.revealArmed : state === "in" ? styles.revealIn : styles.reveal;
  return { ref, cls };
}

/* A looping animation nobody can see is wasted battery, so the scan runs
   only while its card is on screen and the tab is in front. */
function useMotionActive<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);

  useEffect(() => {
    const onVis = () => setTabVisible(!document.hidden);
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setOnScreen(entry.isIntersecting),
      { threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return { ref, active: onScreen && tabVisible };
}

/* The five stages, in the words the engine room uses, shortened to scan. */
const SCAN_STEPS = [
  "Levelling scale and exposure",
  "Cutting the subject from its background",
  "Reading keypoints, building descriptors",
  "Matching, then verifying the geometry",
  "Falling back to meaning when geometry is thin",
];

function PipelineScanner() {
  const { ref, active } = useMotionActive<HTMLElement>();
  const listRef = useRef<HTMLUListElement>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = performance.now();
    const id = window.setInterval(
      () => setElapsed(Math.floor((performance.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, []);

  // The beam travels the real height of the list, so it stays in step with
  // the rows at any breakpoint instead of against a hardcoded distance.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () =>
      el.style.setProperty("--beam-travel", `${Math.round(el.getBoundingClientRect().height)}px`);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <section
      ref={ref}
      className={`${styles.scanner} ${styles.scanning} ${active ? "" : styles.scanPaused}`}
      data-motion="essential"
      role="status"
    >
      {/* One stable sentence for screen readers. The looping rows below are
          decorative and would otherwise be announced over and over. */}
      <p className={styles.srOnly}>
        Scoring the registry. This usually takes six to fifteen seconds.
      </p>

      <div aria-hidden="true">
        <div className={styles.scannerHead}>
          <h2 className={styles.scannerTitle}>Working through the pipeline</h2>
          <span className={styles.scannerElapsed} data-numeric="">
            {elapsed}s elapsed
          </span>
        </div>

        <div className={styles.scanTrack}>
          <span className={styles.scanBeam} />
          <ul ref={listRef} className={styles.scanList}>
            {SCAN_STEPS.map((label, i) => (
              <li key={label} className={styles.scanRow}>
                <span className={styles.scanIndex}>{String(i + 1).padStart(2, "0")}</span>
                <span className={styles.scanLabel}>{label}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className={styles.scannerFoot}>
          These are the stages the engine runs, not a live progress report. The
          server does not report which one it is on, so this loops rather than
          pretending to know.
        </p>

        {elapsed >= 20 && (
          <p className={styles.scannerWake}>
            Still going. The engine sleeps after 15 minutes idle and takes about a
            minute to wake, so a first request can run long.
          </p>
        )}
      </div>
    </section>
  );
}

/* ── Stage diagrams. Each one draws the mechanism it describes. ─── */

const GOLD = "#fecb02";
const LINE = "rgba(255,255,255,0.22)";
const DIM = "rgba(255,255,255,0.5)";

function DiagNormalise() {
  return (
    <svg className={styles.diagramSvg} viewBox="0 0 260 128" role="img" aria-label="Two differently sized, differently exposed frames being reduced to a common size and contrast">
      <rect x="6" y="14" width="74" height="56" rx="4" fill="rgba(255,255,255,0.05)" stroke={LINE} />
      <rect x="14" y="78" width="46" height="34" rx="4" fill="rgba(255,255,255,0.14)" stroke={LINE} />
      <path d="M96 64h28" stroke={GOLD} strokeWidth="1.5" strokeDasharray="3 3" />
      <path d="m120 60 5 4-5 4" stroke={GOLD} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="140" y="20" width="52" height="40" rx="4" fill="rgba(255,255,255,0.09)" stroke={GOLD} strokeWidth="1.2" />
      <rect x="140" y="70" width="52" height="40" rx="4" fill="rgba(255,255,255,0.09)" stroke={GOLD} strokeWidth="1.2" />
      <text x="166" y="14" fill={DIM} fontSize="7.5" fontFamily="ui-monospace, monospace" textAnchor="middle">800px cap</text>
      <path d="M206 104c10 0 6-52 30-52" stroke={GOLD} strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M206 104h48M206 104V52" stroke={LINE} strokeWidth="1" />
      <text x="230" y="120" fill={DIM} fontSize="7.5" fontFamily="ui-monospace, monospace" textAnchor="middle">CLAHE</text>
    </svg>
  );
}

function DiagIsolate() {
  const blob = "M44 96c-16-4-26-18-24-36 2-17 14-30 30-32 18-3 34 8 38 25 4 18-5 36-21 42-8 3-15 3-23 1Z";
  return (
    <svg className={styles.diagramSvg} viewBox="0 0 260 128" role="img" aria-label="An item outlined and lifted away from a cluttered background">
      <rect x="6" y="10" width="112" height="108" rx="6" fill="rgba(255,255,255,0.04)" stroke={LINE} />
      {[
        [16, 22], [98, 30], [26, 108], [104, 100], [88, 16], [14, 64], [108, 62],
      ].map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="3" fill="rgba(255,255,255,0.16)" />
      ))}
      <path d={blob} transform="translate(12,0)" fill="rgba(255,255,255,0.1)" stroke={LINE} />
      <path d="M134 64h26" stroke={GOLD} strokeWidth="1.5" strokeDasharray="3 3" />
      <path d="m156 60 5 4-5 4" stroke={GOLD} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path
        className={styles.traced}
        style={{ ["--trace-len" as string]: "340" }}
        d={blob}
        transform="translate(130,0)"
        fill="rgba(254,203,2,0.09)"
        stroke={GOLD}
        strokeWidth="1.8"
        strokeDasharray="340"
      />
      <text x="188" y="122" fill={DIM} fontSize="7.5" fontFamily="ui-monospace, monospace" textAnchor="middle">alpha matte</text>
    </svg>
  );
}

function DiagFingerprint() {
  const pts: Array<[number, number, number]> = [
    [70, 34, -35], [96, 52, 20], [58, 62, 70], [86, 86, -15],
    [110, 74, 45], [64, 96, -60], [120, 44, 10], [98, 108, 30],
  ];
  return (
    <svg className={styles.diagramSvg} viewBox="0 0 260 128" role="img" aria-label="Keypoints marked across an item, each with a scale and orientation">
      <path
        d="M56 100c-14-6-20-22-15-38 5-15 20-26 36-26 19 0 35 14 37 32 2 17-9 33-25 38-11 3-22 2-33-6Z"
        fill="rgba(255,255,255,0.05)"
        stroke={LINE}
      />
      {pts.map(([x, y, a], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="6.5" fill="none" stroke={GOLD} strokeWidth="1.1" opacity="0.75" />
          <line
            x1={x}
            y1={y}
            x2={x + Math.cos((a * Math.PI) / 180) * 11}
            y2={y + Math.sin((a * Math.PI) / 180) * 11}
            stroke={GOLD}
            strokeWidth="1.1"
            strokeLinecap="round"
          />
          <circle cx={x} cy={y} r="1.4" fill={GOLD} />
        </g>
      ))}
      <path d="M168 26v76M168 26h4M168 102h4" stroke={LINE} strokeWidth="1" />
      <text x="180" y="42" fill={DIM} fontSize="7.5" fontFamily="ui-monospace, monospace">128-dim</text>
      <text x="180" y="56" fill={DIM} fontSize="7.5" fontFamily="ui-monospace, monospace">descriptor</text>
      <text x="180" y="78" fill={GOLD} fontSize="7.5" fontFamily="ui-monospace, monospace">L1 norm</text>
      <text x="180" y="92" fill={GOLD} fontSize="7.5" fontFamily="ui-monospace, monospace">then sqrt</text>
    </svg>
  );
}

function DiagCorroborate() {
  const left: Array<[number, number]> = [[40, 30], [26, 58], [50, 74], [34, 100], [58, 46]];
  const right: Array<[number, number]> = [[200, 38], [186, 66], [210, 82], [194, 108], [218, 54]];
  return (
    <svg className={styles.diagramSvg} viewBox="0 0 260 128" role="img" aria-label="Candidate point matches between two images, with geometrically consistent ones kept and coincidental ones discarded">
      <rect x="10" y="14" width="76" height="102" rx="5" fill="rgba(255,255,255,0.04)" stroke={LINE} />
      <rect x="172" y="14" width="76" height="102" rx="5" fill="rgba(255,255,255,0.04)" stroke={LINE} />
      {[0, 1, 2, 3].map((i) => (
        <line
          key={`in-${i}`}
          className={styles.traced}
          style={{ ["--trace-len" as string]: "200" }}
          x1={left[i][0]}
          y1={left[i][1]}
          x2={right[i][0]}
          y2={right[i][1]}
          stroke={GOLD}
          strokeWidth="1.3"
          strokeDasharray="200"
        />
      ))}
      <line x1={left[4][0]} y1={left[4][1]} x2={right[3][0]} y2={right[3][1]} stroke="rgba(255,255,255,0.2)" strokeWidth="1" strokeDasharray="3 3" />
      <line x1={left[2][0]} y1={left[2][1]} x2={right[4][0]} y2={right[4][1]} stroke="rgba(255,255,255,0.2)" strokeWidth="1" strokeDasharray="3 3" />
      {left.map(([cx, cy], i) => (
        <circle key={`l${i}`} cx={cx} cy={cy} r="2.6" fill={i === 4 ? "rgba(255,255,255,0.35)" : GOLD} />
      ))}
      {right.map(([cx, cy], i) => (
        <circle key={`r${i}`} cx={cx} cy={cy} r="2.6" fill={i === 4 ? "rgba(255,255,255,0.35)" : GOLD} />
      ))}
      <text x="129" y="122" fill={DIM} fontSize="7.5" fontFamily="ui-monospace, monospace" textAnchor="middle">inliers kept</text>
    </svg>
  );
}

function DiagMeaning() {
  return (
    <svg className={styles.diagramSvg} viewBox="0 0 260 128" role="img" aria-label="Two featureless items embedded as vectors, compared by the angle between them">
      <rect x="10" y="22" width="58" height="42" rx="12" fill="rgba(255,255,255,0.1)" stroke={LINE} />
      <rect x="10" y="74" width="58" height="42" rx="12" fill="rgba(255,255,255,0.1)" stroke={LINE} />
      <text x="39" y="16" fill={DIM} fontSize="7.5" fontFamily="ui-monospace, monospace" textAnchor="middle">no keypoints</text>
      <path d="M80 68h22" stroke={GOLD} strokeWidth="1.5" strokeDasharray="3 3" />
      <path d="m98 64 5 4-5 4" stroke={GOLD} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M124 112V28M124 112h108" stroke={LINE} strokeWidth="1.2" />
      <line className={styles.traced} style={{ ["--trace-len" as string]: "120" }} x1="124" y1="112" x2="222" y2="46" stroke={GOLD} strokeWidth="1.8" strokeDasharray="120" />
      <line className={styles.traced} style={{ ["--trace-len" as string]: "120" }} x1="124" y1="112" x2="214" y2="62" stroke={GOLD} strokeWidth="1.8" strokeDasharray="120" opacity="0.65" />
      <path d="M170 85a52 52 0 0 0 5-12" stroke={GOLD} strokeWidth="1.1" fill="none" />
      <text x="196" y="106" fill={GOLD} fontSize="8.5" fontFamily="ui-monospace, monospace">cos θ</text>
      <text x="238" y="34" fill={DIM} fontSize="7.5" fontFamily="ui-monospace, monospace" textAnchor="end">512-dim</text>
    </svg>
  );
}

type Stage = {
  num: string;
  role: string;
  name: string;
  analogy: React.ReactNode;
  specs: Array<[string, React.ReactNode]>;
  diagram: React.ReactNode;
  caption: string;
};

const STAGES: Stage[] = [
  {
    num: "01",
    role: "Prepare",
    name: "Put both photos on equal terms",
    analogy: (
      <>
        Before comparing two handwriting samples you photocopy both at the same size under the same
        lamp. <em>Whatever still differs afterwards is a real difference</em>, not a difference in the
        photography.
      </>
    ),
    specs: [
      ["Resize", <>Longest edge capped at <code>800px</code>, area-averaged.</>],
      ["Contrast", <>CLAHE over the grayscale copy, <code>clipLimit 4.0</code>, <code>8x8</code> tiles.</>],
      ["Effect", <>A shot taken in a dim corridor and one under office fluorescents present comparable texture.</>],
    ],
    diagram: <DiagNormalise />,
    caption: "unequal input, common footing",
  },
  {
    num: "02",
    role: "Isolate",
    name: "Cut the item out of its background",
    analogy: (
      <>
        Take scissors to the photo and keep only the item. <em>The desk it was sitting on is not
        evidence.</em> Two photos of the same bottle on different tables should not be punished for
        the tables.
      </>
    ),
    specs: [
      ["Matte", <>u2netp, 4.6 MB, run directly on ONNX Runtime.</>],
      ["Cleanup", <>Threshold at <code>128</code>, then morphological close x2 and open x1 with a 5x5 ellipse.</>],
      ["Fallback", <>A mask covering under <code>3%</code> of the frame is rejected. GrabCut takes over with a 10% inset rectangle over 3 iterations; failing that, the frame is scored unmasked.</>],
    ],
    diagram: <DiagIsolate />,
    caption: "subject lifted from clutter",
  },
  {
    num: "03",
    role: "Describe",
    name: "Take the item's fingerprint",
    analogy: (
      <>
        Not a photograph. A constellation. The engine records distinctive corners and textures and how
        they sit relative to one another, so <em>the pattern survives being rotated, resized or lit
        differently</em>.
      </>
    ),
    specs: [
      ["Detector", <>SIFT, up to <code>2500</code> keypoints per image.</>],
      ["Descriptor", <>RootSIFT: L1-normalise each descriptor, then take its square root.</>],
      ["Why", <>That turns ordinary Euclidean distance into the Hellinger kernel, which measurably improves matching and costs nothing at runtime.</>],
    ],
    diagram: <DiagFingerprint />,
    caption: "keypoints with scale and orientation",
  },
  {
    num: "04",
    role: "Verify",
    name: "Make the matches corroborate each other",
    analogy: (
      <>
        Two witnesses agreeing on details is weak, since anyone can share details by coincidence. Two
        witnesses agreeing on <em>where those details sit relative to one another</em> is a story.
        This stage discards the coincidences and keeps only matches that agree on one consistent
        geometry.
      </>
    ),
    specs: [
      ["Pairing", <>FLANN, KD-tree, <code>5</code> trees, <code>50</code> checks.</>],
      ["Filter", <>Lowe ratio test: keep a pair only when the best match is under <code>0.75x</code> the distance of the second best.</>],
      ["Geometry", <>With 10 or more survivors, USAC_MAGSAC fits a homography at <code>5.0px</code> reprojection tolerance.</>],
      ["Verdict", <>Inlier ratio at or above <code>0.50</code> with 8+ inliers scores 90. At <code>0.35</code>, 80. At <code>0.20</code> with 3+, it blends 65 against an 8x8x8 BGR histogram correlation, 60/40.</>],
    ],
    diagram: <DiagCorroborate />,
    caption: "geometry separates signal from coincidence",
  },
  {
    num: "05",
    role: "Only when 04 falls short",
    name: "Fall back to meaning",
    analogy: (
      <>
        A plain white earbud case has almost no fingerprint to read. There are barely any corners to
        record. So the question changes from <em>do these pixels line up</em> to <em>what is this a
        picture of</em>, and a different kind of model answers the second one.
      </>
    ),
    specs: [
      ["Trigger", <>Runs only when the classical score lands below <code>80</code>.</>],
      ["Model", <>CLIP ViT-B/32 vision tower, int8 ONNX, 97 MB, producing a 512-dimensional embedding.</>],
      ["Verdict", <>Cosine at or above <code>0.90</code> scores 90. At <code>0.82</code>, 82. At <code>0.75</code>, 76. Below that, cosine x 70.</>],
    ],
    diagram: <DiagMeaning />,
    caption: "similarity as an angle, not an overlap",
  },
];

const COSTS: Array<{ fig: string; unit: string; key: string; note: string }> = [
  {
    fig: "554",
    unit: "MB",
    key: "torch wheel",
    note: "What the PyTorch build wanted on Linux, before its seven CUDA dependencies.",
  },
  {
    fig: "24",
    unit: "MB",
    key: "onnx runtime",
    note: "What replaced it. Both models run on this instead.",
  },
  {
    fig: "252",
    unit: "MB",
    key: "peak resident",
    note: "Whole process, both models loaded, SIFT running, against a 512 MB ceiling.",
  },
  {
    fig: "0.9915",
    unit: "",
    key: "cosine agreement",
    note: "Mean agreement between the int8 CLIP and the fp32 original, over 45 image pairs.",
  },
];

/* ── Upload control ─────────────────────────────────────────────── */

function UploadDropzone({
  label,
  hint,
  dropHint,
  multiple,
  onFiles,
  previews,
  icon,
}: {
  label: string;
  hint: string;
  dropHint: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  previews: string[];
  icon: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  function handleFiles(fileList: FileList | null) {
    if (!fileList) return;
    onFiles(Array.from(fileList));
  }

  return (
    <div>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldHint}>{hint}</span>
      <div
        className={`${styles.dropzone} ${dragActive ? styles.dropzoneActive : ""}`}
        role="button"
        tabIndex={0}
        aria-label={label}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
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
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previews[0]} alt="Selected item" className={styles.previewImg} />
          ) : (
            <div className={styles.thumbRow}>
              {previews.map((src, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={src} alt={`Candidate ${i + 1}`} className={styles.thumb} />
              ))}
            </div>
          )
        ) : (
          <span className={styles.dropzoneIcon}>{icon}</span>
        )}
        <p className={styles.dropzoneText}>
          {previews.length === 0
            ? `Drop ${multiple ? "photos" : "a photo"} or click to browse`
            : multiple
              ? `${previews.length} selected. Click to replace`
              : "Click to replace"}
        </p>
        <p className={styles.dropzoneHint}>{dropHint}</p>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple={multiple}
          tabIndex={-1}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>
    </div>
  );
}

function tierOf(score: number) {
  if (score >= 85) return { label: "Very high", color: "#0d7a42" };
  if (score >= 50) return { label: "Moderate", color: "#9a6207" };
  return { label: "Low", color: "#a4161a" };
}

function StageRow({ stage }: { stage: Stage }) {
  const { ref, cls } = useReveal<HTMLElement>();
  return (
    <article ref={ref} className={`${styles.stage} ${cls}`}>
      <p className={styles.stageNum} data-numeric="">
        {stage.num}
      </p>
      <div className={styles.stageBody}>
        <span className={styles.stageRole}>{stage.role}</span>
        <h3 className={styles.stageName}>{stage.name}</h3>
        <p className={styles.analogy}>{stage.analogy}</p>
        <dl className={styles.specList}>
          {stage.specs.map(([k, v]) => (
            <div key={k} className={styles.specRow}>
              <dt className={styles.specKey}>{k}</dt>
              <dd className={styles.specVal}>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <figure className={styles.stageDiagram}>
        {stage.diagram}
        <figcaption className={styles.diagramCaption}>{stage.caption}</figcaption>
      </figure>
    </article>
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
  const [tabVisible, setTabVisible] = useState(true);

  useEffect(() => {
    const onVis = () => setTabVisible(!document.hidden);
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

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
      setErrorMsg("Add one photo of the lost item and at least one candidate before running a match.");
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
        setErrorMsg(data.message ?? "The engine could not score these images. Try different photos.");
      } else {
        setResults(data.matches ?? []);
      }
    } catch {
      setErrorMsg(
        "Could not reach the engine. It sleeps after 15 minutes idle and takes about a minute to wake, so try once more.",
      );
    } finally {
      setLoading(false);
    }
  }

  const caps = health
    ? ([
        ["Tesseract", health.tesseract],
        ["CLIP", health.clip],
        ["rembg", health.rembg],
        ["Gemini", health.gemini],
      ] as Array<[string, boolean]>)
    : [];

  return (
    <div className={`${styles.page} ${tabVisible ? "" : styles.scanPaused}`}>
      <header className={styles.shell}>
        <div className={styles.hero}>
          <h1 className={styles.title}>
            Find the one that is <span className={styles.titleAccent}>yours</span>.
          </h1>
          <p className={styles.lede}>
            The visual matching engine from <strong>FEU-COMPASS</strong>, a lost-and-found system
            built for two offices at FEU Manila, lifted out of the main application
            and put online on its own. Give it a photo of what you lost and a handful of candidates,
            and it will rank them. Everything here runs live on a 512 MB box.
          </p>

          {healthError && (
            <div className={styles.status}>
              <span className={`${styles.statusLead} ${styles.statusDown}`}>
                <span className={styles.pulse} />
                Engine unreachable
              </span>
              <span className={styles.divider} />
              <span className={styles.statusHint}>
                It may be waking from sleep. Reload in a minute, or run it locally with{" "}
                <code>uvicorn app.server:app --port 8001</code>
              </span>
            </div>
          )}

          {health && (
            <div className={styles.status}>
              <span className={`${styles.statusLead} ${styles.statusOk}`}>
                <span className={styles.pulse} />
                Engine online
              </span>
              <span className={styles.divider} />
              <div className={styles.capList}>
                {caps.map(([name, on]) => (
                  <span key={name} className={`${styles.cap} ${on ? styles.capOn : ""}`}>
                    {on ? (
                      <IconCheck className={styles.capIcon} />
                    ) : (
                      <IconOff className={styles.capIcon} />
                    )}
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </header>

      <main className={styles.shell}>
        <section className={styles.matcher} aria-labelledby="run-a-match">
          <div className={styles.matcherHead}>
            <h2 id="run-a-match" className={styles.matcherTitle}>
              Run a match
            </h2>
            <p className={styles.matcherNote}>Images are scored in memory and never retained.</p>
          </div>

          <form onSubmit={handleSubmit}>
            <div className={styles.formGrid}>
              <UploadDropzone
                label="The lost item"
                hint="One photo of the thing being searched for."
                dropHint="JPG or PNG"
                icon={<IconImage />}
                onFiles={handleTargetFiles}
                previews={targetPreview ? [targetPreview] : []}
              />
              <UploadDropzone
                label="The registry"
                hint="Every candidate to score against it."
                dropHint="Select as many as you like"
                multiple
                icon={<IconStack />}
                onFiles={handleCandidateFiles}
                previews={candidatePreviews}
              />
            </div>

            <button type="submit" disabled={loading} className={styles.submitBtn}>
              <span className={styles.btnInner}>
                {loading ? (
                  <>
                    <span className={styles.spinner} data-motion="essential" aria-hidden="true" />
                    Scoring the registry
                  </>
                ) : (
                  <>
                    <IconSearch />
                    Run the match
                  </>
                )}
              </span>
            </button>

            {errorMsg && (
              <p className={styles.error} role="alert">
                {errorMsg}
              </p>
            )}
          </form>
        </section>

        {loading && <PipelineScanner />}

        {results && (
          <section className={styles.results} aria-live="polite">
            <div className={styles.resultsHead}>
              <h2 className={styles.resultsTitle}>Ranked candidates</h2>
              {results.length > 0 && (
                <span className={styles.resultsCount} data-numeric="">
                  {results.length} above threshold
                </span>
              )}
            </div>

            {results.length === 0 && (
              <div className={styles.emptyState}>
                <IconEmpty />
                <p className={styles.emptyTitle}>Nothing cleared the bar</p>
                <p className={styles.emptyBody}>
                  No candidate scored high enough to be worth showing. That is the engine declining to
                  guess, which is the behaviour you want from a lost-and-found desk.
                </p>
              </div>
            )}

            {results.length > 0 && (
              <ul className={styles.resultList}>
                {results.map((m, i) => {
                  const tier = tierOf(m.confidence_score);
                  return (
                    <li
                      key={m.item_id}
                      className={styles.resultCard}
                      style={{ animationDelay: `${i * 70}ms` }}
                    >
                      <div className={styles.scoreBlock} style={{ color: tier.color }}>
                        <span>
                          <span className={styles.scoreNum} data-numeric="">
                            {m.confidence_score}
                          </span>
                          <span className={styles.scorePct}>%</span>
                        </span>
                        <span className={styles.scoreTier}>{tier.label}</span>
                      </div>
                      <div className={styles.resultBody}>
                        <div className={styles.resultMeta}>
                          <span className={styles.rankChip} data-numeric="">
                            RANK {i + 1}
                          </span>
                          <span className={styles.filename}>{m.filename}</span>
                        </div>
                        <p className={styles.insightText}>{m.breakdown}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </main>

      {/* ── Engine room ─────────────────────────────────────────── */}
      <section className={styles.ink} data-register="ink" aria-labelledby="how-it-decides">
        <div className={styles.shell}>
          <div className={styles.inkHead}>
            <h2 id="how-it-decides" className={styles.inkTitle}>
              How it actually decides
            </h2>
            <p className={styles.inkLede}>
              Five stages, each one running only because the one before it did, and the last one only
              when the fourth falls short. The specification on the left is what the code does. The
              analogy beside it is there so the specification means something.
            </p>
          </div>

          <div className={styles.stageList}>
            {STAGES.map((s) => (
              <StageRow key={s.num} stage={s} />
            ))}
          </div>

          <div className={styles.cost}>
            <h3 className={styles.costTitle}>What it costs to run</h3>
            <p className={styles.costLede}>
              The hosting tier caps memory at 512 MB. The PyTorch build does not fit inside that, and
              neither does the rembg package, so rather than drop CLIP and background removal both now
              run as pre-exported ONNX models. Nothing was removed from the engine to make it fit.
            </p>

            <div className={styles.costGrid}>
              {COSTS.map((c) => (
                <div key={c.key} className={styles.costCell}>
                  <span className={styles.costFig} data-numeric="">
                    {c.fig}
                    {c.unit && <span className={styles.costUnit}> {c.unit}</span>}
                  </span>
                  <p className={styles.costKey}>{c.key}</p>
                  <p className={styles.costNote}>{c.note}</p>
                </div>
              ))}
            </div>

            <p className={styles.footnote}>
              One finding worth the trip: ONNX Runtime&apos;s CPU arena allocator grew resident memory
              past 590 MB during u2netp inference alone, which is enough to kill the instance.
              Disabling it with <code>enable_cpu_mem_arena = False</code> dropped the whole-process
              peak from 863 MB to 252 MB, with no measurable cost to latency.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
