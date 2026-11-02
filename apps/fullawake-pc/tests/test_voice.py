import json
import pytest
from fastapi.testclient import TestClient
from fullawake.core.config import config
from fullawake.capabilities.voice import DEFAULTS, ASSETS, prepare_profile
from fullawake.gateway.mcp_server import gateway


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
    p, text = prepare_profile(voice_setup)
    assert text == '测试短句' and p['pitch'] == 0
    with pytest.raises(ValueError, match='VOICE_REQUEST_INVALID'):
        prepare_profile({**voice_setup, 'python': 'untrusted.exe'})
    voice_setup['voice']['assets']['model.onnx'] = 'b' * 64
    with pytest.raises(ValueError, match='VOICE_ASSET_MISMATCH'):
        prepare_profile(voice_setup)


def test_voice_auth_disabled_and_body_limit(voice_setup, monkeypatch):
    client = TestClient(gateway.app)
    assert client.post('/v1/voice/rvc', json=voice_setup).status_code == 401
    headers = {'Authorization': f'Bearer {config.auth_token}'}
    assert client.post('/v1/voice/rvc', content=b'x' * 16385, headers=headers).status_code == 413
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
