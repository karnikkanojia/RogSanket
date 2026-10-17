#!/usr/bin/env python3
"""
EpiCast Local Server for Mac (18GB RAM)
Runs MedGemma 27B + HeAR locally on Apple Silicon.

Setup:
  1. pip install flask flask-cors onnxruntime numpy librosa joblib soundfile
  2. Download models:
     - MedGemma 27B GGUF:
       huggingface-cli download bartowski/google_medgemma-27b-it-GGUF --include "google_medgemma-27b-it-Q3_K_M.gguf" --local-dir ./models/medgemma-27b
     - HeAR ONNX:
       huggingface-cli download Janeodum/epicast-hear-mobile --local-dir ./models/hear
  3. Install llama.cpp:
     brew install llama.cpp
  4. Start llama.cpp server (in a separate terminal):
     llama-server -m ./models/medgemma-27b/google_medgemma-27b-it-Q3_K_M.gguf -c 4096 --host 0.0.0.0 --port 8081
  5. Run this server:
     python epicast_local_server.py

Your React Native app then points to http://<your-mac-ip>:5050 instead of RunPod.
"""

import os
import json
import logging
import numpy as np
from flask import Flask, request, jsonify
from flask_cors import CORS

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("epicast-local")

app = Flask(__name__)
CORS(app)

# ============================================================
# CONFIG
# ============================================================
MODELS_DIR = os.environ.get("MODELS_DIR", "./models")
HEAR_ONNX_PATH = os.path.join(MODELS_DIR, "hear", "hear_embedding.onnx")
HEAR_CLF_PATH = os.path.join(MODELS_DIR, "hear", "classifier.onnx")
LLAMA_SERVER_URL = os.environ.get("LLAMA_SERVER_URL", "http://localhost:8081")

LABEL_NAMES = {0: "healthy", 1: "symptomatic", 2: "COVID-19"}

# ============================================================
# LOAD HeAR ONNX + CLASSIFIER (both ONNX)
# ============================================================
hear_session = None
clf_session = None  # ONNX sklearn classifier

def load_hear():
    global hear_session, clf_session
    try:
        import onnxruntime as ort

        # Use CoreML on Mac for acceleration, fallback to CPU
        providers = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
        available = ort.get_available_providers()
        providers = [p for p in providers if p in available]
        if not providers:
            providers = ["CPUExecutionProvider"]

        log.info(f"Loading HeAR ONNX from {HEAR_ONNX_PATH}")
        log.info(f"ONNX providers: {providers}")
        hear_session = ort.InferenceSession(HEAR_ONNX_PATH, providers=providers)
        log.info("HeAR ONNX loaded")

        log.info(f"Loading classifier ONNX from {HEAR_CLF_PATH}")
        clf_session = ort.InferenceSession(HEAR_CLF_PATH, providers=["CPUExecutionProvider"])
        log.info("Classifier ONNX loaded")

    except FileNotFoundError as e:
        log.warning(f"HeAR models not found: {e}")
        log.warning("HeAR endpoint will return errors. Download models first.")
    except Exception as e:
        log.warning(f"Failed to load HeAR: {e}")


