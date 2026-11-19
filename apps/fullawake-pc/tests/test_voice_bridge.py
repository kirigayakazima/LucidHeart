import asyncio
import base64
from io import BytesIO
import json
import subprocess
from threading import Event
from time import monotonic
import wave

from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

from fullawake.capabilities.voice import ASSETS
from fullawake.capabilities.desktop_vision.game_watcher import GameEvent
from fullawake.capabilities.voice_vad import SpeechGate
from fullawake.core.config import config
from fullawake.gateway.interrupt_controller import INITIAL_EPOCH, REVOKED_TTL
from fullawake.gateway.mcp_server import FullAwakeMCPGateway

AUTH = {'Authorization': 'Bearer bridge-test-only'}


def frame(kind, seq, payload, connection='test-connection'):
    return {'protocol': 'lucid.voice/1', 'type': kind, 'commandSeq': seq,
            'sessionId': 'test-session', 'connectionId': connection, 'payload': payload}


def handshake(phone, connection='test-connection', *, vad_supported=False, lifecycle=False, capture=False, direct=False):
    phone.send_json(frame('session.handshake', 1, {
        'clientVersion': '0.2.9' if direct else '0.2.6' if lifecycle else '0.2.5', 'heartVersion': '0.21.3', 'device': 'redmi-note12turbo',
        **({'capture': True} if capture else {}),
    }, connection))
    reply = phone.receive_json()
    assert reply['type'] == 'session.handshake_ack'
    assert reply['commandSeq'] == 1 and reply['connectionId'] == connection
    assert reply['payload']['initialEpoch'] == INITIAL_EPOCH
    assert reply['payload']['vadSupported'] is vad_supported
    assert reply['payload'].get('turnLifecycle', False) is lifecycle
    if direct:
        assert reply['payload']['gameVoice'] is True
    else:
        assert 'gameVoice' not in reply['payload']


def speak(phone, seq, epoch, utterance, connection='test-connection'):
    phone.send_json(frame('audio.speak', seq, {
        'epoch': epoch, 'utteranceId': utterance, 'text': utterance,
        'voiceProfile': 'feiyu-rvc-v1', 'pitchShift': -4, 'deadlineMs': 4000,
    }, connection))


def long_audio():
    buf = BytesIO()
    with wave.open(buf, 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', ''))
        wav.writeframes(b'\x00\x02' * 160000)
    return base64.b64encode(buf.getvalue()).decode()


def test_ptt_interrupt_empty_release_and_correlated_final_are_diagnosable(bridge, monkeypatch, caplog):
    client, gateway = bridge
    caplog.set_level('INFO', logger='fullawake.gateway.interrupt_controller')

    async def synth(_request, disconnected):
        return {'audioBase64': long_audio()}

    monkeypatch.setattr(gateway.voice, 'synthesize', synth)
    with client.websocket_connect('/ws/pet?player=1') as pet, client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, lifecycle=True, capture=True)
        peer = gateway.interrupts.peer
        peer.call_active = True
        speak(phone, 2, 105, 'ptt-playback')
        utterance = pet.receive_json()['utteranceId']
        pet.receive_json()
        # VoiceVadListener invokes these on press / release; no ASR event precedes release.
        client.portal.call(gateway.interrupts.on_speech_start, peer)
        interrupt = pet.receive_json()
        pet.send_json({'event': 'interrupt_ack', 'utteranceId': utterance,
                       'interruptId': interrupt['interruptId'], 'elapsedAudioMs': 960})
        notice = phone.receive_json()
        assert notice['type'] == 'audio.interrupt'
        assert notice['payload']['elapsedAudioMs'] == 960
        client.portal.call(gateway.interrupts.on_speech_end, peer)
        monkeypatch.setattr(gateway.voice, 'transcribe', lambda _: {'ok': True, 'text': '   '})
        client.portal.call(gateway.interrupts._transcribe_utterance, peer, b'empty release')
        monkeypatch.setattr(gateway.voice, 'transcribe', lambda _: {'ok': True, 'text': '等一下'})
        client.portal.call(gateway.interrupts._transcribe_utterance, peer, b'voiced release')
        capture, final = phone.receive_json(), phone.receive_json()
        assert capture['type'] == 'audio.capture'
        assert final['type'] == 'audio.transcript' and final['payload']['is_final'] is True
        assert capture['payload']['turnId'] == final['payload']['turnId']
        assert 'elapsedAudioMs=960' in caplog.text and 'localAudioStopped=True' in caplog.text
        assert 'PC mic final turnId=' in caplog.text and 'empty or call inactive' in caplog.text


