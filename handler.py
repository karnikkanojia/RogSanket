"""
EpiCast RunPod Serverless Handler (Full Model Stack)

Models loaded on cold start:
  1. MedGemma 4B + LoRA  — syndromic extraction from clinical narratives
  2. MedGemma 27B         — situation report generation
  3. HeAR (google/hear-pytorch) + sklearn classifier — cough audio analysis
  4. MedGemma 4B vision   — clinical photo triage (MedSigLIP-style)
  5. Multi-modal fusion   — combines text + cough + image signals

All models share one GPU (~23GB total at 4-bit quantization).
"""

import os

# Force HuggingFace cache to network volume (must be before any HF imports)
os.environ["HF_HOME"] = os.environ.get("HF_HOME", "/runpod-volume/huggingface")
os.environ["TRANSFORMERS_CACHE"] = os.environ.get("TRANSFORMERS_CACHE", "/runpod-volume/huggingface")
os.environ["HF_HUB_CACHE"] = os.environ.get("HF_HUB_CACHE", "/runpod-volume/huggingface")
os.makedirs(os.environ["HF_HOME"], exist_ok=True)

import json
import base64
import tempfile
import traceback
from datetime import datetime

import runpod

# ============================================================================
# Global model state (loaded once on cold start, reused across requests)
# ============================================================================
_models = {}


def load_models():
    """Load all models on cold start."""
    import torch

    # Login to HuggingFace first
    from huggingface_hub import login
    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if hf_token:
        login(token=hf_token)
        print(f"✓ HuggingFace login successful (token: ...{hf_token[-4:]})")
    else:
        print("✗ WARNING: No HF_TOKEN found in environment!")

    from src.models.medgemma_loader import load_medgemma_4b

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda":
        print(f"Device: {device} | VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f} GB")
    else:
        print("CPU mode")

    # ── 1. MedGemma 4B + LoRA (syndromic extraction + image triage) ──────
    print("[1/4] Loading MedGemma 4B + LoRA adapter...")
    lora_path = os.environ.get("EPICAST_LORA_PATH", "Janeodum/epicast-multilang-lora")
    model_4b_id = os.environ.get("MEDGEMMA_4B_ID", "google/medgemma-4b-it")

    model_4b, processor_4b = load_medgemma_4b(
        model_id=model_4b_id,
        quantize="4bit",
        lora_adapter_path=lora_path,
    )
    _models["model_4b"] = model_4b
    _models["processor_4b"] = processor_4b
    print(f"  ✓ MedGemma 4B loaded ({model_4b_id} + {lora_path})")

    # ── 2. MedGemma 27B (situation reports) ──────────────────────────────
    print("[2/4] Loading MedGemma 27B for report generation...")
    model_27b_id = os.environ.get("MEDGEMMA_27B_ID", "google/medgemma-27b-text-it")
    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )

        tokenizer_27b = AutoTokenizer.from_pretrained(model_27b_id)
        model_27b = AutoModelForCausalLM.from_pretrained(
            model_27b_id,
            quantization_config=bnb_config,
            device_map="auto",
            torch_dtype=torch.bfloat16,
        )
        _models["model_27b"] = model_27b
        _models["tokenizer_27b"] = tokenizer_27b
        print(f"  ✓ MedGemma 27B loaded ({model_27b_id}, 4-bit)")
    except Exception as e:
        print(f"  ✗ MedGemma 27B failed to load: {e}")
        print("    → Reports will fall back to MedGemma 4B")
        _models["model_27b"] = None
        _models["tokenizer_27b"] = None

    # ── 3. HeAR model + sklearn classifier (cough analysis) ──────────────
    print("[3/4] Loading HeAR cough analysis pipeline...")
    try:
        from transformers import AutoModel, AutoFeatureExtractor

        # Use HuggingFace feature extractor — no git clone needed
        hear_feature_extractor = AutoFeatureExtractor.from_pretrained("google/hear-pytorch")
        _models["hear_feature_extractor"] = hear_feature_extractor

        # Load HeAR embedding model
        hear_model = AutoModel.from_pretrained("google/hear-pytorch")
        hear_model = hear_model.to(device)
        hear_model.eval()
        _models["hear_model"] = hear_model
        print(f"  ✓ HeAR embedding model loaded on {device}")

        # Load sklearn classifier trained on HeAR embeddings
        import pickle
        classifier_path = os.environ.get("HEAR_CLASSIFIER_PATH", "/app/models/classifier.pkl")
        if os.path.exists(classifier_path):
            with open(classifier_path, "rb") as f:
                _models["hear_classifier"] = pickle.load(f)
            print(f"  ✓ HeAR sklearn classifier loaded from {classifier_path}")
        else:
            print(f"  ⚠ classifier.pkl not found at {classifier_path} — will use embedding-only mode")

    except Exception as e:
        print(f"  ✗ HeAR loading failed: {e}")
        print("    → Cough analysis will use energy-based fallback")
        _models["hear_model"] = None
        _models["hear_classifier"] = None
        _models["hear_feature_extractor"] = None

    # ── 4. Initialize agents ─────────────────────────────────────────────
    print("[4/4] Initializing EpiCast agents...")
    from src.agents.intake_agent import IntakeAgent
    from src.agents.surveillance_agent import SurveillanceAgent, SurveillanceDatabase
    from src.agents.alert_agent import AlertAgent
    from src.agents.image_triage_agent import ImageTriageAgent

    _models["database"] = SurveillanceDatabase()

    _models["intake_agent"] = IntakeAgent(
        model=model_4b,
        processor=processor_4b,
        use_medasr=False,
    )

    _models["image_agent"] = ImageTriageAgent(
        medgemma_model=model_4b,
        medgemma_processor=processor_4b,
    )

    _models["surveillance_agent"] = SurveillanceAgent(
        database=_models["database"],
        model_27b=_models.get("model_27b"),
        processor_27b=_models.get("tokenizer_27b"),
        model_4b=model_4b,
        processor_4b=processor_4b,
    )

    _models["alert_agent"] = AlertAgent(
        model=model_4b,
        processor=processor_4b,
    )

    vram_used = torch.cuda.memory_allocated() / 1e9 if device == "cuda" else 0
    print(f"\n{'='*60}")
    print(f"EpiCast fully initialized | VRAM used: {vram_used:.1f} GB")
    print(f"  Models: 4B={'✓' if _models.get('model_4b') else '✗'} | "
          f"27B={'✓' if _models.get('model_27b') else '✗'} | "
          f"HeAR={'✓' if _models.get('hear_model') else '✗'} | "
          f"HeAR-clf={'✓' if _models.get('hear_classifier') else '✗'}")
    print(f"{'='*60}\n")


