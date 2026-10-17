"""
Model loading utilities for all HAI-DEF models used in EpiCast.
Supports quantized loading for edge deployment and full-precision for training.
"""

import torch
from transformers import (
    AutoProcessor,
    AutoModelForImageTextToText,
    AutoModelForCausalLM,
    BitsAndBytesConfig,
)
from peft import PeftModel
from loguru import logger
from typing import Optional


def get_quantization_config(mode: str = "4bit") -> Optional[BitsAndBytesConfig]:
    """Get BitsAndBytes quantization config."""
    if mode == "4bit":
        return BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_use_double_quant=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
    elif mode == "8bit":
        return BitsAndBytesConfig(load_in_8bit=True)
    return None


def load_medgemma_4b(
    model_id: str = "google/medgemma-4b-it",
    quantize: str = "4bit",
    lora_adapter_path: Optional[str] = None,
    device_map: str = "auto",
):
    """
    Load MedGemma 4B multimodal model.
    Used for: Syndromic extraction from clinical narratives + image triage.
    
    Args:
        model_id: HuggingFace model ID
        quantize: "4bit", "8bit", or None for full precision
        lora_adapter_path: Path to LoRA adapter weights (if fine-tuned)
        device_map: Device mapping strategy
    
    Returns:
        (model, processor) tuple
    """
    logger.info(f"Loading MedGemma 4B: {model_id} (quantize={quantize})")

    quant_config = get_quantization_config(quantize)

    model_kwargs = {
        "device_map": device_map,
        "torch_dtype": torch.bfloat16,
    }
    if quant_config:
        model_kwargs["quantization_config"] = quant_config

    # MedGemma 4B is multimodal (image + text)
    model = AutoModelForImageTextToText.from_pretrained(
        model_id, **model_kwargs
    )
    processor = AutoProcessor.from_pretrained(model_id)

    # Load LoRA adapter if fine-tuned
    if lora_adapter_path:
        logger.info(f"Loading LoRA adapter from: {lora_adapter_path}")
        model = PeftModel.from_pretrained(model, lora_adapter_path)

    model.eval()
    logger.info(f"MedGemma 4B loaded successfully. Device: {model.device}")
    return model, processor


def load_medgemma_27b(
    model_id: str = "google/medgemma-27b-text-it",
    quantize: str = "4bit",
    device_map: str = "auto",
):
    """
    Load MedGemma 27B text-only model.
    Used for: Surveillance analytics, situation reports, clinical reasoning.
    
    Args:
        model_id: HuggingFace model ID (text-only or multimodal)
        quantize: Quantization mode
        device_map: Device mapping strategy
    
    Returns:
        (model, processor) tuple
    """
    logger.info(f"Loading MedGemma 27B: {model_id} (quantize={quantize})")

    quant_config = get_quantization_config(quantize)

    model_kwargs = {
        "device_map": device_map,
        "torch_dtype": torch.bfloat16,
    }
    if quant_config:
        model_kwargs["quantization_config"] = quant_config

    # Check if multimodal or text-only
    if "text" in model_id:
        model = AutoModelForCausalLM.from_pretrained(model_id, **model_kwargs)
    else:
        model = AutoModelForImageTextToText.from_pretrained(model_id, **model_kwargs)

    processor = AutoProcessor.from_pretrained(model_id)
    model.eval()
    logger.info(f"MedGemma 27B loaded successfully.")
    return model, processor


def load_medsiglip(
    model_id: str = "google/medsiglip",
    device: str = "cuda",
):
    """
    Load MedSigLIP image encoder.
    Used for: Zero-shot medical image classification for disease pattern recognition.
    
    Returns:
        (model, processor) tuple
    """
    logger.info(f"Loading MedSigLIP: {model_id}")

    from transformers import AutoModel, AutoProcessor as SigLIPProcessor

    model = AutoModel.from_pretrained(
        model_id,
        torch_dtype=torch.bfloat16,
    ).to(device)

    processor = SigLIPProcessor.from_pretrained(model_id)
    model.eval()
    logger.info("MedSigLIP loaded successfully.")
    return model, processor


def generate_text(
    model,
    processor,
    messages: list[dict],
    max_new_tokens: int = 1024,
    temperature: float = 0.1,
    do_sample: bool = True,
    images: list = None,
) -> str:
    """
    Generate text from a MedGemma model using chat messages format.
    
    Args:
        model: Loaded MedGemma model
        processor: Corresponding processor
        messages: List of {"role": ..., "content": ...} messages
        max_new_tokens: Maximum tokens to generate
        temperature: Sampling temperature
        do_sample: Whether to use sampling
        images: Optional list of PIL images for multimodal input
    
    Returns:
        Generated text string
    """
    # Apply chat template
    input_text = processor.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
    )

    # Prepare inputs
    if images:
        inputs = processor(
            text=input_text,
            images=images,
            return_tensors="pt",
        ).to(model.device)
    else:
        inputs = processor(
            text=input_text,
            return_tensors="pt",
        ).to(model.device)

    # Generate
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=temperature if do_sample else None,
            do_sample=do_sample,
        )

    # Decode only the generated tokens
    generated_ids = outputs[0][inputs["input_ids"].shape[1]:]
    response = processor.decode(generated_ids, skip_special_tokens=True)
    return response.strip()
