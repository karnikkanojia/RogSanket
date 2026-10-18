"""Compare original HF and MLX processors in separate, offline processes.

MLX patches AutoProcessor globally, so importing both implementations in one
process would produce an invalid self-comparison. No model weights are loaded.
"""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def collect(implementation, artifact, output):
    import numpy as np
    from PIL import Image
    from src.agents.intake_agent import SYSTEM_PROMPT

    root = Path(artifact)
    if implementation == "hf":
        from transformers import AutoProcessor

        processor = AutoProcessor.from_pretrained(
            root, use_fast=False, local_files_only=True
        )
    else:
        from mlx_vlm.models.gemma3.config import ModelConfig
        from mlx_vlm.utils import load_processor
        from mlx_vlm.prompt_utils import apply_chat_template
        from src.runtime.worker import prepare_gemma_inputs

        config = ModelConfig.from_dict(json.loads((root / "config.json").read_text()))
        processor = load_processor(root, local_files_only=True)
    tokenizer = processor.tokenizer
    records, arrays = [], {}
    source = Path(__file__).resolve().parents[1] / "data/evaluation_frozen.jsonl"
    narratives = [
        json.loads(line)["narrative"] for line in source.read_text().splitlines()
    ]
    narratives += [
        "No fever, cough, bleeding, or diarrhea. Follow-up only.",
        "Fièvre à 39 °C depuis 3 jours; pas de diarrhée. Côte d’Ivoire.",
        "BP 120/80 mmHg; SpO₂ 98%; dose 0.5 mg; temperature 37.2°C.",
    ]
    cases = [
        (
            f"text_{i}",
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": narrative},
            ],
            None,
        )
        for i, narrative in enumerate(narratives)
    ]
    cases.append(
        (
            "retry",
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": "Fever and cough."},
                {"role": "assistant", "content": '{"symptoms": ["fever"]}'},
                {
                    "role": "user",
                    "content": "Return only valid JSON matching the required schema.",
                },
            ],
            None,
        )
    )
    for name, width, height, gray in [
        ("square", 448, 448, False),
        ("wide", 900, 240, False),
        ("tall", 240, 900, False),
        ("gray", 320, 256, True),
    ]:
        rng = np.random.default_rng(42)
        pixels = rng.integers(
            0, 256, size=(height, width) if gray else (height, width, 3), dtype=np.uint8
        )
        image = Image.fromarray(pixels).convert("RGB")
        cases.append(
            (
                name,
                [{"role": "user", "content": "Describe the synthetic test image."}],
                image,
            )
        )
    for name, messages, image in cases:
        if implementation == "hf":
            if image is not None:
                messages = [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": messages[0]["content"]},
                            {"type": "image"},
                        ],
                    }
                ]
            prompt = processor.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True
            )
            if image is None:
                inputs = tokenizer(
                    prompt, add_special_tokens=False, padding=True, return_tensors="np"
                )
            else:
                inputs = processor(
                    text=prompt,
                    images=[image],
                    add_special_tokens=False,
                    return_tensors="np",
                )
        else:
            prompt = apply_chat_template(
                processor, config, messages, num_images=0 if image is None else 1
            )
            inputs = prepare_gemma_inputs(processor, prompt, image)
        tensors = {}
        for key in ["input_ids", "attention_mask", "pixel_values"]:
            if key in inputs:
                value = np.asarray(inputs[key])
                arrays[f"{name}_{key}"] = value
                tensors[key] = list(value.shape)
        records.append({"name": name, "prompt": prompt, "tensors": tensors})
    vocab = sorted(tokenizer.get_vocab().items())
    assets = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.iterdir())
        if path.suffix in {".json", ".model", ".jinja"}
        and path.name != "epicast-artifact.json"
    }
    revisions = set()
    for name in assets:
        metadata = root / ".cache" / "huggingface" / "download" / (name + ".metadata")
        if metadata.is_file():
            revisions.add(metadata.read_text().splitlines()[0])
    result = {
        "assets_sha256": assets,
        "download_revisions": sorted(revisions),
        "processor_class": f"{type(processor).__module__}.{type(processor).__name__}",
        "image_processor_class": f"{type(processor.image_processor).__module__}.{type(processor.image_processor).__name__}",
        "vocab_sha256": hashlib.sha256(
            json.dumps(vocab, ensure_ascii=False).encode()
        ).hexdigest(),
        "special_token_ids": sorted(tokenizer.all_special_ids),
        "cases": records,
    }
    Path(output + ".json").write_text(json.dumps(result, indent=2) + "\n")
    np.savez(output + ".npz", **arrays)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", default="models/medgemma-1.5-4b-reference")
    parser.add_argument("--candidate", default="models/medgemma-1.5-4b-it-4bit")
    parser.add_argument("--output", default="processor-parity-results.json")
    parser.add_argument("--collect", choices=["hf", "mlx"], help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.collect:
        collect(args.collect, args.reference, args.output)
        return
    import numpy as np

    with tempfile.TemporaryDirectory(prefix="epicast-parity-") as temp:
        outputs = {}
        for implementation, artifact in [
            ("hf", args.reference),
            ("mlx", args.candidate),
        ]:
            prefix = str(Path(temp) / implementation)
            subprocess.run(
                [
                    sys.executable,
                    __file__,
                    "--collect",
                    implementation,
                    "--reference",
                    artifact,
                    "--output",
                    prefix,
                ],
                check=True,
            )
            outputs[implementation] = (
                json.loads(Path(prefix + ".json").read_text()),
                np.load(prefix + ".npz"),
            )
        (reference, reference_arrays), (candidate, candidate_arrays) = (
            outputs["hf"],
            outputs["mlx"],
        )
        comparisons = []
        for a, b in zip(reference["cases"], candidate["cases"], strict=True):
            checks = {
                "name": a["name"],
                "prompt_equal": a["prompt"] == b["prompt"],
                "tensors": {},
            }
            for key in a["tensors"].keys() | b["tensors"].keys():
                name = f"{a['name']}_{key}"
                x, y = reference_arrays.get(name), candidate_arrays.get(name)
                same_shape = x is not None and y is not None and x.shape == y.shape
                difference = (
                    float(np.max(np.abs(x.astype("float64") - y.astype("float64"))))
                    if same_shape
                    else None
                )
                checks["tensors"][key] = {
                    "shape_equal": same_shape,
                    "max_abs_error": difference,
                    "passed": same_shape
                    and (
                        difference <= 1e-6 if key == "pixel_values" else difference == 0
                    ),
                }
            checks["passed"] = checks["prompt_equal"] and all(
                x["passed"] for x in checks["tensors"].values()
            )
            comparisons.append(checks)
        report = {
            "processor_parity_passed": reference["vocab_sha256"]
            == candidate["vocab_sha256"]
            and all(c["passed"] for c in comparisons),
            "reference_revision": reference["download_revisions"],
            "candidate_revision": candidate["download_revisions"],
            "reference_assets_sha256": reference["assets_sha256"],
            "candidate_assets_sha256": candidate["assets_sha256"],
            "versions": {
                name: importlib.metadata.version(name)
                for name in ["transformers", "mlx-vlm", "Pillow"]
            },
            "reference_image_backend": "PIL",
            "candidate_image_backend": "PIL",
            "reference_processor": reference["processor_class"],
            "candidate_processor": candidate["processor_class"],
            "vocabulary_mapping_equal": reference["vocab_sha256"]
            == candidate["vocab_sha256"],
            "special_token_ids_reference_only": sorted(
                set(reference["special_token_ids"])
                - set(candidate["special_token_ids"])
            ),
            "special_token_ids_candidate_only": sorted(
                set(candidate["special_token_ids"])
                - set(reference["special_token_ids"])
            ),
            "weight_output_parity_passed": False,
            "release_validated": False,
            "cases": comparisons,
        }
        Path(args.output).write_text(json.dumps(report, indent=2) + "\n")
        print(
            json.dumps(
                {
                    k: v
                    for k, v in report.items()
                    if k
                    not in {
                        "cases",
                        "reference_assets_sha256",
                        "candidate_assets_sha256",
                    }
                },
                indent=2,
            )
        )
        print(
            "Cases:", len(comparisons), "passed:", sum(c["passed"] for c in comparisons)
        )
        if not report["processor_parity_passed"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
