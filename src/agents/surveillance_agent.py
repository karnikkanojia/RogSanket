"""
Surveillance Analytics Agent: Aggregate signals → Detect anomalies → Generate reports

Takes individual syndromic signals from the Intake Agent, aggregates them
over time and space, detects anomalies using CUSUM/Poisson methods, and
uses MedGemma 27B to generate epidemiological situation reports.
"""

import json
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from typing import Optional
from collections import defaultdict
from loguru import logger

from src.data.syndromic_schema import (
    SyndromicSignal,
    ClinicalEncounter,
    SurveillanceAlert,
)
from src.models.medgemma_loader import generate_text
from src.utils.anomaly_detection import cusum_detect, poisson_test


SITUATION_REPORT_PROMPT = """You are an epidemiologist analyzing syndromic surveillance data for a \
health district. Generate a concise situation report based on the following data.

## Current Surveillance Data
{surveillance_data}

## Instructions
Generate a situation report with:
1. **Situation Summary**: 2-3 sentence overview of the epidemiological situation
2. **Key Findings**: What syndromes are elevated and by how much
3. **Risk Assessment**: Likelihood of an outbreak (low/moderate/high) with reasoning
4. **Recommended Actions**: 3-5 specific, actionable recommendations for district health officers
5. **Evidence Summary**: Key data points supporting your assessment

Be specific, use numbers, and prioritize actionable intelligence. Write for a public health professional."""


class SurveillanceDatabase:
    """
    In-memory database for syndromic signals with temporal aggregation.
    In production, this would be SQLite/PostgreSQL. For the demo, we keep it in memory.
    """

    def __init__(self):
        self.encounters: list[ClinicalEncounter] = []
        self.signals: list[SyndromicSignal] = []
        self._signal_timestamps: list[datetime] = []
        self._signal_districts: list[str] = []
        self._signal_syndromes: list[str] = []

    def add_encounter(self, encounter: ClinicalEncounter):
        """Add a processed encounter to the database."""
        self.encounters.append(encounter)
        if encounter.syndromic_signal:
            self.signals.append(encounter.syndromic_signal)
            self._signal_timestamps.append(encounter.timestamp)
            self._signal_districts.append(encounter.district or "unknown")
            self._signal_syndromes.append(encounter.syndromic_signal.syndrome_category)

    def get_weekly_counts(
        self,
        syndrome: Optional[str] = None,
        district: Optional[str] = None,
        weeks_back: int = 12,
    ) -> pd.DataFrame:
        """
        Get weekly syndrome counts, optionally filtered by syndrome and district.
        
        Returns DataFrame with columns: [week_start, syndrome, district, count]
        """
        if not self._signal_timestamps:
            return pd.DataFrame(columns=["week_start", "syndrome", "district", "count"])

        df = pd.DataFrame({
            "timestamp": self._signal_timestamps,
            "syndrome": self._signal_syndromes,
            "district": self._signal_districts,
        })

        # Filter
        if syndrome:
            df = df[df["syndrome"] == syndrome]
        if district:
            df = df[df["district"] == district]

        # Filter by time
        cutoff = datetime.now() - timedelta(weeks=weeks_back)
        df = df[df["timestamp"] >= cutoff]

        if df.empty:
            return pd.DataFrame(columns=["week_start", "syndrome", "district", "count"])

        # Weekly aggregation
        df["week_start"] = df["timestamp"].dt.to_period("W").dt.start_time
        counts = (
            df.groupby(["week_start", "syndrome", "district"])
            .size()
            .reset_index(name="count")
        )
        return counts.sort_values("week_start")

    def get_current_week_count(
        self,
        syndrome: str,
        district: Optional[str] = None,
    ) -> int:
        """Get count for the current week."""
        now = datetime.now()
        week_start = now - timedelta(days=now.weekday())
        week_start = week_start.replace(hour=0, minute=0, second=0, microsecond=0)

        count = 0
        for ts, syn, dist in zip(
            self._signal_timestamps, self._signal_syndromes, self._signal_districts
        ):
            if ts >= week_start and syn == syndrome:
                if district is None or dist == district:
                    count += 1
        return count

    def get_baseline_mean(
        self,
        syndrome: str,
        district: Optional[str] = None,
        baseline_weeks: int = 8,
    ) -> float:
        """Calculate baseline weekly mean for a syndrome."""
        counts = self.get_weekly_counts(syndrome, district, weeks_back=baseline_weeks + 1)
        if counts.empty:
            return 0.0
        # Exclude the most recent week
        if len(counts) > 1:
            baseline = counts.iloc[:-1]["count"].mean()
        else:
            baseline = counts["count"].mean()
        return baseline

    @property
    def total_encounters(self) -> int:
        return len(self.encounters)

    @property
    def syndrome_distribution(self) -> dict[str, int]:
        from collections import Counter
        return dict(Counter(self._signal_syndromes))