# ============================================================================
# Request Handlers
# ============================================================================

def handle_health(input_data):
    """Health check — shows which models are loaded."""
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "models": {
            "medgemma_4b": _models.get("model_4b") is not None,
            "medgemma_27b": _models.get("model_27b") is not None,
            "hear_embedding": _models.get("hear_model") is not None,
            "hear_classifier": _models.get("hear_classifier") is not None,
            "image_triage": _models.get("image_agent") is not None,
        },
        "agents": {
            "intake": _models.get("intake_agent") is not None,
            "surveillance": _models.get("surveillance_agent") is not None,
            "alert": _models.get("alert_agent") is not None,
        },
    }


# ── Text-based syndromic extraction ──────────────────────────────────────

def handle_extract(input_data):
    """Extract syndromic signal from narrative text (no encounter storage)."""
    agent = _models.get("intake_agent")
    if not agent:
        return {"error": "Intake agent not initialized"}

    narrative = input_data.get("narrative", "")
    if not narrative:
        return {"error": "No narrative provided"}

    signal = agent.extract_syndromic_signal(narrative)
    if signal:
        return signal.model_dump()
    return {"error": "Extraction failed — no syndromic signal detected"}


def handle_encounter(input_data):
    """Full encounter: extract + store in surveillance database."""
    agent = _models.get("intake_agent")
    if not agent:
        return {"error": "Intake agent not initialized"}

    narrative = input_data.get("narrative", "")
    district = input_data.get("district")
    facility_name = input_data.get("facility_name")
    latitude = input_data.get("latitude")
    longitude = input_data.get("longitude")

    encounter = agent.process_encounter(
        narrative=narrative,
        location_lat=latitude,
        location_lon=longitude,
        district=district,
        facility_name=facility_name,
    )

    _models["database"].add_encounter(encounter)

    signal_data = None
    if encounter.syndromic_signal:
        signal_data = encounter.syndromic_signal.model_dump()

    return {
        "encounter_id": encounter.encounter_id,
        "timestamp": encounter.timestamp.isoformat(),
        "syndromic_signal": signal_data,
        "total_encounters": _models["database"].total_encounters,
    }


