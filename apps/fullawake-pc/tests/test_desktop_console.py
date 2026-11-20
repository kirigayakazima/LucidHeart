from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from fullawake.capabilities.desktop_vision import screen
from fullawake.gateway import desktop_console
from fullawake.gateway.mcp_server import FullAwakeMCPGateway
from fullawake.core.config import config
from test_voice_bridge import AUTH, frame


@pytest.fixture
def console(monkeypatch):
    secret = 'desktop-private-test-fixture-token-123'
    monkeypatch.setenv('FULLAWAKE_DESKTOP_TOKEN', secret)
    monkeypatch.setenv('FULLAWAKE_WATCH_TOKEN', 'watch-private-test-fixture-token-123')
    monkeypatch.setattr(config, 'auth_token', 'bridge-test-only')
    monkeypatch.setattr(config, 'voice_vad_enabled', False)
    monkeypatch.setattr(desktop_console, 'is_desktop_locked', lambda: False)
    monkeypatch.setattr(desktop_console, 'enumerate_sources',
                        lambda thumbnails=False: ([{'id': 2, 'name': '外接屏'}], []))
    gateway = FullAwakeMCPGateway()
    with TestClient(gateway.app, client=('127.0.0.1', 45555)) as client:
        yield client, gateway, {'Authorization': f'Bearer {secret}'}


def test_api_uses_independent_local_token_and_shared_capture_target(console, monkeypatch):
    client, gateway, headers = console
    endpoint = '/v1/desktop/'
    assert client.get(endpoint + 'state').status_code == 403
    assert client.get(endpoint + 'state', headers=AUTH).status_code == 403
    assert client.get(endpoint + 'state', headers={**headers, 'Origin': 'http://localhost'}).status_code == 403
    with TestClient(gateway.app, client=('192.0.2.1', 12345)) as remote:
        assert remote.get(endpoint + 'state', headers=headers).status_code == 403
    assert client.get(endpoint + 'sources', headers=headers).json()['monitors'][0]['id'] == 2
    assert client.post(endpoint + 'target', headers=headers, json={'kind': 'monitor', 'monitor_id': 0}).status_code == 422
    assert client.post(endpoint + 'target', headers=headers, json={'kind': 'monitor', 'monitor_id': 2}).json()['label'] == '外接屏'
    capture = Mock(return_value={'data_url': 'data:image/jpeg;base64,fixture', 'is_blank': True, 'capture_backend': 'mss'})
    monkeypatch.setattr(desktop_console, 'capture_screenshot', capture)
    assert client.get(endpoint + 'preview', headers=headers).json()['is_blank']
    assert gateway.desktop.capture_target() == gateway.watch.capture_target() == {'monitor_id': 2, 'console_target': True}
    assert capture.call_args.kwargs['monitor_id'] == 2
    monkeypatch.setattr(gateway.interrupts, 'vad', Mock(rms=.1, ptt_active=False))
    changed = client.post(endpoint + 'audio/config', headers=headers, json={'vad_mode': 'ptt', 'ptt_key': 'F9', 'muted': True})
    assert changed.json()['muted']
    gateway.interrupts.vad.configure.assert_called_once_with('f9', True)
    with client.websocket_connect('/ws/desktop', headers=headers) as events:
        assert events.receive_json()['ptt_key'] == 'f9'


def test_dxgi_black_retries_mss_and_reports_when_both_blank(monkeypatch):
    area = {'left': 0, 'top': 0, 'width': 32, 'height': 18}
    grab = Mock(return_value=SimpleNamespace(size=(32, 18), bgra=bytes([20, 30, 40, 0]) * 576))
    capture = SimpleNamespace(grab=grab)
    monkeypatch.setattr(screen, '_grab_dxgi', lambda _: Image.new('RGB', (32, 18), 'black'))
    assert screen.grab_area(capture, area)[1:] == ('mss', False)
    grab.assert_called_once_with(area)
    grab.return_value.bgra = bytes(32 * 18 * 4)
    assert screen.grab_area(capture, area)[1:] == ('mss', True)
    monkeypatch.setattr(screen, '_grab_dxgi', lambda _: Image.new('RGB', (32, 18), 'red'))
    assert screen.grab_area(capture, area)[1:] == ('dxcam', False)


def test_desktop_call_and_watch_wait_for_correlated_phone_replies(console, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    client, gateway, headers = console
    async def start_watch(*_args, **_kwargs):
        return {'status': 'started'}
    monkeypatch.setattr(gateway.watch, 'control', start_watch)
    with client.websocket_connect('/ws/bridge', headers=AUTH) as phone, ThreadPoolExecutor() as pool:
        phone.send_json(frame('session.handshake', 1, {
            'clientVersion': '0.2.14', 'heartVersion': '0.21.5', 'device': 'fixture', 'capture': True,
        }))
        assert phone.receive_json()['type'] == 'session.handshake_ack'
        call = pool.submit(client.post, '/v1/desktop/call', headers=headers, json={'enabled': True})
        request = phone.receive_json()
        assert request['type'] == 'pc.call_request'
        phone.send_json(frame('voice.call', 2, {'requestId': 'voice-rpc', 'active': True}))
        assert phone.receive_json()['type'] == 'voice.call.status'
        phone.send_json(frame('call.state', 3, {'requestId': 'unrelated', 'active': True, 'accepted': True}))
        assert not call.done()
        phone.send_json(frame('call.state', 4, {'requestId': request['payload']['requestId'], 'active': True, 'accepted': True}))
        assert call.result(timeout=3).json()['call_active']
        watch = pool.submit(client.post, '/v1/desktop/watch', headers=headers, json={'action': 'start', 'mode': 'desktop'})
        request = phone.receive_json()
        assert request['type'] == 'pc.watch_request'
        phone.send_json(frame('watch.state', 5, {'requestId': request['payload']['requestId'], 'active': True, 'accepted': True}))
        assert watch.result(timeout=3).json()['accepted']
