"""
LoRA Fine-Tuning Script for MedGemma 4B Syndromic Extraction.

Fine-tunes MedGemma 4B using QLoRA on synthetic clinical encounter → structured
syndromic signal extraction pairs. Uses TRL's SFTTrainer following Google's
official fine-tuning notebook.

Usage:
    python scripts/run_finetune.py
    
    # Or with custom args:
    python scripts/run_finetune.py \
        --model_id google/medgemma-4b-it \
        --data_path data/syndromic_training_data.jsonl \
        --output_dir checkpoints/syndromic_extraction_lora \
        --num_epochs 3 \
        --batch_size 4 \
        --learning_rate 2e-4 \
        --lora_r 16
"""

import os
import json
import argparse
import torch
from datasets import Dataset
from transformers import (
    AutoProcessor,
    AutoModelForImageTextToText,
    BitsAndBytesConfig,
)
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig
from loguru import logger


def parse_args():
    parser = argparse.ArgumentParser(description="Fine-tune MedGemma 4B for syndromic extraction")
    parser.add_argument("--model_id", type=str, default="google/medgemma-4b-it",
                        help="HuggingFace model ID")
    parser.add_argument("--data_path", type=str, default="data/syndromic_training_data.jsonl",
                        help="Path to training data JSONL")
    parser.add_argument("--output_dir", type=str, default="checkpoints/syndromic_extraction_lora",
                        help="Output directory for LoRA weights")
    parser.add_argument("--num_epochs", type=int, default=3)
    parser.add_argument("--batch_size", type=int, default=4)
    parser.add_argument("--gradient_accumulation_steps", type=int, default=4)
    parser.add_argument("--learning_rate", type=float, default=2e-4)
    parser.add_argument("--warmup_ratio", type=float, default=0.1)
    parser.add_argument("--max_seq_length", type=int, default=2048)
    parser.add_argument("--lora_r", type=int, default=16)
    parser.add_argument("--lora_alpha", type=int, default=32)
    parser.add_argument("--lora_dropout", type=float, default=0.05)
    parser.add_argument("--push_to_hub", action="store_true")
    parser.add_argument("--hub_model_id", type=str, default=None)
    return parser.parse_args()


def load_training_data(data_path: str) -> Dataset:
    """Load JSONL training data into a HuggingFace Dataset."""
    logger.info(f"Loading training data from: {data_path}")

    examples = []
    with open(data_path, "r") as f:
        for line in f:
            if line.strip():
                examples.append(json.loads(line))

    logger.info(f"Loaded {len(examples)} training examples")

    # Split into train/val (90/10)
    split_idx = int(len(examples) * 0.9)
    train_data = examples[:split_idx]
    val_data = examples[split_idx:]

    logger.info(f"Train: {len(train_data)}, Validation: {len(val_data)}")

    train_dataset = Dataset.from_list(train_data)
    val_dataset = Dataset.from_list(val_data)

    return train_dataset, val_dataset


def main():
    args = parse_args()

    # Verify HF token
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        logger.error("HF_TOKEN not set. Please export HF_TOKEN=your_token")
        return

    from huggingface_hub import login
    login(token=hf_token)

    # ========================================================================
    # 1. Load Model with QLoRA quantization
    # ========================================================================
    logger.info(f"Loading model: {args.model_id}")

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
    )

    model = AutoModelForImageTextToText.from_pretrained(
        args.model_id,
        quantization_config=bnb_config,
        device_map="auto",
        torch_dtype=torch.bfloat16,
    )

    processor = AutoProcessor.from_pretrained(args.model_id)
    processor.tokenizer.padding_side = "right"

    logger.info("Model loaded successfully.")

    # ========================================================================
    # 2. Configure LoRA
    # ========================================================================
    peft_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        target_modules="all-linear",
        task_type="CAUSAL_LM",
        modules_to_save=["lm_head", "embed_tokens"],
    )

    logger.info(f"LoRA config: r={args.lora_r}, alpha={args.lora_alpha}, dropout={args.lora_dropout}")

    # ========================================================================
    # 3. Load Training Data
    # ========================================================================
    train_dataset, val_dataset = load_training_data(args.data_path)

    # ========================================================================
    # 4. Define collation function for text-only training
    # ========================================================================
    def formatting_func(example):
        """Format messages into chat template string for SFTTrainer."""
        messages = example["messages"]
        text = processor.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=False,
        )
        return text

    # ========================================================================
    # 5. Configure Training
    # ========================================================================
    training_args = SFTConfig(
        output_dir=args.output_dir,
        num_train_epochs=args.num_epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        learning_rate=args.learning_rate,
        warmup_ratio=args.warmup_ratio,
        max_seq_length=args.max_seq_length,
        logging_steps=10,
        save_steps=100,
        eval_strategy="steps",
        eval_steps=100,
        save_total_limit=3,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        bf16=True,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        report_to="none",  # Set to "wandb" if using W&B
        optim="adamw_torch_fused",
        dataset_text_field="text",  # Will be populated by formatting_func
        push_to_hub=args.push_to_hub,
        hub_model_id=args.hub_model_id,
    )

    # ========================================================================
    # 6. Initialize Trainer and Train
    # ========================================================================
    trainer = SFTTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        peft_config=peft_config,
        processing_class=processor.tokenizer,
        formatting_func=formatting_func,
    )

    logger.info("Starting training...")
    logger.info(f"  Epochs: {args.num_epochs}")
    logger.info(f"  Batch size: {args.batch_size} x {args.gradient_accumulation_steps} accumulation")
    logger.info(f"  Effective batch size: {args.batch_size * args.gradient_accumulation_steps}")
    logger.info(f"  Learning rate: {args.learning_rate}")
    logger.info(f"  Output: {args.output_dir}")

    train_result = trainer.train()

    # ========================================================================
    # 7. Save Results
    # ========================================================================
    logger.info("Training complete. Saving model...")
    trainer.save_model(args.output_dir)
    processor.save_pretrained(args.output_dir)

    # Log metrics
    metrics = train_result.metrics
    logger.info(f"Training metrics: {json.dumps(metrics, indent=2)}")

    # Save metrics
    with open(os.path.join(args.output_dir, "training_metrics.json"), "w") as f:
        json.dump(metrics, f, indent=2)

    # Run evaluation
    logger.info("Running final evaluation...")
    eval_metrics = trainer.evaluate()
    logger.info(f"Eval metrics: {json.dumps(eval_metrics, indent=2)}")

    with open(os.path.join(args.output_dir, "eval_metrics.json"), "w") as f:
        json.dump(eval_metrics, f, indent=2)

    logger.info(f"LoRA adapter saved to: {args.output_dir}")
    logger.info("Done!")


if __name__ == "__main__":
    main()