# ── Cough analysis with real HeAR embeddings ─────────────────────────────

def handle_cough(input_data):
    """
    Analyze cough audio using Google HeAR embeddings + trained classifier.

    Pipeline: audio → resample 16kHz → HeAR preprocessing → HeAR embeddings (512-d) → sklearn classifier

    Accepts: { "audio_base64": "...", "format": "wav" }
    Returns: { "classification": "healthy"|"symptomatic"|"COVID-19", "confidence": 0.78, ... }
    """
    import numpy as np

    audio_b64 = input_data.get("audio_base64", "")
    audio_format = input_data.get("format", "wav")

    if not audio_b64:
        return {"error": "No audio data provided. Send base64-encoded audio in 'audio_base64'."}

    try:
        import librosa
        import torch

        # Decode audio to temp file
        with tempfile.NamedTemporaryFile(suffix=f".{audio_format}", delete=False) as f:
            f.write(base64.b64decode(audio_b64))
            tmp_path = f.name

        # Load and resample to 16kHz mono (HeAR requirement)
        audio, sr = librosa.load(tmp_path, sr=16000, mono=True)
        duration = librosa.get_duration(y=audio, sr=sr)
        os.unlink(tmp_path)

        hear_model = _models.get("hear_model")
        hear_classifier = _models.get("hear_classifier")
        hear_feature_extractor = _models.get("hear_feature_extractor")

        def _hear_embed(audio_array, sr):
            """Run audio through HeAR feature extractor + model → numpy embedding."""
            device = next(hear_model.parameters()).device
            inputs = hear_feature_extractor(
                audio_array.tolist(), sampling_rate=sr, return_tensors="pt", padding=True
            )
            inputs = {k: v.to(device) for k, v in inputs.items()}
            with torch.no_grad():
                output = hear_model(**inputs, return_dict=True)
                embedding = output.last_hidden_state.mean(dim=1)
            return embedding.cpu().numpy()

        # ── Path A: Full HeAR pipeline ────────────────────────────────
        if hear_model is not None and hear_classifier is not None and hear_feature_extractor is not None:
            embedding_np = _hear_embed(audio, sr)

            # Classify with trained sklearn model
            prediction = hear_classifier.predict(embedding_np)[0]
            probabilities = hear_classifier.predict_proba(embedding_np)[0].tolist()
            labels = hear_classifier.classes_.tolist()

            # Generate mel spectrogram for visualization
            spectrogram_b64 = _generate_spectrogram_image(audio, sr)

            return {
                "classification": prediction,
                "confidence": round(max(probabilities), 3),
                "probabilities": dict(zip(labels, probabilities)),
                "duration_seconds": round(duration, 1),
                "spectrogram_base64": spectrogram_b64,
                "model": "HeAR-v1+sklearn",
                "embedding_dim": int(embedding_np.shape[1]),
            }

        # ── Path B: HeAR embeddings only (no classifier) ─────────────
        elif hear_model is not None and hear_feature_extractor is not None:
            embedding_np = _hear_embed(audio, sr)

            # Simple heuristic on embedding norm (rough proxy)
            emb_norm = float(np.linalg.norm(embedding_np))
            classification = "symptomatic" if emb_norm > 15.0 else "healthy"

            spectrogram_b64 = _generate_spectrogram_image(audio, sr)

            return {
                "classification": classification,
                "confidence": 0.55,  # low confidence without classifier
                "duration_seconds": round(duration, 1),
                "spectrogram_base64": spectrogram_b64,
                "model": "HeAR-v1-embedding-only",
                "embedding_dim": int(embedding_np.shape[1]),
                "note": "No trained classifier loaded — using embedding heuristic",
            }

        # ── Path C: Energy-based fallback ─────────────────────────────
        else:
            rms = float(np.sqrt(np.mean(audio ** 2)))
            zcr = float(np.mean(librosa.feature.zero_crossing_rate(y=audio)))
            classification = "cough_detected" if rms > 0.05 else "healthy"
            confidence = min(0.6 + rms * 4, 0.95) if rms > 0.05 else 0.7

            spectrogram_b64 = _generate_spectrogram_image(audio, sr)

            return {
                "classification": classification,
                "confidence": round(confidence, 2),
                "duration_seconds": round(duration, 1),
                "spectrogram_base64": spectrogram_b64,
                "model": "energy-fallback",
                "note": "HeAR model not available — using energy-based detection",
            }

    except Exception as e:
        return {"error": f"Cough analysis failed: {str(e)}", "traceback": traceback.format_exc()}


