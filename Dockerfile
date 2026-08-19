# FEU-COMPASS AI Engine — Hugging Face Spaces (Docker SDK)
FROM python:3.11-slim

# System deps: tesseract-ocr (pytesseract is just a wrapper around the real
# binary — it does nothing without this), plus the shared libs OpenCV needs
# that aren't in the slim base image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Spaces' Docker SDK expects the app to listen on 7860 by default.
ENV PORT=7860
EXPOSE 7860

CMD ["uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "7860"]
