"""
Image Triage Agent: Medical Image → Disease Pattern Recognition

Uses MedSigLIP for zero-shot classification of clinical images
(skin lesions, rashes, eye findings) against reportable disease patterns.
Then MedGemma 4B provides multimodal reasoning on flagged images.

Pipeline: MedSigLIP (image encoding) → zero-shot matching → MedGemma 4B (detailed analysis)
"""

import torch
import numpy as np
from PIL import Image
from typing import Optional
from loguru import logger

from src.models.medgemma_loader import generate_text


# Disease visual patterns for zero-shot classification via MedSigLIP
DISEASE_VISUAL_PATTERNS = {
    "measles_rash": {
        "text_descriptions": [
            "maculopapular rash consistent with measles",
            "confluent red rash on face and body typical of rubeola",
            "generalized erythematous maculopapular eruption with Koplik spots",
        ],
        "syndrome": "acute_rash_fever",
        "reportable": "measles",
    },
    "chickenpox_rash": {
        "text_descriptions": [
            "vesicular rash in different stages of development",
            "crops of vesicles papules and crusted lesions on skin",
            "varicella rash with clear fluid filled vesicles on erythematous base",
        ],
        "syndrome": "acute_rash_fever",
        "reportable": "chickenpox",
    },
    "hemorrhagic_signs": {
        "text_descriptions": [
            "petechial hemorrhages on skin",
            "ecchymosis and purpura on trunk and extremities",
            "bleeding manifestations with skin hemorrhages",
        ],
        "syndrome": "acute_hemorrhagic_fever",
        "reportable": "hemorrhagic_fever_suspect",
    },
    "cholera_dehydration": {
        "text_descriptions": [
            "severe dehydration with sunken eyes and poor skin turgor",
            "severely dehydrated patient with dry mucous membranes and sunken fontanelle",
            "clinical signs of severe volume depletion",
        ],
        "syndrome": "acute_watery_diarrhea",
        "reportable": "cholera_suspect",
    },
    "meningitis_signs": {
        "text_descriptions": [
            "purpuric rash associated with meningococcal meningitis",
            "petechial and purpuric lesions on skin in patient with meningitis",
            "non-blanching purpura consistent with meningococcemia",
        ],
        "syndrome": "acute_neurological_syndrome",
        "reportable": "meningitis",
    },
    "pneumonia_xray": {
        "text_descriptions": [
            "chest xray showing lobar consolidation pneumonia",
            "bilateral infiltrates on chest radiograph",
            "chest x-ray with patchy opacity consistent with pneumonia",
        ],
        "syndrome": "acute_respiratory_infection",
        "reportable": "pneumonia",
    },
    "healthy_normal": {
        "text_descriptions": [
            "normal healthy skin",
            "normal chest x-ray with clear lung fields",
            "normal clinical appearance",
        ],
        "syndrome": None,
        "reportable": None,
    },
}