def _generate_spectrogram_image(audio, sr):
    """Generate a mel spectrogram image as base64 PNG for mobile display."""
    try:
        import numpy as np
        import librosa
        import librosa.display
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import io

        fig, ax = plt.subplots(1, 1, figsize=(4, 2), dpi=100)
        S = librosa.feature.melspectrogram(y=audio, sr=sr, n_mels=128, fmax=8000)
        S_dB = librosa.power_to_db(S, ref=np.max)
        librosa.display.specshow(S_dB, sr=sr, x_axis="time", y_axis="mel",
                                  ax=ax, cmap="viridis")
        ax.set_title("Cough Spectrogram", fontsize=8)
        ax.set_xlabel("")
        ax.set_ylabel("")
        plt.tight_layout()

        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", transparent=False)
        plt.close(fig)
        buf.seek(0)
        return base64.b64encode(buf.read()).decode("utf-8")
    except Exception:
        return None


# ── Clinical photo triage (MedSigLIP-style via MedGemma vision) ──────────

def handle_image_triage(input_data):
    """
    Classify clinical photos using MedGemma 4B's vision capabilities.

    MedGemma 4B is built on PaliGemma2 with SigLIP vision encoder, making it
    effectively a MedSigLIP classifier when used with medical image prompts.

    Accepts: { "image_base64": "...", "clinical_context": "optional narrative" }
    Returns: { "classification": "maculopapular_rash", "confidence": 0.85, ... }
    """
    image_agent = _models.get("image_agent")
    model = _models.get("model_4b")
    processor = _models.get("processor_4b")

    if not model or not processor:
        return {"error": "MedGemma 4B not loaded — image triage unavailable"}

    image_b64 = input_data.get("image_base64", "")
    clinical_context = input_data.get("clinical_context", "")

    if not image_b64:
        return {"error": "No image data provided. Send base64-encoded image in 'image_base64'."}

    try:
        import torch
        from PIL import Image
        import io

        # Decode image
        image_bytes = base64.b64decode(image_b64)
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        # Use the ImageTriageAgent if available
        if image_agent and hasattr(image_agent, "classify_image"):
            result = image_agent.classify_image(image)
            return result

        # Otherwise, direct MedGemma vision inference
        dermatological_categories = [
            "maculopapular_rash", "vesicular_rash", "petechial_rash",
            "jaundice", "conjunctivitis", "oral_lesions",
            "skin_ulcer", "edema", "normal_skin", "other"
        ]

        prompt = f"""You are a clinical image triage system for disease surveillance in West Africa.

Analyze this clinical photograph and classify it into ONE of these categories:
{json.dumps(dermatological_categories)}

{"Patient context: " + clinical_context if clinical_context else "No additional context provided."}

Respond ONLY with valid JSON:
{{"classification": "<category>", "confidence": <0.0-1.0>, "description": "<brief clinical description>", "syndromic_relevance": "<which WHO IDSR syndrome this could indicate, or 'none'>"}}"""

        messages = [
            {"role": "user", "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": prompt},
            ]}
        ]

        input_text = processor.apply_chat_template(messages, add_generation_prompt=True)
        inputs = processor(
            text=input_text,
            images=[image],
            return_tensors="pt",
        ).to(model.device)

        with torch.no_grad():
            output_ids = model.generate(
                **inputs,
                max_new_tokens=256,
                do_sample=False,
                temperature=1.0,
            )

        new_tokens = output_ids[0][inputs["input_ids"].shape[1]:]
        response_text = processor.decode(new_tokens, skip_special_tokens=True).strip()

        try:
            json_start = response_text.find("{")
            json_end = response_text.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                result = json.loads(response_text[json_start:json_end])
                result["model"] = "MedGemma-4B-vision"
                result["source"] = "MedSigLIP"
                return result
        except json.JSONDecodeError:
            pass

        return {
            "classification": "unknown",
            "confidence": 0.0,
            "raw_response": response_text,
            "model": "MedGemma-4B-vision",
            "source": "MedSigLIP",
            "note": "Could not parse structured output",
        }

    except Exception as e:
        return {"error": f"Image triage failed: {str(e)}", "traceback": traceback.format_exc()}


