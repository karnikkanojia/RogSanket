"""Freeze model-free Python server behavior for Swift migration regression tests.

Synthetic records only. No clinical accuracy claims or model execution.
"""
import json
import math
from pathlib import Path
import random
import sys
from datetime import datetime, timedelta
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import yaml
from src.agents.surveillance_agent import SurveillanceAgent, SurveillanceDatabase
from src.data.syndromic_schema import ClinicalEncounter, SyndromicSignal
from src.utils.anomaly_detection import cusum_detect, poisson_test, ears_c1

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'native/Server/Tests/ServerCoreTests/Fixtures'


def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return 'Infinity' if value > 0 else ('-Infinity' if value < 0 else 'NaN')
    # numpy scalars are not all directly serializable.
    if hasattr(value, 'item'):
        return clean(value.item())
    return value


def main():
    OUTPUT.mkdir(parents=True, exist_ok=True)
    config = yaml.safe_load((ROOT / 'configs/surveillance_config.yaml').read_text())['syndromic_categories']
    cases = []
    for index, now in enumerate((datetime(2026, 10, 18, 12), datetime(2026, 10, 19, 0), datetime(2027, 1, 1, 12), datetime(2026, 3, 30, 12))):
        random.seed(42 + index)
        database = SurveillanceDatabase()
        for syndrome in config:
            for district in ('TEST North', 'TEST South'):
                for weeks, number in ((10, 2), (8, 1), (6, 2), (3, 3), (2, 1), (1, 2), (0, random.randint(1, 18))):
                    for item in range(number):
                        signal = SyndromicSignal(symptoms=['fever'], syndrome_category=syndrome, severity='moderate', age_group='adult', icd10_codes=['R50'], confidence_score=.8)
                        database.add_encounter(ClinicalEncounter(encounter_id=f'{syndrome}-{district}-{weeks}-{item}', timestamp=now-timedelta(weeks=weeks), district=district, facility_name='TEST Clinic', narrative_text='', syndromic_signal=signal))
        class FrozenDate(datetime):
            @classmethod
            def now(cls, tz=None):
                return now
        with patch('src.agents.surveillance_agent.datetime', FrozenDate):
            alerts = SurveillanceAgent(database, alert_config=config).scan_for_anomalies()
        cases.append({'now': now.isoformat(), 'records': [record.model_dump(mode='json') for record in database.encounters],
                      'alerts': [alert.model_dump(mode='json') for alert in sorted(alerts, key=lambda a: a.alert_id)]})
    stats = []
    for counts in ([], [0], [2, 2, 3, 2, 1, 2, 2, 14], [5]*8 + [20, 22, 35], [0]*8 + [1], [1000]*8 + [1100]):
        mean = sum(counts[:-1]) / max(1, len(counts)-1)
        stats.append({'counts': counts, 'mean': mean, 'cusum': clean(cusum_detect(counts, mean)),
                      'ears': clean(ears_c1(counts)), 'poisson': clean(poisson_test(counts[-1] if counts else 0, mean))})
    (OUTPUT / 'surveillance.json').write_text(json.dumps(cases, indent=2, allow_nan=False)+'\n')
    (OUTPUT / 'statistics.json').write_text(json.dumps(stats, indent=2, allow_nan=False)+'\n')
    print(f'Exported {len(cases)} surveillance cases and {len(stats)} statistical cases')


if __name__ == '__main__':
    main()
