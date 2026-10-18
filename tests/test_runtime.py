"""Model-free contract, lifecycle, privacy and failure tests."""
import asyncio
from datetime import datetime
import json
from pathlib import Path
import sys
import time
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient
import pytest
from src.api.app import app
from src.runtime.config import Settings
from src.runtime.scheduler import Scheduler, QueueFull
from src.runtime.storage import Store
from src.runtime.jobs import Jobs
from src.runtime.service import Service
from src.data.syndromic_schema import ClinicalEncounter, SyndromicSignal


SIGNAL = {"symptoms": ["fever"], "syndrome_category": "acute_febrile_illness",
          "severity": "moderate", "age_group": "adult", "icd10_codes": ["R50"],
          "confidence_score": 0.8}
RESULT = {"text": json.dumps(SIGNAL), "provenance": {"model": "test", "revision": "test"}}


def test_durable_private_storage(tmp_path):
    path = str(tmp_path / "store.sqlite3")
    store = Store(path)
    encounter = ClinicalEncounter(encounter_id="id", timestamp=datetime.now(), district="A",
        narrative_text="sensitive narrative", location_lat=None, syndromic_signal=SyndromicSignal(**SIGNAL))
    store.add_encounter(encounter, {"backend": "test"})
    with pytest.raises(Exception):
        store.add_encounter(encounter)
    assert store.total_encounters == 1
    store.close()
    store = Store(path)
    assert store.total_encounters == 1
    assert store.encounters[0].narrative_text == ""
    assert b"sensitive narrative" not in Path(path).read_bytes()
    store.close()


def test_api_truthful_and_responsive(monkeypatch, tmp_path):
    monkeypatch.setenv("EPICAST_DATABASE", str(tmp_path / "api.sqlite3"))
    with TestClient(app) as client:
        assert client.get("/health").json()["initialized"] is False
        assert client.get("/dashboard").json()["total_encounters"] == 0
        assert client.get("/hear/spectrogram").status_code == 410
        assert client.post("/transcribe", json={"audio_base64": "bad"}).status_code == 422
        app.state.scheduler.run = AsyncMock(side_effect=RuntimeError("No verified weights"))
        response = client.post("/encounter", json={"narrative": "patient has fever"})
        assert response.status_code == 503
        assert app.state.store.total_encounters == 0
        assert client.post("/image-triage", json={"image_base64": "YQ=="}).status_code == 503
        assert client.post("/cough/analyze", json={"audio_base64": "YQ=="}).status_code == 503
        app.state.scheduler.run = AsyncMock(return_value=RESULT)
        response = client.post("/encounter", json={"narrative": "patient has fever", "district": "A"})
        assert response.status_code == 200
        assert response.json()["provenance"]["model"] == "test"
        assert client.get("/dashboard").json()["total_encounters"] == 1


def test_single_extraction_multimodal_and_report_cache():
    async def check():
        store = Store(":memory:")
        scheduler = AsyncMock()
        scheduler.run.return_value = RESULT
        service = Service(Settings(), store, scheduler)
        await service.multimodal({"narrative": "fever", "district": "A"})
        assert scheduler.run.await_count == 1
        assert store.total_encounters == 1
        scheduler.run.return_value = {"text": "Draft report", "provenance": {"model": "test"}}
        await service.report("A")
        await service.report("A")
        assert scheduler.run.await_count == 2
        store.close()
    asyncio.run(check())


def test_extraction_retry_and_failure():
    async def check():
        store = Store(":memory:")
        scheduler = AsyncMock()
        scheduler.run.side_effect = [{"text": "invalid", "provenance": {}}, RESULT]
        service = Service(Settings(), store, scheduler)
        signal, _ = await service.extract("fever")
        assert signal.symptoms == ["fever"]
        assert scheduler.run.await_count == 2
        scheduler.run.side_effect = None
        scheduler.run.return_value = {"text": "invalid", "provenance": {}}
        with pytest.raises(RuntimeError):
            await service.encounter({"narrative": "fever"})
        assert store.total_encounters == 0
        store.close()
    asyncio.run(check())


