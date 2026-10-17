"""
Evaluation Script for Syndromic Extraction Quality.

Tests the fine-tuned MedGemma 4B on held-out examples and measures:
1. JSON validity rate
2. Syndrome classification accuracy
3. Severity accuracy
4. Symptom extraction F1
5. ICD-10 code accuracy
6. Reportable condition detection recall

Usage:
    python scripts/run_evaluation.py --model_path checkpoints/syndromic_extraction_lora
    python scripts/run_evaluation.py --baseline  # Test baseline (no fine-tuning)
"""

import os
import sys
import json
import argparse
from collections import defaultdict
from loguru import logger

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.data.synthetic_generator import generate_single_example, SYNDROME_DATA
from src.models.medgemma_loader import load_medgemma_4b, generate_text
from src.agents.intake_agent import IntakeAgent


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model_id", type=str, default="google/medgemma-4b-it")
    parser.add_argument("--model_path", type=str, default=None, help="Path to LoRA adapter")
    parser.add_argument("--baseline", action="store_true", help="Evaluate without fine-tuning")
    parser.add_argument("--num_examples", type=int, default=100)
    parser.add_argument("--output", type=str, default="eval_results.json")
    parser.add_argument("--seed", type=int, default=123)
    return parser.parse_args()


def compute_set_f1(predicted: set, ground_truth: set) -> dict:
    """Compute precision, recall, F1 for two sets."""
    if not predicted and not ground_truth:
        return {"precision": 1.0, "recall": 1.0, "f1": 1.0}
    if not predicted or not ground_truth:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}

    tp = len(predicted & ground_truth)
    precision = tp / len(predicted) if predicted else 0.0
    recall = tp / len(ground_truth) if ground_truth else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    return {"precision": precision, "recall": recall, "f1": f1}


def evaluate(args):
    import random
    random.seed(args.seed)

    # Load model
    logger.info("Loading model...")
    lora_path = None if args.baseline else args.model_path
    model, processor = load_medgemma_4b(
        model_id=args.model_id,
        quantize="4bit",
        lora_adapter_path=lora_path,
    )

    agent = IntakeAgent(model=model, processor=processor, use_medasr=False)

    # Generate test examples
    logger.info(f"Generating {args.num_examples} test examples...")
    test_examples = []
    syndromes = list(SYNDROME_DATA.keys())
    per_syndrome = args.num_examples // len(syndromes)

    for syndrome in syndromes:
        for _ in range(per_syndrome):
            ex = generate_single_example(syndrome)
            test_examples.append(ex)

    random.shuffle(test_examples)
    logger.info(f"Generated {len(test_examples)} test examples")

    # Run evaluation
    metrics = defaultdict(list)
    results = []

    for i, example in enumerate(test_examples):
        narrative = example["narrative"]
        ground_truth = example["extraction"]

        logger.info(f"Evaluating {i+1}/{len(test_examples)}: {ground_truth['syndrome_category']}")

        try:
            signal = agent.extract_syndromic_signal(narrative, max_retries=1)

            if signal is None:
                metrics["json_valid"].append(0)
                results.append({"index": i, "success": False, "error": "extraction_failed"})
                continue

            metrics["json_valid"].append(1)

            # Syndrome classification accuracy
            syndrome_correct = signal.syndrome_category == ground_truth["syndrome_category"]
            metrics["syndrome_accuracy"].append(int(syndrome_correct))

            # Severity accuracy
            severity_correct = signal.severity.value == ground_truth["severity"]
            metrics["severity_accuracy"].append(int(severity_correct))

            # Age group accuracy
            age_correct = signal.age_group.value == ground_truth["age_group"]
            metrics["age_group_accuracy"].append(int(age_correct))

            # Symptom extraction F1
            pred_symptoms = set(signal.symptoms)
            gt_symptoms = set(ground_truth["symptoms"])
            symptom_metrics = compute_set_f1(pred_symptoms, gt_symptoms)
            metrics["symptom_f1"].append(symptom_metrics["f1"])
            metrics["symptom_precision"].append(symptom_metrics["precision"])
            metrics["symptom_recall"].append(symptom_metrics["recall"])

            # ICD-10 code overlap
            pred_icd = set(signal.icd10_codes)
            gt_icd = set(ground_truth["icd10_codes"])
            icd_metrics = compute_set_f1(pred_icd, gt_icd)
            metrics["icd10_f1"].append(icd_metrics["f1"])

            # Reportable condition recall (critical — must not miss)
            pred_reportable = set(signal.reportable_conditions_flagged)
            gt_reportable = set(ground_truth["reportable_conditions_flagged"])
            report_metrics = compute_set_f1(pred_reportable, gt_reportable)
            metrics["reportable_recall"].append(report_metrics["recall"])

            # Cluster detection
            cluster_correct = signal.cluster_indicator == ground_truth["cluster_indicator"]
            metrics["cluster_accuracy"].append(int(cluster_correct))

            results.append({
                "index": i,
                "success": True,
                "syndrome_correct": syndrome_correct,
                "severity_correct": severity_correct,
                "symptom_f1": symptom_metrics["f1"],
            })

        except Exception as e:
            logger.error(f"Error on example {i}: {e}")
            metrics["json_valid"].append(0)
            results.append({"index": i, "success": False, "error": str(e)})

    # Compute aggregate metrics
    summary = {}
    for key, values in metrics.items():
        summary[key] = {
            "mean": round(sum(values) / len(values), 4) if values else 0.0,
            "count": len(values),
        }

    # Print report
    print("\n" + "=" * 60)
    print("EPICAST SYNDROMIC EXTRACTION EVALUATION REPORT")
    print("=" * 60)
    mode = "BASELINE (no fine-tuning)" if args.baseline else f"FINE-TUNED ({args.model_path})"
    print(f"Mode: {mode}")
    print(f"Model: {args.model_id}")
    print(f"Test examples: {len(test_examples)}")
    print("-" * 60)

    print(f"  JSON Validity Rate:        {summary.get('json_valid', {}).get('mean', 0):.1%}")
    print(f"  Syndrome Classification:   {summary.get('syndrome_accuracy', {}).get('mean', 0):.1%}")
    print(f"  Severity Accuracy:         {summary.get('severity_accuracy', {}).get('mean', 0):.1%}")
    print(f"  Age Group Accuracy:        {summary.get('age_group_accuracy', {}).get('mean', 0):.1%}")
    print(f"  Symptom Extraction F1:     {summary.get('symptom_f1', {}).get('mean', 0):.3f}")
    print(f"    - Precision:             {summary.get('symptom_precision', {}).get('mean', 0):.3f}")
    print(f"    - Recall:                {summary.get('symptom_recall', {}).get('mean', 0):.3f}")
    print(f"  ICD-10 Code F1:            {summary.get('icd10_f1', {}).get('mean', 0):.3f}")
    print(f"  Reportable Cond. Recall:   {summary.get('reportable_recall', {}).get('mean', 0):.1%}")
    print(f"  Cluster Detection Acc:     {summary.get('cluster_accuracy', {}).get('mean', 0):.1%}")
    print("=" * 60)

    # Save results
    output = {
        "config": {
            "model_id": args.model_id,
            "lora_path": args.model_path,
            "baseline": args.baseline,
            "num_examples": len(test_examples),
        },
        "summary": summary,
        "detailed_results": results[:20],  # Save first 20 for inspection
    }

    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)
    logger.info(f"Results saved to: {args.output}")


if __name__ == "__main__":
    args = parse_args()
    evaluate(args)