def test_local_asr_result_from_previous_call_is_dropped_after_reopen(bridge, monkeypatch):
    client, gateway = bridge
    started, finish = Event(), Event()

    def transcribe(_):
        started.set()
        assert finish.wait(3)
        return {'ok': True, 'text': '旧通话迟到结果'}

    monkeypatch.setattr(gateway.voice, 'transcribe', transcribe)
    with client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, lifecycle=True, capture=True)
        peer = gateway.interrupts.peer
        peer.call_active = True
        future = client.portal.start_task_soon(gateway.interrupts._transcribe_utterance, peer, b'old call')
        assert started.wait(3)
        peer.call_generation += 2  # stop + restart before Whisper returns
        finish.set()
        future.result(timeout=3)
        assert gateway.interrupts._capture_epoch == 0


@pytest.fixture
def bridge(monkeypatch, tmp_path):
    profile = tmp_path / 'voice.json'
    profile.write_text(json.dumps({'assets': {name: {'sha256': 'fake'} for name in ASSETS}}))
    monkeypatch.setattr(config, 'voice_profile', str(profile))
    monkeypatch.setattr(config, 'auth_token', 'bridge-test-only')
    monkeypatch.setattr(config, 'voice_vad_enabled', False)
    monkeypatch.setattr(config, 'epoch_revocation_enabled', True)
    monkeypatch.setenv('FULLAWAKE_WATCH_TOKEN', 'local-watch-token-for-test-only')
    for module in ('gateway.interrupt_controller', 'capabilities.desktop_vision.watch'):
        monkeypatch.setattr(f'fullawake.{module}.is_desktop_locked', lambda: False)
    gateway = FullAwakeMCPGateway()
    with TestClient(gateway.app, client=('127.0.0.1', 45555)) as client:
        yield client, gateway


@pytest.mark.parametrize('headers', [{}, {'Authorization': 'Bearer wrong'}, {**AUTH, 'Origin': 'http://localhost'}])
def test_bridge_denies_unauthenticated_and_browser_clients(bridge, headers):
    client, _ = bridge
    with pytest.raises(WebSocketDisconnect) as error, client.websocket_connect('/ws/bridge', headers=headers):
        pytest.fail('Unauthorized voice bridge accepted')
    assert error.value.code == 1008


def test_authenticated_capture_relays_draft_and_final_once(bridge, monkeypatch):
    client, gateway = bridge
    monkeypatch.setattr(config, 'voice_clients', ['127.0.0.1'])
    monkeypatch.setattr(gateway.voice, 'transcribe', lambda _: {'ok': True, 'text': '听到了'})
    capture = 'b7b4d15c-2f40-405c-b47f-eb88a269c335'
    turn = 'dee387cc-a201-4113-8e0f-aaa4095ad7a1'
    route = '/v1/voice/capture'
    params = {'capture': capture, 'audio_epoch': 5, 'turn_id': turn}
    asr = '/v1/voice/asr'
    headers = {**AUTH, 'X-FullAwake-Capture': capture, 'X-FullAwake-Capture-Epoch': '5'}
    assert client.post(route, params=params).status_code == 403
    with client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, lifecycle=True, capture=True)
        assert client.post(route, params=params, headers=AUTH).status_code == 204
        assert phone.receive_json()['payload'] == {'turnId': turn, 'audio_epoch': 5}
        assert client.post(asr, content=b'draft', headers=headers).is_success
        draft = phone.receive_json()
        assert draft['type'] == 'audio.transcript' and not draft['payload']['is_final']
        final = {**headers, 'X-FullAwake-ASR-Final': '1'}
        assert client.post(asr, content=b'final', headers=final).is_success
        assert phone.receive_json()['payload'] == {'turnId': turn, 'audio_epoch': 5, 'text': '听到了', 'is_final': True}
        assert client.post(asr, content=b'duplicate', headers=final).status_code == 409
        assert client.post(route, params=params, headers=AUTH).status_code == 409


