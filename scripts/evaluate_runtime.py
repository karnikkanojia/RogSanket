"""Evaluate frozen encounter/extraction fixtures against the canonical API.

Every failed request contributes zero to quality metrics. Synthetic fixtures are
useful regression data, not evidence of clinical validation.
"""
import argparse
import json
from pathlib import Path
import httpx

METRICS = ('schema_valid', 'syndrome_accuracy', 'severity_accuracy', 'symptom_f1', 'reportable_recall')


def score(prediction, expected):
    if prediction is None:
        return dict.fromkeys(METRICS, 0.0)
    def overlap(field, recall=False):
        left, right = set(prediction.get(field, [])), set(expected.get(field, []))
        if recall:
            return len(left & right) / len(right) if right else 1.0
        return 2 * len(left & right) / (len(left) + len(right)) if left or right else 1.0
    return {'schema_valid': 1.0,
            'syndrome_accuracy': float(prediction['syndrome_category'] == expected['syndrome_category']),
            'severity_accuracy': float(prediction['severity'] == expected['severity']),
            'symptom_f1': overlap('symptoms'),
            'reportable_recall': overlap('reportable_conditions_flagged', True)}


def main(args):
    fixtures = [json.loads(line) for line in Path(args.fixtures).read_text().splitlines() if line.strip()]
    rows = []
    with httpx.Client(base_url=args.url, timeout=190) as client:
        for item in fixtures:
            try:
                response = client.post('/encounter', json={'narrative': item['narrative'], 'district': 'Evaluation'})
                response.raise_for_status()
                prediction = response.json()['syndromic_signal']
                rows.append(score(prediction, item['extraction']))
            except (httpx.HTTPError, ValueError, KeyError):
                rows.append(score(None, item['extraction']))
    if not rows:
        raise ValueError('No evaluation examples')
    summary = {metric: sum(row[metric] for row in rows) / len(rows) for metric in METRICS}
    baseline = json.loads(Path(args.reference).read_text())['summary'] if args.reference else None
    passed = summary['schema_valid'] >= .99 and baseline is not None and all(
        summary[metric] >= baseline[metric] - .02 for metric in ('syndrome_accuracy', 'symptom_f1', 'reportable_recall'))
    result = {'summary': summary, 'count': len(rows), 'reference_compared': baseline is not None, 'passed': passed}
    Path(args.output).write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return 0 if passed else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:8000')
    parser.add_argument('--fixtures', default='data/evaluation_frozen.jsonl')
    parser.add_argument('--reference')
    parser.add_argument('--output', default='evaluation-results.json')
    raise SystemExit(main(parser.parse_args()))
