"""
Alert & Escalation Agent: Generate alerts, FHIR reports, and patient advisories.

Takes surveillance alerts and generates:
1. Structured alerts for district health officers
2. FHIR-compatible surveillance reports
3. Patient-facing health advisories (multilingual via MedGemma)
"""

import json
from datetime import datetime, timedelta
from typing import Optional
from loguru import logger

from src.data.syndromic_schema import SurveillanceAlert, FHIRSurveillanceReport
from src.models.medgemma_loader import generate_text


class AlertAgent:
    """
    Generates and manages escalation alerts, FHIR reports, and health advisories.
    """

    def __init__(self, model=None, processor=None):
        """
        Args:
            model: MedGemma model (27B preferred, 4B fallback)
            processor: Corresponding processor
        """
        self.model = model
        self.processor = processor

    def generate_health_advisory(
        self,
        alert: SurveillanceAlert,
        language: str = "english",
        audience: str = "community",
    ) -> str:
        """
        Generate a patient/community-facing health advisory.
        
        Args:
            alert: The surveillance alert triggering the advisory
            language: Target language for the advisory
            audience: "community", "health_worker", or "official"
        
        Returns:
            Advisory text in the requested language
        """
        if self.model is None:
            return self._template_advisory(alert)

        audience_instructions = {
            "community": "Write for community members with basic health literacy. Use simple language, avoid medical jargon, and focus on what people should DO.",
            "health_worker": "Write for community health workers. Include clinical guidance, case definitions, and reporting instructions.",
            "official": "Write for district health officers. Include epidemiological data, resource needs, and coordination requirements.",
        }

        prompt = (
            f"Generate a health advisory for the following situation:\n\n"
            f"Alert: {alert.syndrome_category.replace('_', ' ').title()}\n"
            f"District: {alert.district}\n"
            f"Current cases: {alert.case_count_current_week} this week "
            f"(baseline: {alert.case_count_baseline})\n"
            f"Alert level: {alert.alert_level.upper()}\n"
            f"Trend: {alert.trend}\n\n"
            f"Audience: {audience_instructions.get(audience, audience_instructions['community'])}\n"
            f"Language: {language}\n\n"
            f"Include: 1) What is happening, 2) What are the risks, "
            f"3) What should people do to protect themselves, "
            f"4) When to seek medical care, 5) Where to get help.\n\n"
            f"Keep it concise (under 300 words)."
        )

        messages = [{"role": "user", "content": prompt}]

        try:
            advisory = generate_text(
                self.model, self.processor, messages,
                max_new_tokens=1024,
                temperature=0.3,
            )
            return advisory
        except Exception as e:
            logger.error(f"Advisory generation failed: {e}")
            return self._template_advisory(alert)

    def generate_fhir_report(
        self,
        district: str,
        period_start: datetime,
        period_end: datetime,
        syndrome_counts: dict[str, int],
        alerts: list[SurveillanceAlert],
        facility_name: str = "District Surveillance System",
    ) -> dict:
        """
        Generate a FHIR-compatible surveillance report bundle.
        
        Returns a simplified FHIR Bundle structure suitable for integration
        with national surveillance systems.
        """
        import uuid

        # Generate narrative summary
        narrative = self._generate_narrative(district, syndrome_counts, alerts)

        report = {
            "resourceType": "Bundle",
            "id": str(uuid.uuid4()),
            "type": "collection",
            "timestamp": datetime.now().isoformat(),
            "meta": {
                "profile": ["http://hl7.org/fhir/StructureDefinition/Bundle"],
            },
            "entry": [],
        }

        # Composition entry (the report itself)
        composition = {
            "resource": {
                "resourceType": "Composition",
                "id": str(uuid.uuid4()),
                "status": "final",
                "type": {
                    "coding": [{
                        "system": "http://loinc.org",
                        "code": "55751-2",
                        "display": "Public health Case report",
                    }]
                },
                "date": datetime.now().isoformat(),
                "title": f"Syndromic Surveillance Report - {district}",
                "author": [{"display": facility_name}],
                "section": [
                    {
                        "title": "Surveillance Period",
                        "text": {
                            "status": "generated",
                            "div": f"<div>Period: {period_start.strftime('%Y-%m-%d')} to {period_end.strftime('%Y-%m-%d')}</div>",
                        },
                    },
                    {
                        "title": "Syndromic Summary",
                        "text": {
                            "status": "generated",
                            "div": f"<div>{narrative}</div>",
                        },
                    },
                ],
            }
        }
        report["entry"].append(composition)

        # Observation entries for each syndrome count
        for syndrome, count in syndrome_counts.items():
            observation = {
                "resource": {
                    "resourceType": "Observation",
                    "id": str(uuid.uuid4()),
                    "status": "final",
                    "code": {
                        "coding": [{
                            "system": "http://epicast.surveillance/syndromes",
                            "code": syndrome,
                            "display": syndrome.replace("_", " ").title(),
                        }]
                    },
                    "valueQuantity": {
                        "value": count,
                        "unit": "cases",
                    },
                    "effectivePeriod": {
                        "start": period_start.isoformat(),
                        "end": period_end.isoformat(),
                    },
                }
            }
            report["entry"].append(observation)

        # DetectedIssue entries for alerts
        for alert in alerts:
            issue = {
                "resource": {
                    "resourceType": "DetectedIssue",
                    "id": alert.alert_id,
                    "status": "final",
                    "code": {
                        "coding": [{
                            "system": "http://epicast.surveillance/alerts",
                            "code": alert.alert_level,
                            "display": f"{alert.alert_level.upper()} - {alert.syndrome_category}",
                        }]
                    },
                    "detail": alert.situation_summary or f"{alert.syndrome_category} elevated in {alert.district}",
                    "identifiedDateTime": alert.timestamp.isoformat(),
                }
            }
            report["entry"].append(issue)

        return report

    def _generate_narrative(
        self,
        district: str,
        syndrome_counts: dict[str, int],
        alerts: list[SurveillanceAlert],
    ) -> str:
        """Generate narrative summary for FHIR report."""
        total = sum(syndrome_counts.values())
        top_syndrome = max(syndrome_counts, key=syndrome_counts.get) if syndrome_counts else "none"

        narrative = (
            f"Syndromic surveillance report for {district}. "
            f"Total encounters: {total}. "
            f"Most common syndrome: {top_syndrome.replace('_', ' ')} "
            f"({syndrome_counts.get(top_syndrome, 0)} cases). "
        )

        if alerts:
            alert_levels = [a.alert_level for a in alerts]
            if "emergency" in alert_levels:
                narrative += f"EMERGENCY alerts active for {len([a for a in alerts if a.alert_level == 'emergency'])} syndrome(s). "
            elif "warning" in alert_levels:
                narrative += f"WARNING alerts for {len([a for a in alerts if a.alert_level == 'warning'])} syndrome(s). "

        return narrative

    def _template_advisory(self, alert: SurveillanceAlert) -> str:
        """Fallback template advisory when no LLM is available."""
        syndrome_name = alert.syndrome_category.replace("_", " ").title()
        return (
            f"HEALTH ADVISORY — {alert.district}\n\n"
            f"An increase in {syndrome_name} cases has been detected in your area. "
            f"This week: {alert.case_count_current_week} cases (normally ~{alert.case_count_baseline}).\n\n"
            f"WHAT TO DO:\n"
            f"- Wash hands frequently with soap and water\n"
            f"- Seek medical care if you develop symptoms\n"
            f"- Report any sick individuals to your community health worker\n"
            f"- Follow instructions from health authorities\n\n"
            f"Visit your nearest health facility if you feel unwell."
        )
