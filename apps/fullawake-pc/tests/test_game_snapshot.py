import base64
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from fullawake.capabilities.desktop_vision import screen
from fullawake.core.config import config
from fullawake.gateway.mcp_server import app


@pytest.fixture
def desktop(monkeypatch):
    state = SimpleNamespace(process='Hades.exe', title='Hades', size=(640, 360), origin=(10, 10),
                            color=(30, 70, 210, 255), locked=False, covered=False, moved=False, grabs=[])
    user = SimpleNamespace(
        GetForegroundWindow=Mock(side_effect=lambda: 42 if state.moved and state.grabs else 41),
        IsWindowVisible=lambda _: True, IsIconic=lambda _: False,
        GetWindow=Mock(side_effect=lambda hwnd, _: 88 if hwnd == 41 and state.covered else 0),
    )

    def bounds(_, pointer):
        pointer._obj.right, pointer._obj.bottom = state.size
        return 1

    def origin(_, pointer):
        pointer._obj.x, pointer._obj.y = state.origin
        return 1

    def pid(_, pointer):
        pointer._obj.value = 999
        return 1

    def title(_, buffer, _length):
        buffer.value = state.title
        return len(state.title)

    user.GetClientRect, user.ClientToScreen = bounds, origin
    user.GetWindowRect = bounds
    user.GetWindowThreadProcessId, user.GetWindowTextW = pid, title
    monkeypatch.setattr(screen.ctypes, 'windll', SimpleNamespace(user32=user))
    monkeypatch.setattr(screen, 'get_process_name', lambda _: state.process)
    monkeypatch.setattr(screen, 'is_window_cloaked', lambda _: False)
    monkeypatch.setattr(screen, 'is_desktop_locked', lambda **_: state.locked)
    monkeypatch.setattr(config, 'game_processes', ['hades.exe', 'league of legends.exe', 'valorant-win64-shipping.exe'])

    class Capture:
        monitors = [{'left': -1920, 'top': 0, 'width': 3840, 'height': 1080},
                    {'left': 0, 'top': 0, 'width': 1920, 'height': 1080},
                    {'left': -1920, 'top': 0, 'width': 1920, 'height': 1080}]

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def grab(self, region):
            state.grabs.append(region.copy())
            w, h = region['width'], region['height']
            return SimpleNamespace(size=(w, h), bgra=bytes(state.color) * (w * h))

    monkeypatch.setattr(screen.mss, 'MSS', Capture, raising=False)
    return state


def snapshot(**arguments):
    reply = TestClient(app).post('/mcp', headers={'Authorization': f'Bearer {config.auth_token}'}, json={
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
        'params': {'name': 'pc_snapshot', 'arguments': {'target': 'auto_game', **arguments}},
    })
    assert reply.is_success
    return reply.json()['result']


@pytest.mark.parametrize(('process', 'origin', 'size', 'compressed'), [
    ('League of Legends.exe', (50, 100), (1300, 800), (1170, 720)),
    ('VALORANT-Win64-Shipping.exe', (-1920, 0), (1920, 1080), (1280, 720)),
    ('Hades.exe', (150, 120), (960, 540), (960, 540)),
])
def test_game_client_to_mcp_jpeg(desktop, process, origin, size, compressed):
    desktop.process, desktop.origin, desktop.size = process, origin, size
    result = snapshot()
    assert not result['isError']
    assert desktop.grabs == [dict(left=origin[0], top=origin[1], width=size[0], height=size[1])]
    image, metadata = result['content']
    assert image['type'] == 'image' and image['mimeType'] == 'image/jpeg'
    assert 'auto_game' in metadata['text'] and process in metadata['text']
    with Image.open(BytesIO(base64.b64decode(image['data']))) as picture:
        assert picture.size == compressed


@pytest.mark.parametrize(('overrides', 'expected', 'grab_count'), [
    ({'process': 'chrome.exe'}, 'no_foreground_game', 0),
    ({'title': 'axing_private'}, 'no_foreground_game', 0),
    ({'locked': True}, 'locked', 0),
    ({'covered': True}, 'game_occluded', 0),
    ({'origin': (-10, 0)}, 'game_outside_display', 0),
    ({'moved': True}, 'game_changed', 1),
    ({'color': (0, 0, 0, 255)}, 'game_blank', 1),
])
def test_unsafe_or_unusable_frame_never_returns_image(desktop, overrides, expected, grab_count):
    vars(desktop).update(overrides)
    result = snapshot()
    assert result['isError']
    assert len(result['content']) == 1 and expected in result['content'][0]['text']
    assert len(desktop.grabs) == grab_count


def test_target_and_window_handle_are_exclusive(desktop):
    result = snapshot(hwnd=41)
    assert result['isError'] and 'invalid_target' in result['content'][0]['text']
    assert not desktop.grabs