def audio_to_mel_spectrogram(audio_bytes):
    """Convert raw audio bytes to mel spectrogram matching HeAR's expected input.
    Supports WAV/FLAC via soundfile; falls back to librosa for M4A/MP3/AAC/etc."""
    import librosa
    import io
    import soundfile as sf

    # Try soundfile first (fast path: WAV, FLAC)
    try:
        audio_data, sr = sf.read(io.BytesIO(audio_bytes))
    except Exception:
        # Fallback: write to temp file and use librosa (handles M4A, MP3, AAC via Core Audio on Mac)
        import tempfile, os
        with tempfile.NamedTemporaryFile(suffix='.audio', delete=False) as f:
            f.write(audio_bytes)
            tmp_path = f.name
        try:
            audio_data, sr = librosa.load(tmp_path, sr=None, mono=True)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    # Convert to mono if stereo
    if len(audio_data.shape) > 1:
        audio_data = audio_data.mean(axis=1)

    # Resample to 16kHz
    if sr != 16000:
        audio_data = librosa.resample(audio_data, orig_sr=sr, target_sr=16000)
        sr = 16000

    # Pad or trim to 2 seconds (32000 samples)
    target_len = 32000
    if len(audio_data) < target_len:
        audio_data = np.pad(audio_data, (0, target_len - len(audio_data)))
    else:
        audio_data = audio_data[:target_len]

    # Compute mel spectrogram (matching HeAR's preprocessing)
    mel = librosa.feature.melspectrogram(
        y=audio_data.astype(np.float32),
        sr=sr,
        n_fft=1024,
        hop_length=160,       # 10ms hop
        win_length=400,       # 25ms window
        n_mels=128,
        fmin=60,
        fmax=7800,
    )

    # Log scale
    mel = np.log(mel + 1e-6)

    # Reshape to [1, 1, 128, time_steps] and trim/pad to 192 time steps
    target_time = 192
    if mel.shape[1] < target_time:
        mel = np.pad(mel, ((0, 0), (0, target_time - mel.shape[1])))
    else:
        mel = mel[:, :target_time]

    # HeAR ONNX expects [batch, channels, time, freq] = [1, 1, 192, 128]
    mel_tensor = mel.T[np.newaxis, np.newaxis, :, :].astype(np.float32)

    return mel_tensor


# ============================================================
# ROUTES
# ============================================================

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "hear_loaded": hear_session is not None,
        "classifier_loaded": clf_session is not None,
        "llama_server": LLAMA_SERVER_URL,
    })