def test_explicit_call_control_gates_capture_and_rejects_late_asr(bridge, monkeypatch):
    client, gateway = bridge
    monkeypatch.setattr(config, 'voice_clients', ['127.0.0.1'])
    monkeypatch.setattr(gateway.voice, 'transcribe', lambda _: {'ok': True, 'text': '通话定稿'})
    capture = 'b7b4d15c-2f40-405c-b47f-eb88a269c335'
    turn = 'dee387cc-a201-4113-8e0f-aaa4095ad7a1'
    params = {'capture': capture, 'audio_epoch': 5, 'turn_id': turn}
    route = '/v1/voice/capture'
    asr_headers = {**AUTH, 'X-FullAwake-Capture': capture, 'X-FullAwake-Capture-Epoch': '5', 'X-FullAwake-ASR-Final': '1'}
    with client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        phone.send_json(frame('session.handshake', 1, {
            'clientVersion': '0.2.10', 'heartVersion': '0.21.4', 'device': 'redmi-note12turbo', 'capture': True,
        }))
        assert phone.receive_json()['type'] == 'session.handshake_ack'
        assert client.post(route, params=params, headers=AUTH).status_code == 503
        phone.send_json(frame('voice.call', 2, {'requestId': 'start', 'active': True}))
        assert phone.receive_json()['payload'] == {'requestId': 'start', 'active': True}
        assert client.post(route, params=params, headers=AUTH).is_success
        assert phone.receive_json()['type'] == 'audio.capture'
        phone.send_json(frame('voice.call', 3, {'requestId': 'stop', 'active': False}))
        assert phone.receive_json()['payload'] == {'requestId': 'stop', 'active': False}
        assert client.post('/v1/voice/asr', content=b'late', headers=asr_headers).status_code == 409
        assert client.post(route, params={**params, 'audio_epoch': 6}, headers=AUTH).status_code == 503
        phone.send_json(frame('voice.call', 4, {'requestId': 'restart', 'active': True}))
        assert phone.receive_json()['payload'] == {'requestId': 'restart', 'active': True}
        assert client.post('/v1/voice/asr', content=b'old-call', headers=asr_headers).status_code == 409


def test_breezeblue_mp3_plays_through_prepared_game_voice_lease(bridge):
    client, _ = bridge
    mp3 = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=523:d=0.5',
                          '-f', 'mp3', 'pipe:1'], check=True, capture_output=True).stdout
    audio = base64.b64encode(mp3).decode()
    identity = {'epoch': INITIAL_EPOCH, 'utteranceId': 'game-commentary'}
    payload = {**identity, 'text': '还剩一点血，稳住呀。', 'audioBase64': audio, 'deadlineMs': 15000}
    with client.websocket_connect('/ws/pet?player=1') as pet, client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, lifecycle=True)
        phone.send_json(frame('audio.play', 2, payload))
        assert phone.receive_json()['payload']['status'] == 'discarded'

        identity['epoch'] += 1
        phone.send_json(frame('audio.prepare', 3, identity))
        assert phone.receive_json()['type'] == 'audio.prepared'
        phone.send_json(frame('audio.play', 4, {**payload, **identity}))
        reaction, playback = pet.receive_json(), pet.receive_json()
        assert reaction['text'] == payload['text'] and playback['event'] == 'playback_audio'
        assert base64.b64decode(playback['audioBase64']).startswith(b'RIFF')
        pet.send_json({'event': 'playback_clock', 'mode': 'idle', 'outcome': 'played', 'utteranceId': reaction['utteranceId']})
        assert phone.receive_json()['payload'] == {**identity, 'status': 'played'}


