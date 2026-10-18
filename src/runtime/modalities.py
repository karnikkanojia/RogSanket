"""Local auxiliary models. All assets require reference-parity manifests."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile


def artifact(variable, model):
    root = Path(os.environ.get(variable, "__missing__")).resolve()
    manifest = json.loads((root / "epicast-artifact.json").read_text())
    if manifest.get("base_model") != model or not manifest.get("reference_parity_passed") or not manifest.get("revision"):
        raise RuntimeError(f"{model}: pinned reference parity is required")
    checksums = manifest.get("sha256", {})
    if not checksums:
        raise RuntimeError("Modality artifact checksums are required")
    required = {str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()
                and path.suffix in {".onnx", ".safetensors", ".json", ".model", ".txt", ".jinja"}
                and path.name != "epicast-artifact.json"}
    if not required.issubset(checksums):
        raise RuntimeError("Checksums must cover all modality model and processor files")
    for name, expected in checksums.items():
        path = (root / name).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Artifact path escapes root")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError(f"Checksum mismatch: {name}")
    return root, manifest


def provenance(manifest, backend):
    return {"model": manifest["base_model"], "revision": manifest["revision"],
            "backend": backend, "location": "local"}


def transcribe(request):
    root, manifest = artifact("EPICAST_MEDASR_ARTIFACT", "google/medasr")
    import torch
    import librosa
    import soundfile as sf
    from transformers import AutoModelForCTC, AutoProcessor, pipeline
    audio, rate = sf.read(io.BytesIO(base64.b64decode(request["audio_base64"], validate=True)))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if len(audio) / rate > 300:
        raise ValueError("Audio exceeds five minutes")
    if rate != 16000:
        audio = librosa.resample(audio, orig_sr=rate, target_sr=16000)
    # MPS is enabled only after this exact artifact passes its operator/quality gate.
    device = "mps" if manifest.get("mps_parity_passed") and torch.backends.mps.is_available() else "cpu"
    model = AutoModelForCTC.from_pretrained(root, local_files_only=True).to(device).eval()
    processor = AutoProcessor.from_pretrained(root, local_files_only=True)
    asr = pipeline("automatic-speech-recognition", model=model, tokenizer=processor.tokenizer,
                   feature_extractor=processor.feature_extractor, device=device)
    with torch.inference_mode():
        result = asr({"raw": audio.astype("float32"), "sampling_rate": 16000}, chunk_length_s=20, stride_length_s=2)
    return {"transcription": result["text"], "duration_seconds": len(audio) / 16000,
            "requires_review": True, "provenance": provenance(manifest, f"pytorch-{device}")}


def classify_image(request):
    root, manifest = artifact("EPICAST_MEDSIGLIP_ARTIFACT", "google/medsiglip")
    import torch
    from transformers import AutoModel, AutoProcessor
    from PIL import Image
    from src.agents.image_triage_agent import ImageTriageAgent
    image = Image.open(io.BytesIO(base64.b64decode(request["image_base64"], validate=True)))
    if image.width * image.height > 16_000_000:
        raise ValueError("Image exceeds 16 megapixels")
    device = "mps" if manifest.get("mps_parity_passed") and torch.backends.mps.is_available() else "cpu"
    model = AutoModel.from_pretrained(root, local_files_only=True).to(device).eval()
    processor = AutoProcessor.from_pretrained(root, local_files_only=True)
    agent = ImageTriageAgent(siglip_model=model, siglip_processor=processor)
    results = agent.classify_image(image.convert("RGB"))
    top = results[0] if results else {}
    return {"classifications": results, "top_pattern": top.get("pattern", "unknown"),
            "flagged": top.get("score", 0) > 0.3 and top.get("pattern") != "healthy_normal",
            "score_type": "cosine_similarity", "provenance": provenance(manifest, f"pytorch-{device}")}


def classify_cough(request):
    root, manifest = artifact("EPICAST_HEAR_ARTIFACT", "google/hear")
    # Only a known, reference-validated waveform export is accepted. No guessed mel preprocessing.
    if manifest.get("input") != "waveform_16khz_2s" or not manifest.get("classifier_training_provenance"):
        raise RuntimeError("HeAR requires verified waveform preprocessing and classifier training provenance")
    import numpy as np
    import soundfile as sf
    import librosa
    import onnxruntime as ort
    ort.disable_telemetry_events()
    audio, rate = sf.read(io.BytesIO(base64.b64decode(request["audio_base64"], validate=True)))
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if len(audio) / rate > 2.01:
        raise ValueError("Cough input must be at most two seconds")
    if rate != 16000:
        audio = librosa.resample(audio, orig_sr=rate, target_sr=16000)
    audio = np.pad(audio, (0, max(0, 32000 - len(audio))))[:32000].astype(np.float32)[None, :]
    # CPU is the reproducible baseline. Core ML requires its own validated export/profile.
    encoder = ort.InferenceSession(str(root / "hear.onnx"), providers=["CPUExecutionProvider"])
    embedding = encoder.run(None, {encoder.get_inputs()[0].name: audio})[0]
    classifier = ort.InferenceSession(str(root / "classifier.onnx"), providers=["CPUExecutionProvider"])
    expected = manifest.get("embedding_dimension")
    if embedding.ndim != 2 or embedding.shape[1] != expected:
        raise RuntimeError("HeAR embedding does not match classifier training contract")
    outputs = classifier.run(None, {classifier.get_inputs()[0].name: embedding})
    label = str(outputs[0][0])
    probabilities = outputs[1][0]
    if not isinstance(probabilities, dict):
        raise RuntimeError("Classifier must export labeled probability maps")
    return {"classification": manifest["labels"][label],
            "confidence": float(probabilities[int(label)]),
            "probabilities": {manifest["labels"][str(k)]: float(v) for k, v in probabilities.items()},
            "provenance": provenance(manifest, "onnxruntime-cpu")}
