import asyncio
import base64
from io import BytesIO
import json
from threading import Event
from time import monotonic
import wave

from fastapi.testclient import TestClient
import pytest
from starlette.websockets import WebSocketDisconnect

from fullawake.capabilities.voice import ASSETS
from fullawake.capabilities.voice_vad import SpeechGate
from fullawake.core.config import config
from fullawake.gateway.interrupt_controller import INITIAL_EPOCH, REVOKED_TTL
from fullawake.gateway.mcp_server import FullAwakeMCPGateway

AUTH = {'Authorization': 'Bearer bridge-test-only'}


def frame(kind, seq, payload, connection='test-connection'):
    return {'protocol': 'lucid.voice/1', 'type': kind, 'commandSeq': seq,
            'sessionId': 'test-session', 'connectionId': connection, 'payload': payload}


def handshake(phone, connection='test-connection', *, vad_supported=False, lifecycle=False):
    phone.send_json(frame('session.handshake', 1, {
        'clientVersion': '0.2.6' if lifecycle else '0.2.5', 'heartVersion': '0.21.3', 'device': 'redmi-note12turbo',
    }, connection))
    reply = phone.receive_json()
    assert reply['type'] == 'session.handshake_ack'
    assert reply['commandSeq'] == 1 and reply['connectionId'] == connection
    assert reply['payload']['initialEpoch'] == INITIAL_EPOCH
    assert reply['payload']['vadSupported'] is vad_supported
    assert reply['payload'].get('turnLifecycle', False) is lifecycle


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


def test_epoch_switch_disables_route_without_touching_legacy_pet(bridge, monkeypatch):
    client, _ = bridge
    monkeypatch.setattr(config, 'epoch_revocation_enabled', False)
    with client.websocket_connect('/ws/pet?player=1'):
        with pytest.raises(WebSocketDisconnect), client.websocket_connect('/ws/bridge', headers=AUTH):
            pytest.fail('Disabled voice bridge accepted')


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
