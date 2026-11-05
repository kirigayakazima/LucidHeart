import base64
import json
import pytest
from fastapi.testclient import TestClient
from fullawake.core.config import config
from fullawake.capabilities.voice import DEFAULTS, ASSETS, prepare_profile
from fullawake.gateway.mcp_server import gateway
from fullawake.capabilities.voice import read_voice_audio, MAX_AUDIO_BYTES


@pytest.fixture
def voice_setup(tmp_path, monkeypatch):
    profile = {'engine': 'rvc-onnx', 'id': 'feiyu-rvc-v1', 'modelsDir': '.',
               'assets': {name: {'sha256': 'a' * 64} for name in ASSETS}}
    filename = tmp_path / 'profile.json'
    filename.write_text(json.dumps(profile), encoding='utf8')
    monkeypatch.setattr(config, 'voice_profile', str(filename))
    monkeypatch.setattr(config, 'voice_enabled', True)
    monkeypatch.setattr(config, 'voice_clients', ['testclient'])
    settings = {**DEFAULTS, 'synthesisMode': 'continuous', 'indexMethod': 'l2-8'}
    return {'text': '测试短句', 'voice': {'id': profile['id'],
            'assets': {name: 'a' * 64 for name in ASSETS}, 'settings': settings}}


def test_exact_voice_contract_and_no_remote_paths(voice_setup):
    p, text, audio = prepare_profile(voice_setup)
    assert text == '测试短句' and p['pitch'] == 0 and audio is None
    with pytest.raises(ValueError, match='VOICE_REQUEST_INVALID'):
        prepare_profile({**voice_setup, 'python': 'untrusted.exe'})
    voice_setup['voice']['assets']['model.onnx'] = 'b' * 64
    with pytest.raises(ValueError, match='VOICE_ASSET_MISMATCH'):
        prepare_profile(voice_setup)


def test_voice_auth_disabled_and_body_limit(voice_setup, monkeypatch):
    client = TestClient(gateway.app)
    assert client.post('/v1/voice/rvc', json=voice_setup).status_code == 401
    headers = {'Authorization': f'Bearer {config.auth_token}'}
    assert client.post('/v1/voice/rvc', content=b'x' * (12 * 1024 * 1024 + 1), headers=headers).status_code == 413
    monkeypatch.setattr(config, 'voice_enabled', False)
    assert client.post('/v1/voice/rvc', json=voice_setup, headers=headers).status_code == 503


def test_authenticated_voice_response_does_not_return_pc_paths(voice_setup, monkeypatch):
    async def synthesize(request, disconnected):
        assert request == voice_setup
        return {'ok': True, 'audioBase64': 'YWJj', 'mode': 'pc_onnx_offload'}
    monkeypatch.setattr(gateway.voice, 'synthesize', synthesize)
    client = TestClient(gateway.app)
    response = client.post('/v1/voice/rvc', json=voice_setup,
                           headers={'Authorization': f'Bearer {config.auth_token}'})
    assert response.status_code == 200
    assert 'audioPath' not in response.json()
    monkeypatch.setattr(config, 'voice_clients', ['127.0.0.1'])
    assert client.post('/v1/voice/rvc', json=voice_setup,
                      headers={'Authorization': f'Bearer {config.auth_token}'}).status_code == 403


def test_long_voice_audio_accepts_over_old_one_mib_limit(tmp_path):
    output = tmp_path / 'long.wav'
    audio = b'RIFF' + bytes(4) + b'WAVE' + bytes(1600000)
    output.write_bytes(audio)
    assert read_voice_audio(output) == audio
    output.write_bytes(b'not-a-wave' + bytes(100))
    with pytest.raises(ValueError, match='VOICE_AUDIO_INVALID'):
        read_voice_audio(output)


def test_large_output_rejected_before_read():
    class Oversized:
        def stat(self):
            class Stat: st_size = MAX_AUDIO_BYTES + 1
            return Stat()
        def read_bytes(self): raise AssertionError('must not read oversized audio')
    with pytest.raises(ValueError, match='VOICE_AUDIO_INVALID'):
        read_voice_audio(Oversized())


def test_audio_base64_payload(voice_setup):
    raw_wav = b'RIFF' + bytes(4) + b'WAVE' + bytes(100)
    audio_req = {
        'audioBase64': base64.b64encode(raw_wav).decode('ascii'),
        'voice': voice_setup['voice'],
    }
    p, text, audio = prepare_profile(audio_req)
    assert text is None
    assert audio == raw_wav
    # Cannot have both text and audioBase64
    with pytest.raises(ValueError, match='VOICE_REQUEST_INVALID'):
        prepare_profile({**audio_req, 'text': 'conflict'})
    # Invalid base64 or non-WAVE
    with pytest.raises(ValueError, match='VOICE_AUDIO_INVALID'):
        prepare_profile({**audio_req, 'audioBase64': 'bad base64!!!'})
    with pytest.raises(ValueError, match='VOICE_AUDIO_INVALID'):
        prepare_profile({**audio_req, 'audioBase64': base64.b64encode(b'NOT_A_WAV_HEADER').decode('ascii')})
