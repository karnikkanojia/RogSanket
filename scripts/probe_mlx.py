"""Run an explicitly unvalidated local artifact without promoting it to production.

No downloads or clinical data. Production Settings.manifest retains its parity gate.
"""
import argparse
import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'

from src.runtime.config import Settings
from src.runtime.memory import snapshot
from src.runtime.scheduler import Scheduler


class ExperimentalSettings(Settings):
    def manifest(self):
        return super().manifest(require_parity=False)


async def probe(args):
    root = Path(args.artifact).resolve()
    manifest_path = root / 'epicast-artifact.json'
    if not manifest_path.is_file():
        raise RuntimeError('Provision artifact first with scripts/provision_mlx.py')
    from src.agents.intake_agent import SYSTEM_PROMPT
    messages = [{'role': 'system', 'content': SYSTEM_PROMPT},
        {'role': 'user', 'content': 'A 35-year-old woman has fever and cough for three days. No diarrhea, rash, bleeding, travel, or sick contacts.'}]
    requests = [('cold_extraction', messages, [], args.max_tokens)]
    requests.extend((f'warm_extraction_{i + 1}', messages, [], args.max_tokens) for i in range(args.repetitions))
    image_bytes = Path(args.image).read_bytes() if args.image else None
    if args.synthetic_image:
        import io
        from PIL import Image, ImageDraw
        image = Image.new('RGB', (448, 448), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((40, 60, 200, 220), fill='red')
        draw.ellipse((250, 250, 410, 410), fill='blue')
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        image_bytes = buffer.getvalue()
    if image_bytes:
        requests.append(('vision_smoke', [{'role': 'user', 'content': 'Describe the visible shapes and colors. This is a synthetic test image.'}],
                         [base64.b64encode(image_bytes).decode()], 96))
    worker = Scheduler(Settings(artifact=str(root)), command=[sys.executable, str(Path(__file__).resolve()),
        '--artifact', str(root), '--allow-unvalidated-artifact', '--worker'])
    await worker.start()
    import importlib.metadata
    import platform
    results = {'experimental': True, 'release_validated': False,
        'platform': platform.platform(),
        'memory_scope': 'Scheduler RSS; worker RSS and MLX allocations are in provenance',
        'versions': {name: importlib.metadata.version(name) for name in ['mlx', 'mlx-vlm', 'transformers']},
        'runs': []}
    try:
        for name, messages, images, maximum in requests:
            before = snapshot()
            started = time.monotonic()
            try:
                result = await worker.run({'operation': 'generate', 'messages': messages,
                    'task': 'extraction' if 'extraction' in name else 'vision_smoke',
                    'images': images, 'max_tokens': maximum, 'deadline': time.time() + 300})
                if 'extraction' in name:
                    from src.data.syndromic_schema import SyndromicSignal
                    try:
                        SyndromicSignal.model_validate_json(result['text'])
                        result['schema_valid'] = True
                    except ValueError:
                        result['schema_valid'] = False
            except Exception as exc:
                result = {'error': str(exc), 'error_type': type(exc).__name__}
            results['runs'].append({'name': name, 'elapsed_seconds': time.monotonic() - started,
                'memory_before': before, 'memory_after': snapshot(), **result})
            Path(args.output).write_text(json.dumps(results, indent=2) + '\n')
            print(json.dumps(results['runs'][-1]), flush=True)
            if result.get('error_type') == 'MemoryError':
                break
    finally:
        await worker.close()
    if any("error" in run or run.get("schema_valid") is False for run in results["runs"]):
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifact', required=True)
    parser.add_argument('--allow-unvalidated-artifact', action='store_true', required=True)
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--output', default='inference-results.json')
    vision = parser.add_mutually_exclusive_group()
    vision.add_argument('--image', help='Optional nonclinical image for a vision smoke test')
    vision.add_argument('--synthetic-image', action='store_true', help='Probe a red square and blue circle')
    parser.add_argument('--max-tokens', type=int, default=512)
    parser.add_argument('--repetitions', type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.repetitions <= 10:
        parser.error('--repetitions must be between 1 and 10')
    if args.worker:
        from src.runtime.worker import main as worker_main
        worker_main(ExperimentalSettings(artifact=str(Path(args.artifact).resolve())))
    else:
        asyncio.run(probe(args))


if __name__ == '__main__':
    main()