# ── Multi-modal fusion engine ─────────────────────────────────────────────

def handle_fuse(input_data):
    """
    Multi-modal confidence fusion: combines text + cough + image signals.

    Accepts: {
        "text_result":  { "syndrome_category": "...", "confidence_score": 0.89, "symptoms": [...] },
        "cough_result": { "classification": "symptomatic", "confidence": 0.78 },
        "image_result": { "classification": "normal_skin", "confidence": 0.92 }
    }

    Returns fused confidence score with agreement analysis.
    """
    text_result = input_data.get("text_result")
    cough_result = input_data.get("cough_result")
    image_result = input_data.get("image_result")

    WEIGHTS = {"text": 0.50, "cough": 0.30, "image": 0.20}

    COUGH_SYNDROME_MAP = {
        "symptomatic": ["acute_respiratory_infection", "acute_febrile_illness", "influenza_like_illness"],
        "COVID-19": ["acute_respiratory_infection", "acute_febrile_illness", "influenza_like_illness"],
        "healthy": [],
    }

    IMAGE_SYNDROME_MAP = {
        "maculopapular_rash": ["acute_rash_with_fever", "measles"],
        "vesicular_rash": ["acute_rash_with_fever", "monkeypox", "chickenpox"],
        "petechial_rash": ["acute_hemorrhagic_fever"],
        "jaundice": ["acute_jaundice_syndrome"],
        "conjunctivitis": ["acute_febrile_illness"],
        "oral_lesions": ["acute_rash_with_fever"],
        "skin_ulcer": ["other"],
        "edema": ["other"],
        "normal_skin": [],
    }

    signals = []
    fused_confidence = 0.0
    total_weight = 0.0
    text_syndrome = None

    if text_result:
        text_conf = text_result.get("confidence_score", 0.0)
        text_syndrome = text_result.get("syndrome_category", "unknown")
        fused_confidence += WEIGHTS["text"] * text_conf
        total_weight += WEIGHTS["text"]
        signals.append({
            "source": "MedGemma", "type": "text",
            "result": text_syndrome, "confidence": text_conf, "weight": WEIGHTS["text"],
        })

    if cough_result:
        cough_class = cough_result.get("classification", "healthy")
        cough_conf = cough_result.get("confidence", 0.0)
        fused_confidence += WEIGHTS["cough"] * cough_conf
        total_weight += WEIGHTS["cough"]
        signals.append({
            "source": "HeAR", "type": "cough",
            "result": cough_class, "confidence": cough_conf, "weight": WEIGHTS["cough"],
        })

    if image_result:
        image_class = image_result.get("classification", "normal_skin")
        image_conf = image_result.get("confidence", 0.0)
        fused_confidence += WEIGHTS["image"] * image_conf
        total_weight += WEIGHTS["image"]
        signals.append({
            "source": "MedSigLIP", "type": "image",
            "result": image_class, "confidence": image_conf, "weight": WEIGHTS["image"],
        })

    if total_weight > 0:
        fused_confidence /= total_weight

    agreement = "insufficient_data"
    agreement_details = []

    if text_syndrome and cough_result:
        cough_class = cough_result.get("classification", "healthy")
        compatible = COUGH_SYNDROME_MAP.get(cough_class, [])
        cough_agrees = text_syndrome.lower() in [s.lower() for s in compatible]
        agreement_details.append(f"cough({'agrees' if cough_agrees else 'neutral'})")

    if text_syndrome and image_result:
        image_class = image_result.get("classification", "normal_skin")
        compatible = IMAGE_SYNDROME_MAP.get(image_class, [])
        image_agrees = text_syndrome.lower() in [s.lower() for s in compatible]
        agreement_details.append(f"image({'agrees' if image_agrees else 'neutral'})")

    if len(signals) >= 2:
        agreeing = sum(1 for d in agreement_details if "agrees" in d)
        if agreeing == len(agreement_details) and agreeing > 0:
            agreement = "corroborated"
            fused_confidence = min(fused_confidence * 1.1, 1.0)
        elif agreeing == 0 and len(agreement_details) > 0:
            agreement = "uncorroborated"
            fused_confidence *= 0.9
        else:
            agreement = "partial"

    narrative = _generate_fusion_narrative(signals, agreement, text_syndrome, fused_confidence)

    return {
        "fused_confidence": round(fused_confidence, 3),
        "agreement": agreement,
        "agreement_details": agreement_details,
        "signals": signals,
        "narrative": narrative,
        "primary_syndrome": text_syndrome,
        "signal_count": len(signals),
    }