@pytest.mark.parametrize('case', ['played', 'stale', 'timeout', 'unsafe', 'speech'])
def test_game_watch_event_is_lease_scoped_and_uses_absolute_deadline(bridge, monkeypatch, case):
    client, gateway = bridge
    game = (41, 9, 'FixtureGame.exe', {'left': 0})
    controller = gateway.interrupts
    watcher = controller.game_watch
    monkeypatch.setattr(config, 'breeze_api_key', 'fixture-only')
    monkeypatch.setattr(watcher, 'profiles', {game[2].casefold(): object()})
    monkeypatch.setattr(watcher, 'probe', lambda: (game, None))
    monkeypatch.setattr('fullawake.gateway.interrupt_controller.active_game_window', lambda: game)
    calls = []
    event_id = 'a' * 32

    async def revalidate(session, event):
        calls.append(event.id)
        if case == 'speech':
            controller.on_speech_start(session.owner)
            controller.on_speech_end(session.owner)
        return case != 'unsafe' or len(calls) == 1

    async def synthesize(text, instructions, deadline_s):
        assert text == '缓一缓，我陪你等复活。' and 0 < deadline_s <= 2.5
        if case == 'timeout':
            await asyncio.sleep(1.2)
            pytest.fail('Synthesis outlived the event deadline')
        return b'test-audio'

    async def decode(_):
        return long_audio()

    monkeypatch.setattr(watcher, 'revalidate', revalidate)
    monkeypatch.setattr(controller.breeze, 'synthesize', synthesize)
    monkeypatch.setattr('fullawake.gateway.interrupt_controller.game_audio_wav', decode)
    with client.websocket_connect('/ws/pet?player=1') as pet, client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, lifecycle=True, direct=True)
        phone.send_json(frame('game.watch', 2, {'action': 'start', 'requestId': 'start'}))
        start = phone.receive_json()
        assert start['type'] == 'game.watch.status' and start['payload']['status'] == 'started'

        def emit():
            session = watcher.session
            timestamp = monotonic() - (1.75 if case == 'timeout' else 0)
            session.pending = GameEvent(event_id, 'death', timestamp)
            controller.game_candidate(session, session.pending)
            if case == 'stale':
                session.pending = GameEvent(event_id, 'death', timestamp - 3)

        client.portal.call(emit)
        candidate = phone.receive_json()
        assert candidate['type'] == 'game.watch.event'
        assert candidate['payload']['watchId'] == start['payload']['watchId']
        assert set(candidate['payload']) == {'watchId', 'eventId', 'kind', 'outcome', 'remainingMs'}
        identity = {'epoch': INITIAL_EPOCH, 'utteranceId': 'scene-commentary'}
        phone.send_json(frame('audio.prepare', 3, {**identity, 'gameEventId': event_id}))
        reply = phone.receive_json()
        seq = 4
        if case == 'stale':
            assert reply['payload']['status'] == 'discarded' and not calls
        elif case == 'speech':
            assert reply['payload']['status'] == 'discarded' and calls == [event_id]
        else:
            assert reply['type'] == 'audio.prepared'
            phone.send_json(frame('audio.speak', seq, {**identity, 'text': '缓一缓，我陪你等复活。',
                                                       'voiceProfile': 'breezeblue', 'pitchShift': 0, 'deadlineMs': 2500}))
            seq += 1
            if case == 'played':
                bubble, audio = pet.receive_json(), pet.receive_json()
                assert audio['event'] == 'playback_audio' and len(calls) == 2
                pet.send_json({'event': 'playback_clock', 'mode': 'idle', 'outcome': 'played', 'utteranceId': bubble['utteranceId']})
            assert phone.receive_json()['payload']['status'] == ('played' if case == 'played' else 'discarded')
            assert gateway.watch.bridge_output is None
        replay = {'epoch': INITIAL_EPOCH + 1, 'utteranceId': 'again', 'gameEventId': event_id}
        phone.send_json(frame('audio.prepare', seq, replay))
        assert phone.receive_json()['payload']['status'] == 'discarded'
        phone.send_json(frame('game.watch', seq + 1, {'action': 'stop', 'requestId': 'stop'}))
        assert phone.receive_json()['payload']['reason'] == 'stopped'
        assert phone.receive_json()['payload']['status'] == 'stopped'
    assert watcher.session is None


