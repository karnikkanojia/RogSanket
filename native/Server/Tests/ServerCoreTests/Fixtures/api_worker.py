"""Synthetic model fixture for HTTP migration verification only."""
import json
import os
import sys
import time

signal = {'symptoms': ['fever'], 'syndrome_category': 'acute_febrile_illness', 'severity': 'moderate',
          'age_group': 'adult', 'icd10_codes': ['R50'], 'confidence_score': .8}
provenance = {'model': 'synthetic-contract-fixture', 'revision': 'test-only', 'backend': 'fixture', 'location': 'local'}
for line in sys.stdin:
    try:
        request = json.loads(line)
        operation = request['operation']
        if operation == 'generate':
            prompt = json.dumps(request.get('messages', []))
            if 'TEST Slow' in prompt:
                time.sleep(30)
            result = {'text': json.dumps(signal) if request.get('task') == 'extraction' else 'Synthetic draft for API verification only.', 'provenance': provenance}
        elif operation == 'image':
            if request['image_base64'] == 'RkFJTA==':
                raise ValueError('Synthetic failed image')
            result = {'flagged': True, 'top_pattern': 'test-only', 'classifications': [], 'score_type': 'cosine_similarity', 'provenance': provenance}
        elif operation == 'transcribe':
            result = {'transcription': 'Synthetic reviewed dictation.', 'requires_review': True, 'provenance': provenance}
        elif operation == 'cough':
            result = {'classification': 'test-only', 'confidence': .5, 'probabilities': {'test-only': .5}, 'provenance': provenance}
        else:
            result = {'unloaded': True}
        print(json.dumps({'result': result}), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error), 'error_type': type(error).__name__}), flush=True)