def test_worker_cancellation_overflow_timeout_restart(tmp_path):
    worker = tmp_path / "worker.py"
    worker.write_text('''import sys,json,time
for line in sys.stdin:
 request=json.loads(line)
 if request.get("crash"): sys.exit(1)
 time.sleep(request.get("sleep",0))
 print(json.dumps({"result":{"text":"ok"}}),flush=True)
''')
    async def check():
        scheduler = Scheduler(Settings(queue_size=1), [sys.executable, str(worker)])
        await scheduler.start()
        slow = asyncio.create_task(scheduler.run({"operation": "generate", "sleep": 10}))
        await asyncio.sleep(0.1)
        pending = asyncio.create_task(scheduler.run({"operation": "generate"}))
        await asyncio.sleep(0.05)
        with pytest.raises(QueueFull):
            await scheduler.run({"operation": "generate"})
        slow.cancel()
        with pytest.raises(asyncio.CancelledError):
            await slow
        assert (await pending)["text"] == "ok"
        with pytest.raises(TimeoutError):
            await scheduler.run({"operation": "generate", "sleep": 5, "deadline": time.time() + 0.1})
        assert (await scheduler.run({"operation": "generate"}))["text"] == "ok"
        with pytest.raises(RuntimeError, match="exited"):
            await scheduler.run({"operation": "generate", "crash": True})
        assert (await scheduler.run({"operation": "generate"}))["text"] == "ok"
        await scheduler.close()
    asyncio.run(check())


def test_jobs_restart_cancellation(tmp_path):
    async def check():
        store = Store(str(tmp_path / "jobs.sqlite3"))
        jobs = Jobs(store)
        job = jobs.submit("report", lambda: asyncio.sleep(10))
        await asyncio.sleep(0)
        assert (await jobs.cancel(job["id"]))["status"] == "cancelled"
        store.save_job({"id": "interrupted", "kind": "report", "status": "running", "created": "now"})
        store.close()
        store = Store(str(tmp_path / "jobs.sqlite3"))
        assert store.get_job("interrupted")["status"] == "failed"
        store.close()
    asyncio.run(check())


def test_memory_admission(monkeypatch):
    from src.runtime import memory
    monkeypatch.setattr(memory, "snapshot", lambda: {"pressure": "critical", "available_bytes": 2**30})
    with pytest.raises(MemoryError):
        memory.admit()


def test_artifact_gate(tmp_path):
    (tmp_path / "epicast-artifact.json").write_text(json.dumps({"base_model": "google/medgemma-1.5-4b-it",
        "revision": "pinned", "quantization_bits": 4, "text_parity_passed": False}))
    with pytest.raises(RuntimeError, match="parity"):
        Settings(artifact=str(tmp_path)).manifest()


def test_pending_job_cancel_before_start():
    async def check():
        store = Store(":memory:")
        jobs = Jobs(store)
        job = jobs.submit("report", lambda: asyncio.sleep(10))
        assert (await jobs.cancel(job["id"]))["status"] == "cancelled"
        assert not jobs.tasks
        store.close()
    asyncio.run(check())


def test_health_while_inference_runs(monkeypatch, tmp_path):
    monkeypatch.setenv("EPICAST_DATABASE", str(tmp_path / "responsive.sqlite3"))
    with TestClient(app) as client:
        async def delayed(payload):
            await asyncio.sleep(10)
            return RESULT
        app.state.scheduler.run = delayed
        job = client.post("/jobs/multimodal", json={"narrative": "Patient has fever"}).json()
        start = time.monotonic()
        assert client.get("/health").status_code == 200
        assert time.monotonic() - start < 0.25
        assert client.get("/dashboard").status_code == 200
        assert client.delete(f'/jobs/{job["id"]}').json()["status"] == "cancelled"
        assert client.get("/dashboard").json()["total_encounters"] == 0