@app.route("/v1/hear/classify", methods=["POST"])
def hear_classify():
    """
    Classify a cough audio recording.
    Accepts: multipart/form-data with 'audio' file
    Returns: {prediction, confidence, probabilities, embedding_dim}
    """
    if hear_session is None or clf_session is None:
        return jsonify({"error": "HeAR models not loaded"}), 503

    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    try:
        # Audio to mel spectrogram
        mel = audio_to_mel_spectrogram(audio_bytes)
        log.info(f"Mel spectrogram shape: {mel.shape}")

        # classifier.onnx expects 1024-dim = two 512-dim HeAR windows concatenated.
        # Run HeAR on first half (0-1s) and second half (1-2s) of the mel separately.
        input_name = hear_session.get_inputs()[0].name
        mel_a = np.pad(mel[:, :, :96, :], ((0,0),(0,0),(0,96),(0,0)))  # first second → [1,1,192,128]
        mel_b = np.pad(mel[:, :, 96:, :], ((0,0),(0,0),(0,96),(0,0)))  # second second → [1,1,192,128]
        emb_a = hear_session.run(None, {input_name: mel_a})[0]          # [1, 512]
        emb_b = hear_session.run(None, {input_name: mel_b})[0]          # [1, 512]
        embedding = np.concatenate([emb_a, emb_b], axis=1)              # [1, 1024]
        log.info(f"Embedding shape: {embedding.shape}")

        # Run ONNX classifier
        clf_input_name = clf_session.get_inputs()[0].name
        clf_outputs = clf_session.run(None, {clf_input_name: embedding.astype(np.float32)})
        # sklearn-to-onnx exports: output[0] = labels, output[1] = list of {class: prob} dicts
        prediction = int(clf_outputs[0][0])
        prob_map = clf_outputs[1][0] if len(clf_outputs) > 1 else {}
        if isinstance(prob_map, dict):
            probabilities = [prob_map.get(i, 0.0) for i in range(len(LABEL_NAMES))]
        else:
            probabilities = list(prob_map)

        return jsonify({
            "prediction": LABEL_NAMES.get(prediction, str(prediction)),
            "confidence": float(max(probabilities)),
            "probabilities": {
                LABEL_NAMES.get(i, str(i)): float(p)
                for i, p in enumerate(probabilities)
            },
            "embedding_dim": int(embedding.shape[1]),
        })

    except Exception as e:
        log.error(f"HeAR inference error: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


@app.route("/v1/hear/embed", methods=["POST"])
def hear_embed():
    """
    Get raw HeAR embedding (for storage in pgvector).
    Accepts: multipart/form-data with 'audio' file
    Returns: {embedding: [...], dim: 512}
    """
    if hear_session is None:
        return jsonify({"error": "HeAR model not loaded"}), 503

    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    try:
        mel = audio_to_mel_spectrogram(audio_bytes)
        input_name = hear_session.get_inputs()[0].name
        outputs = hear_session.run(None, {input_name: mel})

        embedding = outputs[0]
        if len(embedding.shape) == 3:
            embedding = embedding.reshape(embedding.shape[0], -1)
        embedding = embedding.reshape(-1)

        return jsonify({
            "embedding": embedding.tolist(),
            "dim": int(len(embedding)),
        })

    except Exception as e:
        log.error(f"HeAR embed error: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500


import threading, uuid as _uuid
_report_jobs = {}  # job_id -> {status, text?, tokens_used?, error?}

def _run_report_job(job_id, prompt, system_prompt, max_tokens):
    import urllib.request
    try:
        llama_payload = json.dumps({
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": 0.3,
            "stream": False,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{LLAMA_SERVER_URL}/v1/chat/completions",
            data=llama_payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=600) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        text = result["choices"][0]["message"]["content"]
        tokens = result.get("usage", {}).get("total_tokens", 0)
        _report_jobs[job_id] = {"status": "done", "text": text, "tokens_used": tokens}
    except Exception as e:
        log.error(f"Report job {job_id} failed: {e}", exc_info=True)
        _report_jobs[job_id] = {"status": "error", "error": str(e)}


@app.route("/v1/report/generate", methods=["POST"])
def generate_report():
    """
    Async report generation — returns job_id immediately.
    Poll /v1/report/status/<job_id> until status == 'done'.
    Accepts: JSON {prompt, system_prompt?, max_tokens?}
    Returns: {job_id, status: 'pending'}
    """
    data = request.json or {}
    prompt = data.get("prompt", "")
    system_prompt = data.get("system_prompt", "You are EpiCast, an epidemiological surveillance AI.")
    max_tokens = data.get("max_tokens", 128)

    if not prompt:
        return jsonify({"error": "No prompt provided"}), 400

    job_id = str(_uuid.uuid4())[:8]
    _report_jobs[job_id] = {"status": "pending"}
    threading.Thread(target=_run_report_job,
                     args=(job_id, prompt, system_prompt, max_tokens),
                     daemon=True).start()
    log.info(f"Report job {job_id} started")
    return jsonify({"job_id": job_id, "status": "pending"})


@app.route("/v1/report/status/<job_id>", methods=["GET"])
def report_status(job_id):
    """Poll for report job result."""
    job = _report_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)


# ============================================================
# MAIN
# ============================================================
if __name__ == "__main__":
    print("""
    ╔═══════════════════════════════════════════════╗
    ║       EpiCast Local Server for Mac            ║
    ╠═══════════════════════════════════════════════╣
    ║  HeAR (ONNX)  → :5050/v1/hear/classify       ║
    ║  HeAR embed   → :5050/v1/hear/embed           ║
    ║  MedGemma 27B → :5050/v1/report/generate      ║
    ║  Health check → :5050/health                  ║
    ╚═══════════════════════════════════════════════╝

    Make sure llama-server is running on port 8081:
      llama-server -m ./models/medgemma-27b.gguf -c 4096 --port 8081
    """)

    load_hear()

    app.run(host="0.0.0.0", port=5050, debug=False)
