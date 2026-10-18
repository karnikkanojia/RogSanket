"""API benchmark and 30-minute soak. Never substitutes generated test results.

Run against a provisioned service with the release SwiftUI app open.
Output includes every failure and memory snapshot; failed requests count against latency gates.
"""
import argparse
import asyncio
import json
import math
from pathlib import Path
import time
import httpx


def percentile(values, fraction):
    return sorted(values)[max(0, math.ceil(len(values) * fraction) - 1)] if values else None


async def main(args):
    fixtures = [json.loads(line) for line in Path(args.fixtures).read_text().splitlines() if line.strip()]
    if not fixtures:
        raise ValueError("Fixtures are empty")
    samples, reports, health, failures = [], [], [], []
    async with httpx.AsyncClient(base_url=args.url, timeout=190) as client:
        for i in range(10):
            response = await client.post('/encounter', json={"narrative": fixtures[i % len(fixtures)]["narrative"], "district": "Benchmark"})
            if response.is_error:
                Path(args.output).write_text(json.dumps({"passed": False, "release_complete": False,
                    "phase": "warmup", "status": response.status_code, "detail": response.json()}))
                return 1
        stop = time.monotonic() + args.soak_seconds
        i = 0
        async def monitor():
            while True:
                start = time.monotonic()
                try:
                    response = await client.get('/health', timeout=3)
                    response.raise_for_status()
                    health.append({"seconds": time.monotonic() - start, **response.json()})
                except Exception as exc:
                    failures.append({"phase": "health", "error": str(exc)})
                await asyncio.sleep(0.5)
        monitor_task = asyncio.create_task(monitor())
        try:
            while i < args.samples or time.monotonic() < stop:
                start = time.monotonic()
                try:
                    response = await client.post('/encounter', json={"narrative": fixtures[i % len(fixtures)]["narrative"], "district": "Benchmark"})
                    samples.append({"seconds": time.monotonic() - start, "status": response.status_code,
                                    "provenance": response.json().get("provenance")})
                    if response.is_error:
                        failures.append({"phase": "extraction", "status": response.status_code})
                except httpx.HTTPError as exc:
                    failures.append({"phase": "extraction", "error": str(exc)})
                i += 1
            for _ in range(args.reports):
                start = time.monotonic()
                try:
                    response = await client.post('/jobs/report', json={"district": "Benchmark", "max_tokens": 512, "refresh": True})
                    response.raise_for_status()
                    job = response.json()
                    while job['status'] in ('queued', 'running'):
                        await asyncio.sleep(.1)
                        status = await client.get('/jobs/' + job['id'])
                        status.raise_for_status()
                        job = status.json()
                    reports.append({"seconds": time.monotonic() - start, "status": job['status']})
                    if job['status'] != 'succeeded':
                        failures.append({"phase": "report", "error": job.get('error')})
                except httpx.HTTPError as exc:
                    failures.append({"phase": "report", "error": str(exc)})
        finally:
            monitor_task.cancel()
            try:
                await monitor_task
            except asyncio.CancelledError:
                pass
    p95 = percentile([s['seconds'] for s in samples], 0.95)
    report_p95 = percentile([s["seconds"] for s in reports], 0.95)
    health_p95 = percentile([s['seconds'] for s in health], 0.95)
    swaps = [s['memory']['swap_used_bytes'] for s in health if s['memory']['swap_used_bytes'] is not None]
    telemetry_complete = bool(health) and all(s['memory']['swap_used_bytes'] is not None and s['memory']['pressure'] != 'unknown' for s in health)
    critical = any(s['memory']['pressure'] == 'critical' for s in health)
    result = {"samples": samples, "reports": reports, "health": health, "failures": failures,
        "report_p95_seconds": report_p95, "extraction_p95_seconds": p95, "health_p95_seconds": health_p95,
        "swap_growth_bytes": swaps[-1] - swaps[0] if swaps else None,
        "passed": bool(p95 is not None and p95 <= 30 and health_p95 is not None and health_p95 <= 0.25
                       and report_p95 is not None and report_p95 <= 120
                       and len(samples) >= 100 and args.soak_seconds >= 1800 and len(reports) >= 10
                       and telemetry_complete and not failures and not critical and swaps and swaps[-1] <= swaps[0]),
        "release_complete": False,
        "remaining_gates": ["modality reference parity", "offline network audit", "Swift parity"]}
    Path(args.output).write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k not in ('samples', 'reports', 'health')}, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8000')
    parser.add_argument('--fixtures', default='data/evaluation_frozen.jsonl')
    parser.add_argument('--reports', type=int, default=10)
    parser.add_argument('--samples', type=int, default=100)
    parser.add_argument('--soak-seconds', type=int, default=1800)
    parser.add_argument('--output', default='benchmark-results.json')
    raise SystemExit(asyncio.run(main(parser.parse_args())))