def _generate_fusion_narrative(signals, agreement, syndrome, confidence):
    """Generate a human-readable fusion summary."""
    parts = []
    for s in signals:
        parts.append(f"{s['source']} ({s['type']}): {s['result']} ({s['confidence']:.0%})")
    signal_summary = "; ".join(parts)

    if agreement == "corroborated":
        return f"All signals support {syndrome}. High confidence ({confidence:.0%}). {signal_summary}"
    elif agreement == "uncorroborated":
        return f"Signals do not strongly agree on {syndrome}. Moderate confidence ({confidence:.0%}). {signal_summary}"
    elif agreement == "partial":
        return f"Partial agreement on {syndrome}. Confidence: {confidence:.0%}. {signal_summary}"
    else:
        return f"Assessment based on available signals ({len(signals)} modalities). {signal_summary}"


# ── Full multi-modal encounter (text + cough + image in one call) ─────────

def handle_multimodal_encounter(input_data):
    """
    Process a complete multi-modal encounter in one call.

    Accepts: {
        "narrative": "Patient dey cough...",
        "audio_base64": "...",  (optional)
        "image_base64": "...",  (optional)
        "district": "Kano Municipal",
        "latitude": 12.0,
        "longitude": 8.5
    }

    Runs all available models, fuses results, stores encounter.
    """
    results = {}

    narrative = input_data.get("narrative", "")
    if narrative:
        text_result = handle_extract({"narrative": narrative})
        results["text"] = text_result
    else:
        results["text"] = {"error": "No narrative provided"}

    if input_data.get("audio_base64"):
        results["cough"] = handle_cough({
            "audio_base64": input_data["audio_base64"],
            "format": input_data.get("audio_format", "wav"),
        })
    else:
        results["cough"] = None

    if input_data.get("image_base64"):
        results["image"] = handle_image_triage({
            "image_base64": input_data["image_base64"],
            "clinical_context": narrative,
        })
    else:
        results["image"] = None

    fusion_input = {}
    if results["text"] and "error" not in results["text"]:
        fusion_input["text_result"] = results["text"]
    if results["cough"] and "error" not in results["cough"]:
        fusion_input["cough_result"] = results["cough"]
    if results["image"] and "error" not in results["image"]:
        fusion_input["image_result"] = results["image"]

    if fusion_input:
        results["fusion"] = handle_fuse(fusion_input)
    else:
        results["fusion"] = {"error": "No valid signals to fuse"}

    if results["text"] and "error" not in results["text"]:
        results["encounter"] = handle_encounter({
            "narrative": narrative,
            "district": input_data.get("district"),
            "facility_name": input_data.get("facility_name"),
            "latitude": input_data.get("latitude"),
            "longitude": input_data.get("longitude"),
        })

    return results


