"""FastAPI rollback/reference service. The default application server is Swift."""
import asyncio
import base64
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
import json
import os
import time
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from src.runtime.config import Settings
from src.runtime.scheduler import Scheduler, QueueFull
from src.runtime.storage import Store
from src.runtime.service import Service
from src.runtime.jobs import Jobs
from src.runtime.memory import snapshot


@asynccontextmanager
async def lifespan(app):
    settings = Settings.from_env()
    store = Store(settings.database)
    scheduler = Scheduler(settings)
    await scheduler.start()
    app.state.settings = settings
    app.state.store = store
    app.state.scheduler = scheduler
    app.state.service = Service(settings, store, scheduler)
    app.state.jobs = Jobs(store)
    try:
        yield
    finally:
        await app.state.jobs.close()
        await scheduler.close()
        store.close()


app = FastAPI(title="EpiCast API", version="2.0.0", lifespan=lifespan)


@app.exception_handler(QueueFull)
async def queue_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=429, headers={"Retry-After": "5"})


@app.exception_handler(MemoryError)
async def memory_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=503, headers={"Retry-After": "10"})


@app.exception_handler(RuntimeError)
async def runtime_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=503)


@app.exception_handler(TimeoutError)
async def timeout_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=504)


@app.exception_handler(ValueError)
async def value_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=422)


class EncounterRequest(BaseModel):
    narrative: str = Field(min_length=1, max_length=16000)
    district: Optional[str] = Field(None, max_length=200)
    facility_name: Optional[str] = Field(None, max_length=200)
    latitude: Optional[float] = None
    longitude: Optional[float] = None

    @field_validator("narrative")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("Narrative is empty")
        return value


class AudioRequest(BaseModel):
    audio_base64: str = Field(max_length=16_000_000)
    format: str = "wav"

    @field_validator("audio_base64")
    @classmethod
    def valid_base64(cls, value):
        if not base64.b64decode(value, validate=True):
            raise ValueError("Audio is empty")
        return value


class ImageRequest(BaseModel):
    image_base64: str = Field(max_length=16_000_000)
    clinical_context: str = Field("", max_length=16000)

    @field_validator("image_base64")
    @classmethod
    def valid_base64(cls, value):
        if not base64.b64decode(value, validate=True):
            raise ValueError("Image is empty")
        return value


class MultimodalRequest(EncounterRequest):
    audio_base64: Optional[str] = Field(None, max_length=16_000_000)
    image_base64: Optional[str] = Field(None, max_length=16_000_000)


class ReportRequest(BaseModel):
    district: str = Field(min_length=1, max_length=200)
    max_tokens: int = Field(1024, ge=1, le=1024)
    refresh: bool = False


class AdvisoryRequest(BaseModel):
    alert_id: str
    language: str = Field("english", max_length=100)
    audience: str = Field("community", max_length=100)


def ready(variable):
    from pathlib import Path
    root = os.getenv(variable, "")
    return bool(root and (Path(root) / "epicast-artifact.json").is_file())


@app.get("/health")
async def health(request: Request):
    status = request.app.state.scheduler.status()
    modalities = {"text": ready("EPICAST_ARTIFACT"), "image": ready("EPICAST_MEDSIGLIP_ARTIFACT"),
                  "transcription": ready("EPICAST_MEDASR_ARTIFACT"), "cough": ready("EPICAST_HEAR_ARTIFACT")}
    return {"status": "ok", "initialized": status["worker_loaded"],
            "total_encounters": request.app.state.store.total_encounters,
            "runtime": status, "memory": snapshot(),
            "artifacts_present": modalities,
            "release_validated": False,
            "readiness_note": "Artifact presence is not validation. Execution verifies checksums and parity gates."}


@app.post("/encounter")
async def encounter(payload: EncounterRequest, request: Request):
    return await request.app.state.service.encounter(payload.model_dump())


@app.get("/surveillance/scan")
async def scan(request: Request, district: Optional[str] = None):
    alerts = request.app.state.service.surveillance.scan_for_anomalies([district] if district else None)
    return {"scan_time": datetime.now().isoformat(), "alerts_count": len(alerts),
            "alerts": [a.model_dump(mode="json") for a in alerts]}


@app.get("/alerts")
async def alerts(request: Request):
    found = request.app.state.service.surveillance.scan_for_anomalies()
    return {"timestamp": datetime.now().isoformat(), "total_alerts": len(found),
            "by_level": {level: sum(a.alert_level == level for a in found) for level in ("emergency", "warning", "watch")},
            "alerts": [a.model_dump(mode="json") for a in found]}