@pytest.mark.parametrize('change_focus', [None, 'synthesis', 'playback'])
def test_direct_breezeblue_uses_prepared_active_game_lease(bridge, monkeypatch, change_focus):
    client, gateway = bridge
    game = (41, 9, 'Hades.exe', {'left': 0})
    active, begun, cancelled = Event(), Event(), Event()
    active.set()
    monkeypatch.setattr(config, 'breeze_api_key', 'fixture-only')
    monkeypatch.setattr('fullawake.gateway.interrupt_controller.active_game_window',
                        lambda: game if active.is_set() else None)
    mp3 = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=523:d=0.3',
                          '-f', 'mp3', 'pipe:1'], check=True, capture_output=True).stdout

    async def synthesize(text, instructions, deadline_s):
        assert text == '稳住呀。' and instructions == '轻笑' and 0 < deadline_s <= 8
        begun.set()
        if change_focus == 'synthesis':
            try:
                await asyncio.Future()
            finally:
                cancelled.set()
        return mp3

    monkeypatch.setattr(gateway.interrupts.breeze, 'synthesize', synthesize)
    with client.websocket_connect('/ws/pet?player=1') as pet, client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, lifecycle=True, direct=True)
        identity = {'epoch': INITIAL_EPOCH, 'utteranceId': 'direct-commentary'}
        phone.send_json(frame('audio.prepare', 2, {**identity, 'gameProcess': game[2]}))
        assert phone.receive_json()['type'] == 'audio.prepared'
        phone.send_json(frame('audio.speak', 3, {**identity, 'text': '稳住呀。', 'instructions': '轻笑',
                                                  'voiceProfile': 'breezeblue', 'deadlineMs': 15000}))
        assert begun.wait(2)
        if change_focus == 'synthesis':
            active.clear()
            assert phone.receive_json()['payload']['status'] == 'discarded'
            assert cancelled.wait(2)
            assert gateway.watch.bridge_output is None
        else:
            bubble, playback = pet.receive_json(), pet.receive_json()
            assert bubble['text'] == '稳住呀。' and playback['event'] == 'playback_audio'
            assert base64.b64decode(playback['audioBase64']).startswith(b'RIFF')
            if change_focus == 'playback':
                active.clear()
                assert phone.receive_json()['payload']['status'] == 'discarded'
                stopped = pet.receive_json()
                assert stopped['event'] == 'playback_clock' and stopped['mode'] == 'idle'
                assert stopped['utteranceId'] == bubble['utteranceId']
            else:
                pet.send_json({'event': 'playback_clock', 'mode': 'idle', 'outcome': 'played', 'utteranceId': bubble['utteranceId']})
                assert phone.receive_json()['payload']['status'] == 'played'


def test_duplex_stream_correlates_each_sentence_and_retains_media_lease(bridge, monkeypatch):
    client, gateway = bridge
    rendered = []

    async def synthesize(request, disconnected):
        rendered.append(request['text'])
        return {'audioBase64': long_audio()}

    monkeypatch.setattr(gateway.voice, 'synthesize', synthesize)
    with client.websocket_connect('/ws/pet?player=1') as pet, client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, capture=True, lifecycle=True)
        speak(phone, 2, INITIAL_EPOCH, '一，二。')
        first = pet.receive_json()
        assert first['text'] == '一，' and pet.receive_json()['event'] == 'playback_audio'

        def receipt(utterance):
            pet.send_json({'event': 'playback_clock', 'mode': 'idle', 'outcome': 'played', 'utteranceId': utterance})

        receipt(first['utteranceId'])
        second = pet.receive_json()
        assert second['text'] == '二。' and pet.receive_json()['event'] == 'playback_audio'
        assert first['utteranceId'] != second['utteranceId']
        receipt(first['utteranceId'])
        assert gateway.watch.audio_leases.active.token == second['utteranceId']
        receipt(second['utteranceId'])
        assert phone.receive_json()['payload']['status'] == 'played'
        assert gateway.watch.audio_leases.active is None
        assert rendered == ['一，', '二。']


