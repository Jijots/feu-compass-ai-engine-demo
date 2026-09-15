# FEU-COMPASS AI Engine, container image for Render (Docker runtime).
FROM python:3.11-slim

# System deps: tesseract-ocr (pytesseract is just a wrapper around the real
# binary, and it does nothing without this), the shared libs OpenCV needs that
# aren't in the slim base image, and curl to fetch the model weights.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    libgl1 \
    libglib2.0-0 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# requirements-deploy.txt, not requirements.txt: the deploy set runs CLIP and
# u2netp on ONNX Runtime instead of torch and the rembg package, neither of
# which fits in 512MB. See the comments in that file.
COPY requirements-deploy.txt .
RUN pip install --no-cache-dir -r requirements-deploy.txt

# Model weights live in a GitHub release rather than in git history. The release
# notes record how each was produced and how they were validated. Checksums are
# verified so a truncated or swapped download fails the build instead of quietly
# degrading match quality at runtime.
ARG MODELS_TAG=models-v1
ARG MODELS_BASE=https://github.com/Jijots/feu-compass-ai-engine-demo/releases/download
RUN mkdir -p /app/models \
 && curl -fsSL --retry 3 -o /app/models/clip_vision_int8.onnx \
      "${MODELS_BASE}/${MODELS_TAG}/clip_vision_int8.onnx" \
 && curl -fsSL --retry 3 -o /app/models/u2netp.onnx \
      "${MODELS_BASE}/${MODELS_TAG}/u2netp.onnx" \
 && printf '%s  %s\n' \
      3fac9a5ed29bff7eb59bd14bef1d48afec01294c341c6e8e69a97adddfc3466c /app/models/clip_vision_int8.onnx \
      309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8 /app/models/u2netp.onnx \
    | sha256sum -c -

COPY app/ ./app/

# Render injects PORT at runtime; 10000 is its default and the local fallback.
ENV PORT=10000
ENV MODEL_DIR=/app/models
EXPOSE 10000

CMD ["sh", "-c", "exec uvicorn app.server:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1"]
