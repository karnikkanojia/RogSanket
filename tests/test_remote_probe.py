"""Verify endpoint checks without using paid GPU services."""
import httpx
import pytest

from scripts.probe_remote import probe
from src.runtime.config import Settings


URL = 'https://example.test/v1/chat/completions'


def test_synthetic_remote_probe():
    def handle(request):
        assert request.headers['authorization'] == 'Bearer test-secret'
        payload = __import__('json').loads(request.content)
        assert payload['model'] == Settings().remote_model
        assert payload['max_tokens'] == 128
        assert 'Synthetic surveillance test' in payload['messages'][0]['content']
        return httpx.Response(200, json={'model': Settings().remote_model,
            'choices': [{'message': {'content': '12 encounters.'}}]})
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = probe(Settings(remote_url=URL), 'test-secret', client)
    assert result['transport_passed']
    assert not result['model_identity_verified']
    assert not result['release_validated']
    assert 'test-secret' not in str(result)


@pytest.mark.parametrize('body', [
    {'model': 'other', 'choices': [{'message': {'content': 'text'}}]},
    {'model': Settings().remote_model, 'choices': [{'message': {'content': ''}}]},
])
def test_probe_rejects_wrong_model_or_empty_text(body):
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body))) as client:
        with pytest.raises(ValueError):
            probe(Settings(remote_url=URL), 'test-secret', client)


def test_probe_requires_explicit_endpoint_and_token():
    with httpx.Client(transport=httpx.MockTransport(lambda request: pytest.fail('Unexpected network call'))) as client:
        with pytest.raises(ValueError):
            probe(Settings(), 'test-secret', client)
        with pytest.raises(ValueError):
            probe(Settings(remote_url=URL), '', client)