def test_remote_report_allowlist_and_fallback(monkeypatch):
    async def check():
        store = Store(":memory:")
        scheduler = AsyncMock()
        scheduler.run.return_value = RESULT
        service = Service(Settings(remote_url="https://example.invalid/chat"), store, scheduler)
        await service.encounter({"narrative": "SECRET NARRATIVE", "district": "A", "facility_name": "SECRET FACILITY"})
        captured = []
        async def post(self, url, **kwargs):
            captured.append(kwargs['json'])
            import httpx
            raise httpx.ConnectError("offline")
        import httpx
        monkeypatch.setattr(httpx.AsyncClient, "post", post)
        scheduler.run.return_value = {"text": "Fallback report", "provenance": {"location": "local"}}
        report = await service.report("A")
        assert report['fallback_reason'] is not None
        outbound = json.dumps(captured)
        assert "SECRET" not in outbound
        assert 'acute_febrile_illness' in outbound
        assert report['provenance']['location'] == 'local'
        store.close()
    asyncio.run(check())


def test_statistical_alert_ids_and_restart_parity(tmp_path):
    from src.agents.surveillance_agent import SurveillanceAgent
    store = Store(str(tmp_path / "alerts.sqlite3"))
    for index in range(3):
        store.add_encounter(ClinicalEncounter(encounter_id=str(index), timestamp=datetime.now(), district="A",
            narrative_text="", syndromic_signal=SyndromicSignal(**dict(SIGNAL, syndrome_category="acute_neurological_syndrome"))))
    before = SurveillanceAgent(store).scan_for_anomalies()
    assert before
    assert before[0].alert_id == SurveillanceAgent(store).scan_for_anomalies()[0].alert_id
    store.close()
    store = Store(str(tmp_path / "alerts.sqlite3"))
    after = SurveillanceAgent(store).scan_for_anomalies()
    assert [(a.alert_id, a.case_count_current_week, a.alert_level) for a in before] == [
        (a.alert_id, a.case_count_current_week, a.alert_level) for a in after]
    store.close()


def test_failed_evaluation_counts_zero():
    from scripts.evaluate_runtime import score
    assert all(value == 0 for value in score(None, SIGNAL).values())


def test_auxiliary_artifact_requires_provenance(tmp_path, monkeypatch):
    from src.runtime.modalities import artifact
    (tmp_path / "epicast-artifact.json").write_text(json.dumps({"base_model": "google/hear", "revision": "test"}))
    monkeypatch.setenv("EPICAST_HEAR_ARTIFACT", str(tmp_path))
    with pytest.raises(RuntimeError, match="reference parity"):
        artifact("EPICAST_HEAR_ARTIFACT", "google/hear")


def test_artifact_checksums_detect_tampering(tmp_path):
    import hashlib
    files = {'config.json': json.dumps({'model_type': 'gemma3', 'vision_config': {}, 'quantization': {'bits': 4}}),
             'tokenizer_config.json': '{}', 'model.safetensors': 'test-weight-bytes'}
    for name, contents in files.items():
        (tmp_path / name).write_text(contents)
    manifest = {'base_model': 'google/medgemma-1.5-4b-it', 'revision': 'pinned', 'quantization_bits': 4,
                'text_parity_passed': True, 'image_parity_passed': True,
                'sha256': {name: hashlib.sha256(contents.encode()).hexdigest() for name, contents in files.items()}}
    (tmp_path / 'epicast-artifact.json').write_text(json.dumps(manifest))
    (tmp_path / '.cache').mkdir()
    (tmp_path / '.cache' / 'download-metadata.json').write_text('{}')
    assert Settings(artifact=str(tmp_path)).manifest()['revision'] == 'pinned'
    manifest.update(text_parity_passed=False, image_parity_passed=False)
    (tmp_path / 'epicast-artifact.json').write_text(json.dumps(manifest))
    with pytest.raises(RuntimeError, match='parity'):
        Settings(artifact=str(tmp_path)).manifest()
    assert Settings(artifact=str(tmp_path)).manifest(require_parity=False)['revision'] == 'pinned'
    (tmp_path / 'tokenizer_config.json').write_text('tampered')
    with pytest.raises(RuntimeError, match='checksum'):
        Settings(artifact=str(tmp_path)).manifest(require_parity=False)