# ── Surveillance & alerts ─────────────────────────────────────────────────

def handle_surveillance_scan(input_data):
    """Run anomaly detection scan across districts."""
    agent = _models.get("surveillance_agent")
    if not agent:
        return {"error": "Surveillance agent not initialized"}

    district = input_data.get("district")
    districts = [district] if district else None
    alerts = agent.scan_for_anomalies(districts=districts)

    return {
        "alerts_count": len(alerts),
        "alerts": [a.model_dump() for a in alerts],
    }


def handle_alerts(input_data):
    """Get all active alerts with level breakdown."""
    agent = _models.get("surveillance_agent")
    if not agent:
        return {"error": "Surveillance agent not initialized"}

    alerts = agent.scan_for_anomalies()
    return {
        "total_alerts": len(alerts),
        "by_level": {
            "emergency": len([a for a in alerts if a.alert_level == "emergency"]),
            "warning": len([a for a in alerts if a.alert_level == "warning"]),
            "watch": len([a for a in alerts if a.alert_level == "watch"]),
        },
        "alerts": [a.model_dump() for a in alerts],
    }


# ── Situation report generation (MedGemma 27B) ───────────────────────────

def handle_report(input_data):
    """
    Generate a comprehensive situation report using MedGemma 27B.

    Falls back to MedGemma 4B if 27B is not loaded.

    Accepts: { "district": "Kano Municipal", "report_type": "situation_report" }
    """
    agent = _models.get("surveillance_agent")
    if not agent:
        return {"error": "Surveillance agent not initialized"}

    district = input_data.get("district", "default")
    report_type = input_data.get("report_type", "situation_report")

    # Get current alerts for context
    alerts = agent.scan_for_anomalies(districts=[district])

    model_27b = _models.get("model_27b")
    tokenizer_27b = _models.get("tokenizer_27b")

    # ── Use 27B for rich situation reports ─────────────────────────
    if model_27b is not None and tokenizer_27b is not None:
        import torch

        db = _models.get("database")
        alert_summaries = []
        for a in alerts:
            alert_summaries.append(f"- {a.alert_level.upper()}: {a.syndrome_category} in {a.district} (ratio: {getattr(a, 'ratio', 'N/A')})")

        alert_text = "\n".join(alert_summaries) if alert_summaries else "No active alerts."
        encounter_count = db.total_encounters if db else 0
        syndrome_dist = json.dumps(db.syndrome_distribution, indent=2) if db else "{}"

        prompt = f"""You are EpiCast, an AI epidemiological surveillance system deployed across West Africa for the WHO IDSR (Integrated Disease Surveillance and Response) framework.

Generate a detailed {report_type.replace('_', ' ')} for {district}.

CURRENT DATA:
- Total encounters processed: {encounter_count}
- Syndrome distribution: {syndrome_dist}
- Active alerts:
{alert_text}
- Report date: {datetime.utcnow().strftime('%Y-%m-%d')}

REPORT STRUCTURE:
1. EXECUTIVE SUMMARY (2-3 sentences)
2. EPIDEMIOLOGICAL OVERVIEW (case counts, trends, syndrome breakdown)
3. ACTIVE ALERTS (detail each alert with recommended actions)
4. DISEASE FORECAST (based on current trends, predict next 7 days)
5. MULTI-MODAL SIGNAL ANALYSIS (summarize cough biomarker and image triage findings if available)
6. RECOMMENDED ACTIONS (prioritized, actionable steps for health authorities)

Write in professional epidemiological language. Be specific with numbers and actionable with recommendations."""

        messages = [{"role": "user", "content": prompt}]

        # Tokenize properly: first get text string, then tokenize to tensors
        input_text = tokenizer_27b.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )
        inputs = tokenizer_27b(input_text, return_tensors="pt").to(model_27b.device)

        with torch.no_grad():
            output_ids = model_27b.generate(
                **inputs,
                max_new_tokens=1024,
                do_sample=True,
                temperature=0.7,
                top_p=0.9,
            )

        new_tokens = output_ids[0][inputs["input_ids"].shape[1]:]
        report = tokenizer_27b.decode(new_tokens, skip_special_tokens=True).strip()

        return {
            "district": district,
            "report_type": report_type,
            "report": report,
            "generated_by": "MedGemma-27B",
            "alerts": [a.model_dump() for a in alerts],
            "timestamp": datetime.utcnow().isoformat(),
        }

    # ── Fallback to 4B ────────────────────────────────────────────
    else:
        report = agent.generate_situation_report(district, alerts)
        return {
            "district": district,
            "report_type": report_type,
            "report": report,
            "generated_by": "MedGemma-4B-fallback",
            "alerts": [a.model_dump() for a in alerts],
            "timestamp": datetime.utcnow().isoformat(),
        }


