"""
Intake Agent: Clinical Encounter → Structured Syndromic Signal

This is the core novel component of EpiCast. It takes unstructured clinical
narratives (from speech transcription or text entry) and extracts structured
epidemiological signals using a LoRA-fine-tuned MedGemma 4B.

Pipeline: MedASR (speech→text) → MedGemma 4B (text→structured JSON)
"""

import json
from typing import Optional
from datetime import datetime
from loguru import logger

from src.data.syndromic_schema import SyndromicSignal, ClinicalEncounter
from src.models.medgemma_loader import generate_text


SYSTEM_PROMPT = """You are EpiCast, a clinical syndromic surveillance extraction system deployed \
in community health facilities. Given a clinical encounter narrative from a community health \
worker, extract structured epidemiological signals as a JSON object.

You must extract the following fields:
- symptoms: list of normalized symptom terms observed
- symptom_onset_days: integer days since onset (null if unknown)
- syndrome_category: one of [acute_watery_diarrhea, acute_bloody_diarrhea, acute_febrile_illness, \
acute_respiratory_infection, acute_neurological_syndrome, acute_rash_fever, \
acute_hemorrhagic_fever, unexplained_cluster]
- secondary_syndromes: list of other possible syndrome categories
- severity: one of [mild, moderate, severe, critical]
- age_group: one of [neonate, infant, child, school_age, adolescent, adult, elderly]
- sex: male or female (null if not mentioned)
- icd10_codes: relevant ICD-10 codes
- reportable_conditions_flagged: list of notifiable diseases this may signal
- travel_history: any mentioned travel (null if none)
- contact_history: any mentioned contact with similar cases (null if none)
- cluster_indicator: true if the patient reports others with similar symptoms
- confidence_score: your confidence in the extraction (0.0-1.0)

Respond ONLY with valid JSON. No explanation, no markdown, just the JSON object."""


class IntakeAgent:
    """
    Processes clinical encounters into structured syndromic signals.
    
    Uses MedGemma 4B (optionally LoRA fine-tuned) for extraction.
    Designed to run on edge hardware (single GPU, offline capable).
    """

    def __init__(self, model, processor, use_medasr: bool = False):
        """
        Args:
            model: Loaded MedGemma 4B model
            processor: Corresponding processor
            use_medasr: Whether to enable speech-to-text via MedASR
        """
        self.model = model
        self.processor = processor
        self.use_medasr = use_medasr
        self.medasr_model = None
        self.medasr_processor = None

        if use_medasr:
            self._load_medasr()

    def _load_medasr(self):
        """Load MedASR for speech-to-text."""
        try:
            from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor
            logger.info("Loading MedASR for speech transcription...")
            self.medasr_model = AutoModelForSpeechSeq2Seq.from_pretrained(
                "google/medasr",
                torch_dtype="auto",
                device_map="auto",
            )
            self.medasr_processor = AutoProcessor.from_pretrained("google/medasr")
            logger.info("MedASR loaded successfully.")
        except Exception as e:
            logger.warning(f"MedASR loading failed: {e}. Speech input disabled.")
            self.use_medasr = False

    def transcribe_audio(self, audio_path: str) -> str:
        """
        Transcribe clinical audio to text using MedASR.
        
        Args:
            audio_path: Path to audio file (.wav, .mp3)
        
        Returns:
            Transcribed text
        """
        if not self.use_medasr or self.medasr_model is None:
            raise RuntimeError("MedASR not loaded. Initialize with use_medasr=True")

        import librosa
        audio, sr = librosa.load(audio_path, sr=16000)

        inputs = self.medasr_processor(
            audio,
            sampling_rate=16000,
            return_tensors="pt",
        ).to(self.medasr_model.device)

        with __import__("torch").no_grad():
            generated_ids = self.medasr_model.generate(**inputs)

        transcription = self.medasr_processor.batch_decode(
            generated_ids, skip_special_tokens=True
        )[0]

        logger.info(f"Transcribed audio ({len(audio)/sr:.1f}s) → {len(transcription)} chars")
        return transcription

    def extract_syndromic_signal(
        self,
        narrative: str,
        max_retries: int = 2,
    ) -> Optional[SyndromicSignal]:
        """
        Extract structured syndromic signal from clinical narrative.
        
        Args:
            narrative: Free-text clinical encounter description
            max_retries: Number of retries on JSON parse failure
        
        Returns:
            SyndromicSignal object or None on failure
        """
        messages = [
            {"role": "user", "content": (
                f"Extract syndromic surveillance signals from this clinical encounter:\n\n"
                f"{narrative}"
            )},
        ]

        for attempt in range(max_retries + 1):
            try:
                response = generate_text(
                    self.model,
                    self.processor,
                    messages=[{"role": "system", "content": SYSTEM_PROMPT}] + messages,
                    max_new_tokens=1024,
                    temperature=0.1,
                    do_sample=True,
                )

                # Clean response — sometimes model wraps in markdown code blocks
                response = response.strip()
                if response.startswith("```json"):
                    response = response[7:]
                if response.startswith("```"):
                    response = response[3:]
                if response.endswith("```"):
                    response = response[:-3]
                response = response.strip()

                # Parse JSON
                data = json.loads(response)

                # Validate with Pydantic
                signal = SyndromicSignal(**data)
                logger.info(
                    f"Extracted signal: syndrome={signal.syndrome_category}, "
                    f"severity={signal.severity}, confidence={signal.confidence_score}"
                )
                return signal

            except json.JSONDecodeError as e:
                logger.warning(f"JSON parse failed (attempt {attempt+1}): {e}")
                if attempt < max_retries:
                    # Add a correction prompt
                    messages.append({"role": "assistant", "content": response})
                    messages.append({"role": "user", "content": (
                        "That response was not valid JSON. Please respond with ONLY "
                        "a valid JSON object matching the required schema. No markdown, "
                        "no explanation, just the JSON."
                    )})
            except Exception as e:
                logger.error(f"Extraction failed (attempt {attempt+1}): {e}")
                if attempt < max_retries:
                    continue

        logger.error("All extraction attempts failed.")
        return None

    def process_encounter(
        self,
        narrative: Optional[str] = None,
        audio_path: Optional[str] = None,
        location_lat: Optional[float] = None,
        location_lon: Optional[float] = None,
        district: Optional[str] = None,
        facility_name: Optional[str] = None,
    ) -> ClinicalEncounter:
        """
        Full intake pipeline: audio/text → structured encounter record.
        
        Args:
            narrative: Text narrative (if no audio)
            audio_path: Path to audio recording (if using speech)
            location_lat/lon: GPS coordinates
            district: Administrative district name
            facility_name: Facility name
        
        Returns:
            Complete ClinicalEncounter with extracted syndromic signal
        """
        # Step 1: Get text (from audio or direct input)
        if audio_path and self.use_medasr:
            narrative = self.transcribe_audio(audio_path)
        elif narrative is None:
            raise ValueError("Either narrative text or audio_path must be provided")

        # Step 2: Extract syndromic signal
        signal = self.extract_syndromic_signal(narrative)

        # Step 3: Build encounter record
        import uuid
        encounter = ClinicalEncounter(
            encounter_id=str(uuid.uuid4())[:8],
            timestamp=datetime.now(),
            location_lat=location_lat,
            location_lon=location_lon,
            district=district,
            facility_name=facility_name,
            narrative_text=narrative,
            syndromic_signal=signal,
        )

        logger.info(
            f"Encounter {encounter.encounter_id} processed: "
            f"syndrome={signal.syndrome_category if signal else 'FAILED'}"
        )
        return encounter
