#!/usr/bin/env python3
"""
Generate synthetic training data for syndromic extraction fine-tuning.

Usage:
    python scripts/generate_training_data.py
    python scripts/generate_training_data.py --num_examples 3000 --output data/training.jsonl
"""

import argparse
import sys
import os

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.data.synthetic_generator import generate_training_dataset


def main():
    parser = argparse.ArgumentParser(description="Generate synthetic syndromic extraction training data")
    parser.add_argument("--num_examples", type=int, default=2000, help="Number of training examples")
    parser.add_argument("--output", type=str, default="data/syndromic_training_data.jsonl", help="Output path")
    parser.add_argument("--seed", type=int, default=42, help="Random seed for reproducibility")
    args = parser.parse_args()

    import random
    random.seed(args.seed)

    print(f"Generating {args.num_examples} training examples...")
    examples = generate_training_dataset(
        num_examples=args.num_examples,
        output_path=args.output,
    )
    print(f"\nDone! Saved to {args.output}")
    print(f"Total examples: {len(examples)}")
    print(f"\nTo fine-tune, run:")
    print(f"  python scripts/run_finetune.py --data_path {args.output}")


if __name__ == "__main__":
    main()