class SurveillanceAgent:
    """
    Analyzes aggregated syndromic data, detects anomalies, generates situation reports.
    Uses MedGemma 27B for epidemiological reasoning and report generation.
    """

    def __init__(
        self,
        database: SurveillanceDatabase,
        model_27b=None,
        processor_27b=None,
        model_4b=None,
        processor_4b=None,
        alert_config: dict = None,
    ):
        """
        Args:
            database: SurveillanceDatabase instance
            model_27b: MedGemma 27B model (for full analysis)
            processor_27b: MedGemma 27B processor
            model_4b: MedGemma 4B model (fallback for edge mode)
            processor_4b: MedGemma 4B processor
            alert_config: Alert threshold configuration
        """
        self.db = database
        self.model_27b = model_27b
        self.processor_27b = processor_27b
        self.model_4b = model_4b
        self.processor_4b = processor_4b
        self.alert_config = alert_config or {}

    def scan_for_anomalies(
        self,
        districts: Optional[list[str]] = None,
    ) -> list[SurveillanceAlert]:
        """
        Scan all syndromes across districts for anomalies.
        
        Returns list of alerts where thresholds are exceeded.
        """
        alerts = []
        syndromes = [
            "acute_watery_diarrhea", "acute_bloody_diarrhea",
            "acute_febrile_illness", "acute_respiratory_infection",
            "acute_neurological_syndrome", "acute_rash_fever",
            "acute_hemorrhagic_fever", "unexplained_cluster",
        ]

        if districts is None:
            districts = list(set(self.db._signal_districts))

        for district in districts:
            for syndrome in syndromes:
                current = self.db.get_current_week_count(syndrome, district)
                baseline = self.db.get_baseline_mean(syndrome, district)

                if current == 0:
                    continue

                # Get threshold from config
                threshold_mult = self.alert_config.get(
                    syndrome, {}
                ).get("alert_threshold_multiplier", 2.0)
                min_cases = self.alert_config.get(
                    syndrome, {}
                ).get("minimum_cases_for_alert", 3)

                ratio = current / max(baseline, 0.1)

                # Determine alert level
                alert_level = None
                if current >= min_cases and ratio >= threshold_mult * 2:
                    alert_level = "emergency"
                elif current >= min_cases and ratio >= threshold_mult:
                    alert_level = "warning"
                elif current >= min_cases and ratio >= threshold_mult * 0.75:
                    alert_level = "watch"

                # Special: hemorrhagic fever and neurological — any case triggers
                if syndrome in ("acute_hemorrhagic_fever", "acute_neurological_syndrome"):
                    if current >= 1:
                        alert_level = alert_level or "warning"

                if alert_level:
                    # Get time series for trend analysis
                    weekly = self.db.get_weekly_counts(syndrome, district, weeks_back=8)
                    if len(weekly) >= 3:
                        recent_counts = weekly["count"].values[-3:]
                        if recent_counts[-1] > recent_counts[-2] > recent_counts[-3]:
                            trend = "increasing"
                        elif recent_counts[-1] < recent_counts[-2]:
                            trend = "decreasing"
                        else:
                            trend = "stable"
                        weeks_above = sum(1 for c in weekly["count"].values if c > baseline * threshold_mult)
                    else:
                        trend = "insufficient_data"
                        weeks_above = 0

                    import uuid
                    alert = SurveillanceAlert(
                        alert_id=str(uuid.uuid4())[:8],
                        alert_level=alert_level,
                        syndrome_category=syndrome,
                        district=district,
                        case_count_current_week=current,
                        case_count_baseline=round(baseline, 1),
                        ratio_to_baseline=round(ratio, 2),
                        trend=trend,
                        weeks_above_threshold=weeks_above,
                        situation_summary="",  # Filled by MedGemma 27B
                        recommended_actions=[],
                        evidence_summary="",
                        timestamp=datetime.now(),
                    )
                    alerts.append(alert)

        logger.info(f"Anomaly scan: {len(alerts)} alerts across {len(districts)} districts")
        return alerts

    def generate_situation_report(
        self,
        district: str,
        alerts: list[SurveillanceAlert],
    ) -> str:
        """
        Generate a natural-language situation report using MedGemma 27B.
        Falls back to MedGemma 4B if 27B is not available (edge mode).
        """
        # Build surveillance data summary for the prompt
        surveillance_data = self._build_data_summary(district, alerts)

        prompt = SITUATION_REPORT_PROMPT.format(surveillance_data=surveillance_data)

        messages = [
            {"role": "user", "content": prompt},
        ]

        # Use 27B if available, else fallback to 4B
        model = self.model_27b or self.model_4b
        proc = self.processor_27b or self.processor_4b

        if model is None:
            logger.warning("No model available for report generation.")
            return self._generate_template_report(district, alerts)

        report = generate_text(
            model, proc, messages,
            max_new_tokens=2048,
            temperature=0.3,
            do_sample=True,
        )

        # Also update the alerts with generated content
        for alert in alerts:
            alert_prompt = (
                f"For this alert — {alert.syndrome_category} in {alert.district}: "
                f"{alert.case_count_current_week} cases this week vs baseline of "
                f"{alert.case_count_baseline}. Trend: {alert.trend}. "
                f"Provide: 1) One-sentence situation summary. "
                f"2) Top 3 recommended actions as a JSON list. "
                f"3) Brief evidence summary."
            )
            try:
                alert_response = generate_text(
                    model, proc,
                    [{"role": "user", "content": alert_prompt}],
                    max_new_tokens=512,
                    temperature=0.2,
                )
                alert.situation_summary = alert_response[:500]
                alert.recommended_actions = self._extract_actions(alert_response)
                alert.evidence_summary = f"Current: {alert.case_count_current_week}, Baseline: {alert.case_count_baseline}, Ratio: {alert.ratio_to_baseline}x"
            except Exception as e:
                logger.warning(f"Alert enrichment failed: {e}")
                alert.situation_summary = f"{alert.syndrome_category} elevated {alert.ratio_to_baseline}x above baseline in {alert.district}"
                alert.recommended_actions = ["Investigate cluster", "Enhance surveillance", "Prepare response capacity"]

        return report

    def _build_data_summary(self, district: str, alerts: list[SurveillanceAlert]) -> str:
        """Build a structured data summary for the LLM prompt."""
        lines = [
            f"District: {district}",
            f"Report Date: {datetime.now().strftime('%Y-%m-%d')}",
            f"Total encounters this period: {self.db.total_encounters}",
            f"Active alerts: {len(alerts)}",
            "",
            "Syndrome | Current Week | Baseline | Ratio | Trend | Alert Level",
            "---------|-------------|----------|-------|-------|------------",
        ]

        for alert in alerts:
            lines.append(
                f"{alert.syndrome_category} | {alert.case_count_current_week} | "
                f"{alert.case_count_baseline} | {alert.ratio_to_baseline}x | "
                f"{alert.trend} | {alert.alert_level.upper()}"
            )

        # Add overall syndrome distribution
        dist = self.db.syndrome_distribution
        lines.extend([
            "",
            "Overall syndrome distribution (all time):",
        ])
        for syn, count in sorted(dist.items(), key=lambda x: -x[1]):
            lines.append(f"  - {syn}: {count} cases")

        return "\n".join(lines)

    def _generate_template_report(
        self, district: str, alerts: list[SurveillanceAlert]
    ) -> str:
        """Fallback template-based report when no LLM is available."""
        report_lines = [
            f"# Epidemiological Situation Report — {district}",
            f"Date: {datetime.now().strftime('%Y-%m-%d %H:%M')}",
            "",
            "## Active Alerts",
        ]
        for alert in alerts:
            report_lines.append(
                f"- **{alert.alert_level.upper()}**: {alert.syndrome_category} — "
                f"{alert.case_count_current_week} cases this week "
                f"({alert.ratio_to_baseline}x baseline, trend: {alert.trend})"
            )
        report_lines.append("")
        report_lines.append("## Recommended Actions")
        report_lines.append("- Investigate reported clusters immediately")
        report_lines.append("- Enhance case-based surveillance for elevated syndromes")
        report_lines.append("- Prepare outbreak response teams and supplies")
        return "\n".join(report_lines)

    @staticmethod
    def _extract_actions(text: str) -> list[str]:
        """Try to extract action items from LLM response."""
        # Simple extraction — look for numbered items or bullet points
        actions = []
        for line in text.split("\n"):
            line = line.strip()
            if line and (line[0].isdigit() or line.startswith("-") or line.startswith("•")):
                # Clean up
                clean = line.lstrip("0123456789.-•) ").strip()
                if clean and len(clean) > 10:
                    actions.append(clean)
        return actions[:5] if actions else ["Investigate", "Enhance surveillance", "Prepare response"]
