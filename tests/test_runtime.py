"""Model-free inference lifecycle, artifact and failure tests.

Application privacy, storage, jobs and HTTP contracts live in native/Server tests.
"""
import asyncio
import json
import sys
import time

import pytest
from src.runtime.config import Settings
from src.runtime.scheduler import Scheduler, QueueFull


SIGNAL = {"symptoms": ["fever"], "syndrome_category": "acute_febrile_illness",
          "severity": "moderate", "age_group": "adult", "icd10_codes": ["R50"],
          "confidence_score": 0.8}


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


def test_gemma_chat_template_owns_bos():
    from types import SimpleNamespace
    from src.runtime.worker import chat_add_special_tokens
    # MLX's processor has no template attribute; its tokenizer owns the template.
    processor = SimpleNamespace(chat_template=None, tokenizer=SimpleNamespace(bos_token='<bos>'))
    assert chat_add_special_tokens(processor, '<bos><start_of_turn>user\nfever') is False
    with pytest.raises(RuntimeError, match='beginning-of-sequence'):
        chat_add_special_tokens(processor, '<start_of_turn>user\nfever')


def test_image_processor_receives_explicit_no_special_tokens():
    from types import SimpleNamespace
    from src.runtime.worker import prepare_gemma_inputs
    class Processor:
        tokenizer = SimpleNamespace(bos_token='<bos>')
        def __call__(self, **kwargs):
            assert kwargs['add_special_tokens'] is False
            assert kwargs['images'] == ['synthetic-image']
            return {'input_ids': 'processor-result'}
    assert prepare_gemma_inputs(Processor(), '<bos>prompt', 'synthetic-image')['input_ids'] == 'processor-result'