# ── Dashboard ─────────────────────────────────────────────────────────────

def handle_dashboard(input_data):
    """Dashboard summary: encounters, syndromes, alerts, model status."""
    db = _models.get("database")
    if not db:
        return {"error": "Database not initialized"}

    alerts = []
    if _models.get("surveillance_agent"):
        alerts = _models["surveillance_agent"].scan_for_anomalies()

    return {
        "total_encounters": db.total_encounters,
        "syndrome_distribution": db.syndrome_distribution,
        "active_alerts": {
            "total": len(alerts),
            "emergency": len([a for a in alerts if a.alert_level == "emergency"]),
            "warning": len([a for a in alerts if a.alert_level == "warning"]),
            "watch": len([a for a in alerts if a.alert_level == "watch"]),
        },
        "models_active": {
            "medgemma_4b": _models.get("model_4b") is not None,
            "medgemma_27b": _models.get("model_27b") is not None,
            "hear": _models.get("hear_model") is not None,
            "hear_classifier": _models.get("hear_classifier") is not None,
        },
        "timestamp": datetime.utcnow().isoformat(),
    }


# ============================================================================
# Route dispatcher
# ============================================================================
ROUTES = {
    # Core
    "health":               handle_health,
    "extract":              handle_extract,
    "encounter":            handle_encounter,
    # Multi-modal
    "cough/analyze":        handle_cough,
    "image/triage":         handle_image_triage,
    "fuse":                 handle_fuse,
    "encounter/multimodal": handle_multimodal_encounter,
    # Surveillance
    "surveillance/scan":    handle_surveillance_scan,
    "surveillance/report":  handle_report,
    "alerts":               handle_alerts,
    # Dashboard
    "dashboard":            handle_dashboard,
}


def handler(job):
    """RunPod serverless handler — routes requests to the appropriate function."""
    job_input = job.get("input", {})
    route = job_input.get("route", "health")
    data = job_input.get("data", {})

    handler_fn = ROUTES.get(route)
    if not handler_fn:
        return {
            "error": f"Unknown route: '{route}'",
            "available_routes": sorted(ROUTES.keys()),
        }

    try:
        result = handler_fn(data)
        return result
    except Exception as e:
        return {
            "error": str(e),
            "route": route,
            "traceback": traceback.format_exc(),
        }


# ============================================================================
# Cold start: load all models, then start RunPod serverless worker
# ============================================================================
if __name__ == "__main__":
    import numpy as np  # needed for spectrogram helper

    print("=" * 60)
    print("EpiCast RunPod Handler v2.0 — Full Model Stack")
    print("=" * 60)
    load_models()
    runpod.serverless.start({"handler": handler})