def test_epoch_switch_disables_route_without_touching_legacy_pet(bridge, monkeypatch):
    client, _ = bridge
    monkeypatch.setattr(config, 'epoch_revocation_enabled', False)
    with client.websocket_connect('/ws/pet?player=1'):
        with pytest.raises(WebSocketDisconnect), client.websocket_connect('/ws/bridge', headers=AUTH):
            pytest.fail('Disabled voice bridge accepted')


def test_renderer_heartbeat_expires_and_releases_lease(bridge):
    client, gateway = bridge
    with client.websocket_connect('/ws/pet?player=1&heartbeat=1') as pet:
        first_ping = pet.receive_json()
        assert first_ping['event'] == 'ping'
        def start():
            return [gateway.watch.play_bridge('speech', '你好', long_audio(), 10000)]
        receipt, = client.portal.call(start)
        assert pet.receive_json()['hasAudio']
        audio = pet.receive_json()
        assert audio['durationMs'] == 10_000 and len(audio['visemes']) == 500
        with pytest.raises(WebSocketDisconnect) as ended:
            while True:
                pet.receive_json()
        assert ended.value.code == 1011
    assert receipt.result() == 'discarded'
    assert gateway.watch.audio_leases.active is None and gateway.watch.player is None


@pytest.mark.parametrize('trigger', ['http', 'pet'])
def test_song_queues_behind_speech_and_explicit_interrupt_revokes(bridge, monkeypatch, tmp_path, trigger):
    client, gateway = bridge
    # Enable only this test's HTTP playback access without starting the production workers.
    monkeypatch.setattr(config, 'voice_enabled', True)
    song = tmp_path / 'song.mp3'
    song.write_bytes(b'ID3' + bytes(200))
    monkeypatch.setattr(gateway.voice, 'get_singing_song_file', lambda *_: song)
    with client.websocket_connect('/ws/pet?player=1&heartbeat=1') as pet:
        ping = pet.receive_json()
        pet.send_json({'event': 'pong', 'nonce': ping['nonce']})
        client.portal.call(lambda: [gateway.watch.play_bridge('speech', '你好', long_audio(), 10000)])
        assert pet.receive_json()['event'] == 'action'
        assert pet.receive_json()['event'] == 'playback_audio'
        response = client.post('/v1/voice/sing/play/task-1')
        assert response.json() == {'status': 'queued'}
        pet.send_json({'event': 'playback_clock', 'mode': 'idle', 'outcome': 'played', 'utteranceId': 'speech'})
        action, source = pet.receive_json(), pet.receive_json()
        assert source['event'] == 'playback_song' and source['task'] == 'task-1'
        assert source['utteranceId'] == action['utteranceId']
        if trigger == 'http':
            assert client.post('/v1/voice/playback/interrupt').is_success
        else:
            pet.send_json({'event': 'interrupt_request'})
        assert pet.receive_json()['mode'] == 'idle'
        assert gateway.watch.audio_leases.active is None


def test_renderer_receives_phone_heart_mood(bridge):
    client, _ = bridge
    with client.websocket_connect('/ws/pet?player=1&heartbeat=1') as pet:
        ping = pet.receive_json()
        pet.send_json({'event': 'pong', 'nonce': ping['nonce']})
        assert client.post('/v1/pet/mood?mood=tired').status_code == 204
        assert pet.receive_json() == {'event': 'heart_mood', 'mood': 'tired'}
        assert client.post('/v1/pet/mood?mood=unknown').status_code == 422


def test_handshake_opens_capture_and_disconnect_releases_it(bridge, monkeypatch):
    client, gateway = bridge
    stopped = Event()

    class Capture:
        def __init__(self, on_start, on_end, *, device):
            assert device == 1

        def start(self):
            return True

        def stop(self):
            stopped.set()

    monkeypatch.setattr(config, 'voice_vad_enabled', True)
    monkeypatch.setattr(config, 'voice_vad_device', 1)
    monkeypatch.setattr('fullawake.gateway.interrupt_controller.VoiceVadListener', Capture)
    with client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, vad_supported=True)
    assert stopped.is_set() and gateway.interrupts.peer is None