class ImageTriageAgent:
    """
    Triage clinical images for disease pattern recognition.
    
    Stage 1: MedSigLIP zero-shot classification against known disease patterns
    Stage 2: MedGemma 4B multimodal analysis of flagged images
    """

    def __init__(
        self,
        siglip_model=None,
        siglip_processor=None,
        medgemma_model=None,
        medgemma_processor=None,
        confidence_threshold: float = 0.3,
    ):
        self.siglip_model = siglip_model
        self.siglip_processor = siglip_processor
        self.medgemma_model = medgemma_model
        self.medgemma_processor = medgemma_processor
        self.confidence_threshold = confidence_threshold

        # Pre-compute text embeddings for disease patterns
        self._pattern_embeddings = {}
        if siglip_model and siglip_processor:
            self._precompute_pattern_embeddings()

    def _precompute_pattern_embeddings(self):
        """Pre-compute text embeddings for all disease patterns."""
        logger.info("Pre-computing disease pattern embeddings...")

        for pattern_name, pattern_data in DISEASE_VISUAL_PATTERNS.items():
            texts = pattern_data["text_descriptions"]
            inputs = self.siglip_processor(
                text=texts,
                return_tensors="pt",
                padding=True,
                truncation=True,
            ).to(self.siglip_model.device)

            with torch.no_grad():
                text_embeds = self.siglip_model.get_text_features(**inputs)
                # Average across descriptions for this pattern
                text_embeds = text_embeds.mean(dim=0, keepdim=True)
                text_embeds = text_embeds / text_embeds.norm(dim=-1, keepdim=True)

            self._pattern_embeddings[pattern_name] = text_embeds

        logger.info(f"Pre-computed embeddings for {len(self._pattern_embeddings)} disease patterns")

    def classify_image(self, image: Image.Image) -> list[dict]:
        """
        Zero-shot classify a clinical image against disease patterns using MedSigLIP.
        
        Args:
            image: PIL Image
            
        Returns:
            List of {pattern, score, syndrome, reportable} sorted by score descending
        """
        if not self.siglip_model:
            logger.warning("MedSigLIP not loaded. Skipping image classification.")
            return []

        # Encode image
        inputs = self.siglip_processor(
            images=image,
            return_tensors="pt",
        ).to(self.siglip_model.device)

        with torch.no_grad():
            image_embeds = self.siglip_model.get_image_features(**inputs)
            image_embeds = image_embeds / image_embeds.norm(dim=-1, keepdim=True)

        # Compute similarity with each disease pattern
        results = []
        for pattern_name, text_embeds in self._pattern_embeddings.items():
            similarity = torch.cosine_similarity(image_embeds, text_embeds).item()
            pattern_data = DISEASE_VISUAL_PATTERNS[pattern_name]

            results.append({
                "pattern": pattern_name,
                "score": round(similarity, 4),
                "syndrome": pattern_data["syndrome"],
                "reportable": pattern_data["reportable"],
            })

        results.sort(key=lambda x: x["score"], reverse=True)
        return results

    def analyze_image(
        self,
        image: Image.Image,
        clinical_context: Optional[str] = None,
    ) -> dict:
        """
        Full image triage pipeline:
        1. MedSigLIP zero-shot classification
        2. MedGemma 4B multimodal analysis (if flagged)
        
        Args:
            image: PIL Image of clinical finding
            clinical_context: Optional text context about the patient
            
        Returns:
            Triage result with classification and analysis
        """
        result = {
            "classifications": [],
            "flagged": False,
            "top_pattern": None,
            "medgemma_analysis": None,
            "syndrome_signal": None,
            "reportable_flag": None,
        }

        # Stage 1: MedSigLIP classification
        classifications = self.classify_image(image)
        result["classifications"] = classifications

        # Check if any disease pattern exceeds threshold
        top_match = classifications[0] if classifications else None
        if top_match and top_match["score"] > self.confidence_threshold:
            if top_match["pattern"] != "healthy_normal":
                result["flagged"] = True
                result["top_pattern"] = top_match["pattern"]
                result["syndrome_signal"] = top_match["syndrome"]
                result["reportable_flag"] = top_match["reportable"]

        # Stage 2: MedGemma 4B multimodal analysis (if flagged)
        if result["flagged"] and self.medgemma_model:
            prompt = (
                "You are a clinical surveillance system. Analyze this medical image "
                "for signs of reportable diseases.\n\n"
            )
            if clinical_context:
                prompt += f"Clinical context: {clinical_context}\n\n"

            prompt += (
                "Describe what you observe in the image, noting any findings relevant to "
                "disease surveillance. Focus on: rash type/distribution, signs of "
                "hemorrhage, dehydration, or other features suggesting reportable conditions. "
                "Be specific and clinical."
            )

            messages = [{"role": "user", "content": prompt}]

            try:
                analysis = generate_text(
                    self.medgemma_model,
                    self.medgemma_processor,
                    messages,
                    max_new_tokens=512,
                    temperature=0.2,
                    images=[image],
                )
                result["medgemma_analysis"] = analysis
            except Exception as e:
                logger.warning(f"MedGemma image analysis failed: {e}")
                result["medgemma_analysis"] = "Analysis unavailable"

        return result
