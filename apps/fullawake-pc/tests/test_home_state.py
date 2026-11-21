import asyncio
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from fullawake.capabilities.home_state import HomeSnapshot, HomeState, resolve_scene_state
from fullawake.core.config import config
from fullawake.gateway.mcp_server import FullAwakeMCPGateway


def payload(at, sequence=5):
    return {
        'schemaVersion': 1, 'actorId': 'xiaoman', 'sequence': sequence,
        'generatedAt': at.isoformat(), 'expiresAt': (at + timedelta(minutes=3)).isoformat(),
        'presence': 'asleep', 'mood': {'state': 'tired', 'energy': .2},
        'activity': {'kind': 'idle', 'label': '', 'source': 'heart', 'startedAt': None},
        'recentAlbum': [],
    }


def test_sequence_restart_ttl_and_disconnect():
    at = datetime(2026, 11, 21, tzinfo=timezone.utc)
    clock = [at]
    cache = HomeState(lambda: clock[0])

    def send(stamp, sequence):
        return cache.accept(HomeSnapshot.model_validate_json(json.dumps(payload(stamp, sequence))))

    assert cache.view({})['stale']
    assert send(at, 5)
    assert not send(at, 6)
    assert not send(at + timedelta(seconds=1), 3)
    assert not send(at - timedelta(seconds=2), 1)
    assert send(at + timedelta(seconds=2), 1)
    assert cache.view({})['sceneState']['place'] == 'bed'
    cache.invalidate()
    assert not cache.view({})['phone_online']
    assert not send(at, 5)
    assert send(at + timedelta(seconds=3), 2)
    clock[0] += timedelta(seconds=183)
    stale = cache.view({'call_active': True}, include_album=True)
    assert stale['stale'] and not stale['phone_online']
    assert stale['sceneState']['source'] == 'offline' and stale['recentAlbum'] == []
    assert not send(at + timedelta(seconds=3), 8)


def test_scene_priorities_are_deterministic():
    phone = SimpleNamespace(activity=SimpleNamespace(kind='project', label='在推进共同小项目'),
                            presence='asleep', mood=SimpleNamespace(state='tired'))
    pc = {'call_active': True, 'watch_active': True, 'game_watch_active': True, 'pet_running': True}
    for key, place in [('call_active', 'desk'), ('watch_active', 'sofa'), ('game_watch_active', 'computer')]:
        assert resolve_scene_state(phone, pc)['place'] == place
        pc[key] = False
    assert resolve_scene_state(phone, pc)['source'] == 'companion'
    phone.activity.kind = 'idle'
    assert resolve_scene_state(phone, pc)['source'] == 'desktop_pet'
    pc['pet_running'] = False
    assert resolve_scene_state(phone, pc)['pose'] == 'rest'
    phone.presence = 'present'
    assert resolve_scene_state(phone, pc)['pose'] == 'sit'
    phone.mood.state = 'calm'
    assert resolve_scene_state(phone, pc)['source'] == 'decoration'
    assert resolve_scene_state(None, pc)['source'] == 'offline'


@pytest.fixture
def gateway(monkeypatch):
    monkeypatch.setenv('FULLAWAKE_DESKTOP_TOKEN', 'desktop-home-test-token-not-production')
    monkeypatch.setattr(config, 'auth_token', 'phone-home-test-token')
    return FullAwakeMCPGateway()


def test_home_routes_split_tokens_reject_untrusted_payload_and_omit_album_from_stream(gateway):
    phone = {'Authorization': 'Bearer phone-home-test-token'}
    desktop = {'Authorization': 'Bearer desktop-home-test-token-not-production'}
    now = datetime.now(timezone.utc)
    post = '/v1/home/snapshot'
    get = '/v1/desktop/home'
    data = payload(now)
    data['recentAlbum'] = [{'id': 'alb_12345678', 'kind': 'user_photo', 'title': '一起看过的照片',
                           'summary': '来自共同查看的照片。', 'timestamp': now.isoformat(), 'revision': 0}]
    with TestClient(gateway.app, client=('127.0.0.1', 45678)) as client:
        assert client.post(post, json=data).status_code == 403
        assert client.post(post, headers=desktop, json=data).status_code == 403
        assert client.post(post, headers={**phone, 'Origin': 'http://localhost'}, json=data).status_code == 403
        assert client.get(get, headers=phone).status_code == 403
        assert client.post(post, headers=phone, json={**data, 'actorId': 'axing'}).status_code == 422
        assert client.post(post, headers=phone, json={**data, 'schemaVersion': True}).status_code == 422
        invalid = client.post(post, headers=phone, json={**data, 'private_quote': 'do not reflect'})
        assert invalid.status_code == 422 and 'do not reflect' not in invalid.text
        assert client.post(post, headers=phone, content='x' * 12289).status_code == 413
        assert client.post(post, headers=phone, json=data).status_code == 204
        assert client.post(post, headers=phone, json=data).status_code == 409
        assert client.get(get, headers=desktop).json()['recentAlbum'][0]['id'] == 'alb_12345678'
        with client.websocket_connect('/ws/desktop', headers=desktop) as events:
            home = events.receive_json()['home']
            assert home['sceneState']['place'] == 'bed'
            assert home['albumCount'] == 1 and 'recentAlbum' not in home
    with TestClient(gateway.app, client=('192.0.2.2', 45678)) as remote:
        assert remote.post(post, headers=phone, json=data).status_code == 403
        assert remote.get(get, headers=desktop).status_code == 403


def test_phone_disconnect_immediately_clears_projection(gateway):
    snapshot = HomeSnapshot.model_validate_json(json.dumps(payload(datetime.now(timezone.utc))))
    assert gateway.console.home.accept(snapshot)
    asyncio.run(gateway.console.disconnect(object()))
    assert not gateway.console.home_view()['phone_online']