@pytest.mark.parametrize('pitch', [False, -2])
def test_bridge_rejects_unapproved_pitch(bridge, pitch):
    client, _ = bridge
    with client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone)
        phone.send_json(frame('audio.speak', 2, {
            'epoch': 100, 'utteranceId': 'invalid', 'text': 'invalid',
            'voiceProfile': 'feiyu-rvc-v1', 'pitchShift': pitch, 'deadlineMs': 4000,
        }))
        with pytest.raises(WebSocketDisconnect) as error:
            phone.receive_json()
        assert error.value.code == 1008


def test_local_stop_precedes_phone_notice_and_blocks_replays(bridge, monkeypatch):
    client, gateway = bridge
    rendered = []
    audio = long_audio()

    async def synth(request, disconnected):
        rendered.append(request['text'])
        return {'audioBase64': audio}

    monkeypatch.setattr(gateway.voice, 'synthesize', synth)
    with client.websocket_connect('/ws/pet?player=1') as pet, client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone)
        peer = gateway.interrupts.peer
        speak(phone, 2, 105, 'old')
        old_id = pet.receive_json()['utteranceId']
        assert pet.receive_json()['audioBase64'] == audio
        assert client.portal is not None
        start = monotonic()
        client.portal.call(gateway.interrupts.on_speech_start, peer)
        event = pet.receive_json()
        assert event['event'] == 'interrupt' and event['utteranceId'] == old_id
        assert monotonic() - start < 2  # Hardware latency has a separate measurement.
        pet.send_json({'event': 'interrupt_ack', 'utteranceId': old_id, 'interruptId': event['interruptId'],
                       'elapsedAudioMs': 1380})
        notice = phone.receive_json()
        assert notice['type'] == 'audio.interrupt'
        assert notice['payload'] == {'abortedEpoch': 105, 'utteranceId': 'old', 'reason': 'near_end_speech',
                                     'localAudioStopped': True, 'elapsedAudioMs': 1380}
        assert peer.revoked_epochs[105] > monotonic()
        client.portal.call(gateway.interrupts.on_speech_end, peer)

        phone.send_json(frame('audio.interrupt_ack', 3, {'abortedEpoch': 105, 'currentEpoch': 107}))
        speak(phone, 4, 105, 'late')
        speak(phone, 5, 106, 'below-ack-floor')
        client.portal.call(peer.prune_revoked, monotonic() + REVOKED_TTL)
        assert not peer.revoked_epochs
        for seq in range(6, 56):
            speak(phone, seq, 105, 'after-ttl')
        speak(phone, 5, 107, 'out-of-order-sequence')
        speak(phone, 56, 107, 'fresh')
        action = pet.receive_json()
        assert action['text'] == 'fresh' and action['utteranceId'] != old_id
        assert pet.receive_json()['event'] == 'playback_audio'
        assert rendered == ['old', 'fresh']


def test_late_synthesis_result_cannot_render_and_reconnect_resets_epoch(bridge, monkeypatch):
    client, gateway = bridge
    started, finish, complete = asyncio.Event(), asyncio.Event(), asyncio.Event()
    audio = long_audio()

    async def synth(request, disconnected):
        if request['text'] == 'slow':
            started.set()
            await finish.wait()
            assert await disconnected()
            complete.set()
        return {'audioBase64': audio}

    monkeypatch.setattr(gateway.voice, 'synthesize', synth)

    async def wait(event):
        await asyncio.wait_for(event.wait(), 3)

    with client.websocket_connect('/ws/pet?player=1') as pet:
        with client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
            handshake(phone)
            speak(phone, 2, 105, 'slow')
            client.portal.call(wait, started)
            old_peer = gateway.interrupts.peer
            client.portal.call(gateway.interrupts.on_speech_start, old_peer)
            assert phone.receive_json()['payload']['localAudioStopped'] is False
            client.portal.call(finish.set)
            client.portal.call(wait, complete)
        with client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
            handshake(phone, 'new-connection')
            client.portal.call(gateway.interrupts.on_speech_start, old_peer)
            speak(phone, 2, 100, 'after-reconnect', 'new-connection')
            assert pet.receive_json()['text'] == 'after-reconnect'
            assert pet.receive_json()['event'] == 'playback_audio'


