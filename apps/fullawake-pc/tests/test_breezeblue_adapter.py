import asyncio
import json

import httpx
import pytest

from fullawake.capabilities import breezeblue_adapter
from fullawake.core.config import config


@pytest.fixture
def adapter(monkeypatch):
    monkeypatch.setattr(config, 'breeze_api_key', 'fixture-only')
    return breezeblue_adapter.BreezeBlueAdapter()


def transport(monkeypatch, handler):
    create = httpx.AsyncClient
    monkeypatch.setattr(breezeblue_adapter.httpx, 'AsyncClient',
                        lambda **options: create(transport=httpx.MockTransport(handler), **options))


def test_direct_cloud_request_uses_existing_voice_contract(adapter, monkeypatch):
    def respond(request):
        assert request.url.host == 'api.breeze.blue'
        assert request.url.path.endswith('/voc_myarmcyqm2zv')
        assert request.url.params['output_format'] == 'mp3'
        assert request.headers['xi-api-key'] == 'fixture-only'
        assert json.loads(request.content) == {'text': '好险呀', 'instructions': '带一点笑',
                                               'voice_settings': {'guidance_scale': 2}}
        return httpx.Response(200, content=b'ID3sound')

    transport(monkeypatch, respond)
    assert asyncio.run(adapter.synthesize('好险呀', '带一点笑')) == b'ID3sound'


def test_no_redirect_and_no_oversized_response(adapter, monkeypatch):
    calls = []

    def respond(request):
        calls.append(request.url.host)
        if len(calls) == 1:
            return httpx.Response(302, headers={'Location': 'https://elsewhere.invalid'})
        return httpx.Response(200, content=b'ID3' + bytes(breezeblue_adapter.MAX_MP3_BYTES))

    transport(monkeypatch, respond)
    with pytest.raises(ValueError, match='HTTP 302'):
        asyncio.run(adapter.synthesize('好险呀'))
    with pytest.raises(ValueError, match='size limit'):
        asyncio.run(adapter.synthesize('好险呀'))
    assert calls == ['api.breeze.blue', 'api.breeze.blue']


def test_deadline_cancels_inflight_request(adapter, monkeypatch):
    cancelled = []

    async def blocked(_):
        try:
            await asyncio.Future()
        finally:
            cancelled.append(True)

    transport(monkeypatch, blocked)
    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(adapter.synthesize('好险呀', deadline_s=0.05))
    assert cancelled == [True]


def test_reuses_async_client_within_same_event_loop(adapter, monkeypatch):
    created = []
    real_client = httpx.AsyncClient

    def factory(**options):
        client = real_client(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b'ID3ok')), **options)
        created.append(client)
        return client

    monkeypatch.setattr(breezeblue_adapter.httpx, 'AsyncClient', factory)

    async def run_twice():
        assert await adapter.synthesize('第一句') == b'ID3ok'
        assert await adapter.synthesize('第二句') == b'ID3ok'
        await adapter.aclose()

    asyncio.run(run_twice())
    assert len(created) == 1
