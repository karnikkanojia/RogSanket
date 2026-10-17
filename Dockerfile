FROM runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04

WORKDIR /app

# System dependencies (audio processing, HeAR, image handling)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libsndfile1 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir --upgrade numpy
# Clone HeAR repo for audio preprocessing utilities
RUN git clone -q https://github.com/Google-Health/hear.git /app/hear

# Copy application code
COPY src/ ./src/
COPY handler.py .
COPY configs/ ./configs/

# Create models directory for HeAR sklearn classifier
# You must copy classifier.pkl here before building:
#   cp /path/to/classifier.pkl models/classifier.pkl
RUN mkdir -p /app/models
COPY models/classifier.pkl /app/models/classifier.pkl

# Environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app:/app/hear

# Model IDs (override via RunPod endpoint env vars if needed)
ENV EPICAST_LORA_PATH=Janeodum/epicast-multilang-lora
ENV MEDGEMMA_4B_ID=google/medgemma-4b-it
ENV MEDGEMMA_27B_ID=google/medgemma-27b-text-it
ENV HEAR_CLASSIFIER_PATH=/app/models/classifier.pkl

# HF_TOKEN must be set at runtime via RunPod endpoint env vars
# ENV HF_TOKEN=your_token_here

CMD ["python", "-u", "handler.py"]