def test_vad_requires_consecutive_voiced_frames_and_rearms_after_silence():
    events = []

    class Detector:
        def is_speech(self, pcm, rate):
            assert rate == 16_000 and len(pcm) == 640
            return any(pcm)

    gate = SpeechGate(Detector(), 16_000, lambda: events.append('start'), lambda: events.append('end'))
    quiet = bytes(640)
    voice = b'\x00\x02' * 320
    gate.feed(voice)
    gate.feed(quiet)
    assert events == []
    for _ in range(4):
        gate.feed(voice)
    assert events == ['start']
    for _ in range(12):
        gate.feed(quiet)
    assert events == ['start', 'end']
    gate.feed(voice)
    gate.feed(voice)
    assert events == ['start', 'end', 'start']


def test_vad_interrupts_prepared_epoch_before_speak(bridge):
    client, gateway = bridge
    with client.websocket_connect('/ws/pet?player=1'), client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, lifecycle=True)
        turn = {'epoch': 101, 'utteranceId': 'preparing'}
        phone.send_json(frame('audio.prepare', 2, turn))
        assert phone.receive_json()['type'] == 'audio.prepared'
        client.portal.call(gateway.interrupts.on_speech_start, gateway.interrupts.peer)
        notice = phone.receive_json()
        assert notice['type'] == 'audio.interrupt'
        assert notice['payload']['abortedEpoch'] == 101
        assert notice['payload']['localAudioStopped'] is False


@pytest.mark.parametrize('outcome', ['played', 'text_delivered', 'discarded'])
def test_terminal_result_requires_correlated_renderer_receipt(bridge, monkeypatch, outcome):
    client, gateway = bridge

    async def synth(_request, disconnected):
        return {'audioBase64': long_audio()}

    monkeypatch.setattr(gateway.voice, 'synthesize', synth)
    with client.websocket_connect('/ws/pet?player=1') as pet, client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, lifecycle=True)
        turn = {'epoch': 101, 'utteranceId': 'prepared'}
        phone.send_json(frame('audio.prepare', 2, turn))
        assert phone.receive_json()['payload'] == turn
        if outcome == 'text_delivered':
            phone.send_json(frame('pet.text', 3, {**turn, 'text': 'test', 'intent': 'nod'}))
        else:
            speak(phone, 3, 101, 'prepared')
        action = pet.receive_json()
        assert action['bridgeText'] is (outcome == 'text_delivered')
        if outcome != 'text_delivered':
            assert pet.receive_json()['event'] == 'playback_audio'
        pet.send_json({'event': 'playback_clock', 'mode': 'idle', 'utteranceId': 'previous', 'outcome': 'played'})
        pet.send_json({'event': 'playback_clock', 'mode': 'idle', 'utteranceId': action['utteranceId'], 'outcome': outcome})
        assert phone.receive_json()['payload'] == {**turn, 'status': outcome}


def test_vad_cancels_running_pc_tts_task(bridge, monkeypatch):
    client, gateway = bridge
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def synth(_request, disconnected):
        started.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    async def wait(event):
        await asyncio.wait_for(event.wait(), 2)

    monkeypatch.setattr(gateway.voice, 'synthesize', synth)
    with client.websocket_connect('/ws/pet?player=1'), client.websocket_connect('/ws/bridge', headers=AUTH) as phone:
        handshake(phone, lifecycle=True)
        speak(phone, 2, 101, 'in-synthesis')
        client.portal.call(wait, started)
        client.portal.call(gateway.interrupts.on_speech_start, gateway.interrupts.peer)
        client.portal.call(wait, cancelled)
        assert phone.receive_json()['type'] == 'audio.interrupt'
