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
    assert resolve_scene_state(phone, pc)['pose'] == 'rest'
    phone.presence = 'present'
    assert resolve_scene_state(phone, pc)['pose'] == 'sit'
    phone.mood.state = 'calm'
    assert resolve_scene_state(phone, pc)['source'] == 'decoration'
    assert resolve_scene_state(None, pc)['source'] == 'offline'

@pytest.mark.parametrize(('kind', 'place', 'pose'), [
    ('thinking', 'desk', 'sit'), ('browsing_video', 'sofa', 'watch'),
    ('reading_memory', 'bookshelf', 'read'), ('viewing_pc', 'computer', 'read'),
])
def test_session_scenes_accept_new_kinds_and_require_session_source(kind, place, pose):
    now = datetime.now(timezone.utc)
    data = payload(now)
    assert HomeSnapshot.model_validate_json(json.dumps(data)).activity.kind == 'idle'
    data['activity'] = {'kind': kind, 'label': '真实行为', 'startedAt': now.isoformat(), 'source': 'session'}
    item = HomeSnapshot.model_validate_json(json.dumps(data))
    assert resolve_scene_state(item, {'pet_running': True}) == {
        'place': place, 'pose': pose, 'source': 'session', 'label': '真实行为',
    }
    data['activity']['source'] = 'companion'
    with pytest.raises(ValueError, match='missing activity evidence'):
        HomeSnapshot.model_validate_json(json.dumps(data))


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


def test_pet_publish_mirrors_speech_tail_and_ignores_a_late_cancel_for_an_old_utterance(gateway):
    at = datetime(2026, 11, 21, tzinfo=timezone.utc)
    clock = [at]
    home = gateway.console.home
    home.now = lambda: clock[0]
    publish = gateway.watch.publish
    publish({'event': 'action', 'text': ' 她和桌宠同步说话 ', 'utteranceId': 'old', 'audioDurationMs': 6000},
            player_only=True)
    bubble = gateway.console.home_view()['speechBubble']
    assert bubble['text'] == '她和桌宠同步说话'
    assert datetime.fromisoformat(bubble['expiresAt']) == at + timedelta(milliseconds=7200)
    publish({'event': 'action', 'text': '新的一句' * 100, 'utteranceId': 'new'})
    publish({'event': 'interrupt', 'utteranceId': 'old'})
    assert len(gateway.console.home_view()['speechBubble']['text']) == 200
    clock[0] += timedelta(seconds=3)
    publish({'event': 'playback_clock', 'mode': 'idle', 'utteranceId': 'new'})
    assert datetime.fromisoformat(gateway.console.home_view()['speechBubble']['expiresAt']) == clock[0] + timedelta(milliseconds=1200)
    clock[0] += timedelta(milliseconds=1200)
    assert gateway.console.home_view()['speechBubble'] is None
    publish({'event': 'action', 'text': '被打断的话', 'utteranceId': 'abort'})
    publish({'event': 'audio_cancel', 'utteranceId': 'abort'})
    assert gateway.console.home_view()['speechBubble'] is None
    publish({'event': 'action', 'text': '断线前', 'utteranceId': 'disconnect'})
    home.invalidate()
    assert gateway.console.home_view()['speechBubble'] is None


def test_bridge_without_pet_mirrors_text_without_synthesizing_or_claiming_playback(gateway, monkeypatch):
    from test_voice_bridge import frame, handshake

    monkeypatch.setattr(config, 'voice_vad_enabled', False)
    monkeypatch.setattr(config, 'epoch_revocation_enabled', True)
    monkeypatch.setattr(gateway.watch, 'token', 'local-home-watch-test-token')
    monkeypatch.setattr('fullawake.gateway.interrupt_controller.is_desktop_locked', lambda: False)
    monkeypatch.setattr(gateway.voice, 'synthesize', pytest.fail)
    headers = {'Authorization': 'Bearer phone-home-test-token'}
    with TestClient(gateway.app, client=('127.0.0.1', 45678)) as client:
        with client.websocket_connect('/ws/bridge', headers=headers) as phone:
            handshake(phone, lifecycle=True)
            identity = {'epoch': 101, 'utteranceId': 'fixture'}
            phone.send_json(frame('audio.prepare', 2, identity))
            assert phone.receive_json()['type'] == 'audio.prepared'
            phone.send_json(frame('pet.text', 3, {**identity, 'text': '本地气泡', 'intent': 'smile'}))
            assert phone.receive_json()['payload']['status'] == 'discarded'
            assert gateway.console.home_view()['speechBubble']['text'] == '本地气泡'
            phone.send_json(frame('audio.cancel', 4, identity))
            phone.send_json(frame('audio.prepare', 5, {'epoch': 102, 'utteranceId': 'barrier'}))
            assert phone.receive_json()['type'] == 'audio.prepared'
            assert gateway.console.home_view()['speechBubble'] is None
