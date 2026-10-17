"""
FHIR (Fast Healthcare Interoperability Resources) report generation utilities.
Generates FHIR R4 compatible surveillance report bundles.
"""

import uuid
from datetime import datetime
from typing import Optional


def create_fhir_bundle(bundle_type: str = "collection") -> dict:
    """Create a basic FHIR Bundle shell."""
    return {
        "resourceType": "Bundle",
        "id": str(uuid.uuid4()),
        "type": bundle_type,
        "timestamp": datetime.now().isoformat() + "Z",
        "entry": [],
    }


def create_observation(
    code: str,
    display: str,
    value: int,
    unit: str = "cases",
    period_start: Optional[str] = None,
    period_end: Optional[str] = None,
    system: str = "http://epicast.surveillance/syndromes",
) -> dict:
    """Create a FHIR Observation resource for a syndrome count."""
    obs = {
        "resource": {
            "resourceType": "Observation",
            "id": str(uuid.uuid4()),
            "status": "final",
            "code": {
                "coding": [{
                    "system": system,
                    "code": code,
                    "display": display,
                }]
            },
            "valueQuantity": {
                "value": value,
                "unit": unit,
                "system": "http://unitsofmeasure.org",
            },
        }
    }
    if period_start and period_end:
        obs["resource"]["effectivePeriod"] = {
            "start": period_start,
            "end": period_end,
        }
    return obs


def create_communication(
    alert_level: str,
    syndrome: str,
    district: str,
    message: str,
) -> dict:
    """Create a FHIR Communication resource for an alert."""
    return {
        "resource": {
            "resourceType": "Communication",
            "id": str(uuid.uuid4()),
            "status": "completed",
            "category": [{
                "coding": [{
                    "system": "http://epicast.surveillance/alert-level",
                    "code": alert_level,
                    "display": f"{alert_level.upper()} Alert",
                }]
            }],
            "payload": [{
                "contentString": message,
            }],
            "sent": datetime.now().isoformat() + "Z",
        }
    }