def test_unrequested_remote_is_never_called(monkeypatch):
    async def check():
        import httpx
        async def forbidden(*args, **kwargs):
            raise AssertionError('Offline service contacted remote provider')
        monkeypatch.setattr(httpx.AsyncClient, 'post', forbidden)
        store = Store(':memory:')
        scheduler = AsyncMock()
        scheduler.run.return_value = {'text': 'Draft', 'provenance': {'location': 'local'}}
        service = Service(Settings(), store, scheduler)
        assert (await service.report('A'))['provenance']['location'] == 'local'
        store.close()
    asyncio.run(check())


def test_real_worker_missing_artifact_is_explicit(monkeypatch):
    monkeypatch.delenv('EPICAST_ARTIFACT', raising=False)
    async def check():
        scheduler = Scheduler(Settings(artifact=''))
        await scheduler.start()
        try:
            with pytest.raises(RuntimeError, match='EPICAST_ARTIFACT'):
                await scheduler.run({'operation': 'generate', 'messages': [{'role': 'user', 'content': 'Test'}]})
            assert scheduler.status()['last_error']
        finally:
            await scheduler.close()
    asyncio.run(check())


def test_job_status_events_and_unknown_ids(monkeypatch, tmp_path):
    monkeypatch.setenv('EPICAST_DATABASE', str(tmp_path / 'events.sqlite3'))
    with TestClient(app) as client:
        app.state.scheduler.run = AsyncMock(return_value={'text': 'Draft', 'provenance': {'location': 'local'}})
        job = client.post('/jobs/report', json={'district': 'A'}).json()
        response = client.get(f'/jobs/{job["id"]}/events')
        assert response.status_code == 200
        assert 'event: status' in response.text
        assert 'succeeded' in response.text
        assert client.get('/jobs/missing').status_code == 404
        assert client.delete('/jobs/missing').status_code == 404


def test_active_memory_pressure_kills_worker_and_recovers(monkeypatch, tmp_path):
    from src.runtime import memory
    state = {'pressure': 'normal', 'available_bytes': 2**30}
    monkeypatch.setattr(memory, 'snapshot', lambda: dict(state))
    worker = tmp_path / 'pressure_worker.py'
    worker.write_text('''import sys,json,time
for line in sys.stdin:
 request=json.loads(line)
 time.sleep(request.get("sleep",0))
 print(json.dumps({"result":{"text":"ok"}}),flush=True)
''')
    async def check():
        scheduler = Scheduler(Settings(), [sys.executable, str(worker)])
        await scheduler.start()
        try:
            pending = asyncio.create_task(scheduler.run({'operation': 'generate', 'sleep': 30}))
            await asyncio.sleep(0.1)
            state['pressure'] = 'critical'
            with pytest.raises(MemoryError):
                await asyncio.wait_for(pending, 3)
            assert scheduler.process is None
            state['pressure'] = 'normal'
            assert (await scheduler.run({'operation': 'generate'}))['text'] == 'ok'
            recovered_process = scheduler.process
        finally:
            await scheduler.close()
        assert recovered_process.returncode == 0
    asyncio.run(check())


def test_partial_reasoning_is_not_a_clinical_answer():
    from src.runtime.worker import final_answer
    assert final_answer('{"symptoms": []}') == '{"symptoms": []}'
    assert final_answer('<unused94>thought\ninternal<unused95>{"symptoms": []}') == '{"symptoms": []}'
    with pytest.raises(RuntimeError, match='final answer'):
        final_answer('<unused94>thought\ntruncated')
