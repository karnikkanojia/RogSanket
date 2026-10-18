"""Application workflows shared by web, RunPod adapter, and native clients."""
import asyncio
import hashlib
import json
import time
import uuid
from datetime import datetime
from src.agents.intake_agent import SYSTEM_PROMPT
from src.agents.surveillance_agent import SurveillanceAgent, SITUATION_REPORT_PROMPT
from src.agents.alert_agent import AlertAgent
from src.data.syndromic_schema import SyndromicSignal, ClinicalEncounter


class Service:
    def __init__(self, settings, store, scheduler):
        self.settings, self.store, self.scheduler = settings, store, scheduler
        from pathlib import Path
        import yaml
        config = yaml.safe_load((Path(__file__).resolve().parents[2] / "configs/surveillance_config.yaml").read_text())
        self.surveillance = SurveillanceAgent(store, alert_config=config.get("syndromic_categories", {}))
        self.alerts = AlertAgent()

    async def generate(self, task, messages, max_tokens=512, images=None):
        return await self.scheduler.run({"operation": "generate", "task": task,
            "messages": messages, "max_tokens": max_tokens, "temperature": 0.0,
            "images": images or []})

    async def extract(self, narrative):
        messages = [{"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": narrative}]
        for attempt in range(2):
            result = await self.generate("extraction", messages)
            start = time.monotonic()
            try:
                text = result["text"].strip()
                if text.startswith("```"):
                    text = text.split("\n", 1)[1].rsplit("```", 1)[0]
                signal = SyndromicSignal.model_validate_json(text)
                if signal.syndrome_category not in {
                    "acute_watery_diarrhea", "acute_bloody_diarrhea", "acute_febrile_illness",
                    "acute_respiratory_infection", "acute_neurological_syndrome", "acute_rash_fever",
                    "acute_hemorrhagic_fever", "unexplained_cluster",
                }:
                    raise ValueError("Unknown syndrome category")
                result["provenance"]["validation_seconds"] = time.monotonic() - start
                return signal, result["provenance"]
            except (ValueError, json.JSONDecodeError):
                if attempt:
                    raise RuntimeError("Extraction failed schema validation after one retry") from None
                messages += [{"role": "assistant", "content": result["text"]},
                             {"role": "user", "content": "Return only valid JSON matching the required schema."}]

    async def encounter(self, payload, extracted=None):
        signal, provenance = extracted or await self.extract(payload["narrative"])
        encounter = ClinicalEncounter(
            encounter_id=str(uuid.uuid4()), timestamp=datetime.now(),
            district=payload.get("district"), facility_name=payload.get("facility_name"),
            narrative_text="", syndromic_signal=signal,
        )
        self.store.add_encounter(encounter, provenance)
        return {"encounter_id": encounter.encounter_id, "timestamp": encounter.timestamp.isoformat(),
                "syndromic_signal": signal.model_dump(mode="json"),
                "total_encounters": self.store.total_encounters, "provenance": provenance}

    def summary(self, district):
        encounters = [e for e in self.store.encounters if e.district == district]
        from collections import Counter
        counts = dict(Counter(e.syndromic_signal.syndrome_category for e in encounters if e.syndromic_signal))
        alerts = self.surveillance.scan_for_anomalies(districts=[district])
        # Construct an allowlist instead of serializing encounter objects to remote services.
        evidence = [{"syndrome": a.syndrome_category, "level": a.alert_level,
                     "current_cases": a.case_count_current_week, "baseline": a.case_count_baseline,
                     "ratio": a.ratio_to_baseline, "trend": a.trend} for a in alerts]
        return {"district": district, "date": datetime.now().date().isoformat(),
                "encounters": len(encounters), "counts": counts, "alerts": evidence}, alerts

    async def report(self, district, max_tokens=1024, refresh=False):
        summary, alerts = self.summary(district)
        identity = {"summary": summary, "artifact": self.settings.artifact,
                    "remote": self.settings.remote_url, "prompt_version": 1, "max_tokens": max_tokens}
        # Include manifest identity so revision or quantization changes invalidate cached reports.
        if self.settings.artifact:
            from pathlib import Path
            path = Path(self.settings.artifact) / "epicast-artifact.json"
            if path.exists():
                identity["manifest"] = path.read_text()
        key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        cached = self.store.cached_report(key)
        if cached and not refresh:
            return cached
        prompt = SITUATION_REPORT_PROMPT.format(surveillance_data=json.dumps(summary))
        prompt += "\nInclude alert summaries and actions in this single report. Recommendations are drafts. Do not invent forecasts or missing evidence."
        remote_error = None
        if self.settings.remote_url:
            try:
                import httpx
                headers = {}
                import os
                if os.getenv("EPICAST_REMOTE_TOKEN"):
                    headers["Authorization"] = "Bearer " + os.environ["EPICAST_REMOTE_TOKEN"]
                async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
                    response = await client.post(self.settings.remote_url, headers=headers, json={
                        "model": self.settings.remote_model,
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": max_tokens, "temperature": 0,
                    })
                    response.raise_for_status()
                    body = response.json()
                    result = {"text": body["choices"][0]["message"]["content"], "provenance": {
                        "model": body.get("model", self.settings.remote_model), "location": "remote",
                        "backend": "openai-compatible", "revision": body.get("system_fingerprint")}}
            except Exception:
                remote_error = "Remote 27B unavailable; local 4B fallback used"
        if not self.settings.remote_url or remote_error:
            result = await self.generate("report", [{"role": "user", "content": prompt}], max_tokens)
        response = {"district": district, "report_time": datetime.now().isoformat(),
                    "report": result["text"], "alerts": [a.model_dump(mode="json") for a in alerts],
                    "provenance": result["provenance"], "draft": True, "fallback_reason": remote_error}
        self.store.save_report(key, response)
        return response

    async def image(self, payload):
        result = await self.scheduler.run(dict(payload, operation="image"))
        if result["flagged"]:
            analysis = await self.generate("image_analysis", [{"role": "user", "content":
                "Describe clinical image findings relevant to syndromic surveillance. " + payload.get("clinical_context", "")}],
                images=[payload["image_base64"]])
            result["medgemma_analysis"] = analysis["text"]
            result["analysis_provenance"] = analysis["provenance"]
        return result

    async def multimodal(self, payload):
        # Extract exactly once, then persist only after requested modalities succeed.
        extracted = await self.extract(payload["narrative"])
        result = {"text": extracted[0].model_dump(mode="json")}
        if payload.get("audio_base64"):
            result["cough"] = await self.scheduler.run({"operation": "cough", "audio_base64": payload["audio_base64"]})
        if payload.get("image_base64"):
            result["image"] = await self.image({"image_base64": payload["image_base64"],
                                               "clinical_context": payload["narrative"]})
        result["encounter"] = await self.encounter(payload, extracted)
        return result
