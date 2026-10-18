"""Synthetic JSONL transport fixture. Never used by production startup."""
import json
import os
import sys
import time
for line in sys.stdin:
    request = json.loads(line)
    task = request.get('task')
    if task == 'hang':
        time.sleep(30)
    if task == 'crash':
        raise SystemExit(3)
    if task == 'invalid':
        print('not json', flush=True)
        continue
    result = {'result': {'task': task, 'offline': os.environ.get('HF_HUB_OFFLINE'), 'size': len(request.get('data', ''))}}
    encoded = json.dumps(result) + '\n'
    if task == 'chunks':
        for character in encoded:
            sys.stdout.write(character)
            sys.stdout.flush()
            time.sleep(.0001)
    else:
        print(encoded, end='', flush=True)