@app.get("/surveillance/report")
async def report(request: Request, district: str):
    return await asyncio.wait_for(request.app.state.service.report(district), 180)


@app.post("/jobs/report", status_code=202)
async def report_job(payload: ReportRequest, request: Request):
    return request.app.state.jobs.submit("report", lambda: request.app.state.service.report(payload.district, payload.max_tokens, payload.refresh))


@app.post("/jobs/multimodal", status_code=202)
async def multimodal_job(payload: MultimodalRequest, request: Request):
    return request.app.state.jobs.submit("multimodal", lambda: request.app.state.service.multimodal(payload.model_dump()))


@app.get("/jobs/{job_id}")
async def job_status(job_id: str, request: Request):
    result = request.app.state.store.get_job(job_id)
    if result is None:
        raise HTTPException(404, "Job not found")
    return result


@app.delete("/jobs/{job_id}")
async def cancel_job(job_id: str, request: Request):
    result = await request.app.state.jobs.cancel(job_id)
    if result is None:
        raise HTTPException(404, "Job not found")
    return result


@app.get("/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request):
    await job_status(job_id, request)
    async def events():
        previous = None
        while not await request.is_disconnected():
            current = request.app.state.store.get_job(job_id)
            encoded = json.dumps(current)
            if encoded != previous:
                yield f"event: status\ndata: {encoded}\n\n"
                previous = encoded
            if current["status"] in {"succeeded", "failed", "cancelled"}:
                break
            await asyncio.sleep(0.25)
    return StreamingResponse(events(), media_type="text/event-stream")


@app.post("/transcribe")
async def transcribe(payload: AudioRequest, request: Request):
    return await request.app.state.scheduler.run(dict(payload.model_dump(), operation="transcribe"))


@app.post("/image-triage")
@app.post("/encounter/image")
async def image(payload: ImageRequest, request: Request):
    return await request.app.state.service.image(payload.model_dump())


@app.post("/cough/analyze")
async def cough(payload: AudioRequest, request: Request):
    return await request.app.state.scheduler.run(dict(payload.model_dump(), operation="cough"))


@app.get("/hear/spectrogram")
async def spectrogram():
    raise HTTPException(410, "Synthetic spectrogram removed. Submit recorded audio to /cough/analyze.")


@app.post("/alert/advisory")
async def advisory(payload: AdvisoryRequest, request: Request):
    found = request.app.state.service.surveillance.scan_for_anomalies()
    target = next((a for a in found if a.alert_id == payload.alert_id), None)
    if target is None:
        raise HTTPException(404, "Alert not found")
    result = await request.app.state.service.generate("advisory", [{"role": "user", "content":
        f"Draft advisory in {payload.language} for {payload.audience}. Use only this evidence: "
        + json.dumps({"district": target.district, "syndrome": target.syndrome_category,
                      "cases": target.case_count_current_week, "level": target.alert_level})}])
    return dict(payload.model_dump(), advisory=result["text"], provenance=result["provenance"], draft=True)


@app.get("/fhir/report")
async def fhir(request: Request, district: str):
    service = request.app.state.service
    summary, found = service.summary(district)
    now = datetime.now()
    from collections import Counter
    counts = dict(Counter(e.syndromic_signal.syndrome_category for e in service.store.encounters
        if e.district == district and now - timedelta(days=7) <= e.timestamp <= now and e.syndromic_signal))
    return service.alerts.generate_fhir_report(district, now - timedelta(days=7), now, counts, found)


@app.get("/dashboard")
async def dashboard(request: Request):
    db = request.app.state.store
    found = request.app.state.service.surveillance.scan_for_anomalies()
    return {"timestamp": datetime.now().isoformat(), "total_encounters": db.total_encounters,
            "syndrome_distribution": db.syndrome_distribution, "districts": sorted(set(db._signal_districts)),
            "active_alerts": dict(total=len(found), **{level: sum(a.alert_level == level for a in found)
                for level in ("emergency", "warning", "watch")}),
            "recent_encounters": [{"id": e.encounter_id, "time": e.timestamp.isoformat(),
                "district": e.district, "syndrome": e.syndromic_signal.syndrome_category if e.syndromic_signal else None}
                for e in db.encounters[-20:]]}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("src.api.app:app", host="127.0.0.1", port=8000, workers=1)
