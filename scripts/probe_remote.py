"""Check the optional 27B API using synthetic aggregate data only.

This checks transport and response shape, not model identity or clinical quality.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import time

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.runtime.config import Settings


def probe(settings, token, client):
    if not settings.remote_url:
        raise ValueError('Set EPICAST_REMOTE_27B_URL to the full chat-completions URL')
    if not token:
        raise ValueError('Set EPICAST_REMOTE_TOKEN; do not put credentials in the URL')
    started = time.monotonic()
    response = client.post(settings.remote_url,
        headers={'Authorization': f'Bearer {token}'},
        json={'model': settings.remote_model, 'messages': [{'role': 'user', 'content':
            'Synthetic surveillance test. District Test has 12 encounters this week, '
            'including 8 respiratory and 4 watery diarrhea signals. No baseline is available. '
            'Write two short factual sentences. Do not infer an outbreak or invent evidence.'}],
            'temperature': 0, 'max_tokens': 128})
    response.raise_for_status()
    body = response.json()
    text = body['choices'][0]['message']['content']
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Endpoint returned no report text')
    if body.get('model') != settings.remote_model:
        raise ValueError('Endpoint returned an unexpected model name')
    return {'transport_passed': True, 'model_identity_verified': False,
        'clinical_quality_verified': False, 'release_validated': False,
        'model': body['model'], 'server_fingerprint': body.get('system_fingerprint'),
        'elapsed_seconds': time.monotonic() - started, 'usage': body.get('usage'),
        'text': text}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='remote-probe-results.json')
    args = parser.parse_args()
    try:
        with httpx.Client(timeout=60, follow_redirects=False, trust_env=False) as client:
            result = probe(Settings.from_env(), os.getenv('EPICAST_REMOTE_TOKEN', ''), client)
    except Exception as exc:
        # HTTP exceptions can contain the URL. Keep credentials and URLs out of logs.
        result = {'transport_passed': False, 'release_validated': False,
                  'error_type': type(exc).__name__}
    Path(args.output).write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    return 0 if result['transport_passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
