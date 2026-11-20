import base64
import asyncio
from io import BytesIO
import time
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from fullawake.capabilities.desktop_vision import screen
from fullawake.capabilities.desktop_vision.game_storyboard import GameStoryboard, select_frames
from fullawake.core.config import config
from fullawake.gateway.mcp_server import app, FullAwakeMCPGateway


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


def snapshot(gateway_app=app, **arguments):
    reply = TestClient(gateway_app).post('/mcp', headers={'Authorization': f'Bearer {config.auth_token}'}, json={
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


@pytest.mark.parametrize(('region', 'bounds'), [
    ('full', (0, 0, 1600, 1000)), ('left', (0, 0, 800, 1000)), ('right', (800, 0, 800, 1000)),
    ('top', (0, 0, 1600, 500)), ('bottom', (0, 500, 1600, 500)), ('center', (400, 250, 800, 500)),
    ('top_left', (0, 0, 880, 550)), ('top_right', (720, 0, 880, 550)),
    ('bottom_left', (0, 450, 880, 550)), ('bottom_right', (720, 450, 880, 550)),
    ('minimap', (720, 450, 880, 550)),
])
def test_region_zooms_before_resizing_and_returns_one_budgeted_image(desktop, region, bounds):
    desktop.size, desktop.origin = (1600, 1000), (0, 0)
    result = snapshot(region=region)
    assert not result['isError'] and len(result['content']) == 2
    image, text = result['content']
    metadata = json.loads(text['text'])
    assert metadata['region'] == region and metadata['estimated_visual_tokens'] == 384
    assert metadata['crop_rect'] == dict(zip(('left', 'top', 'width', 'height'), bounds))
    assert metadata['original_size'] == {'width': 1600, 'height': 1000}
    with Image.open(BytesIO(base64.b64decode(image['data']))) as picture:
        assert max(picture.size) <= 768
        assert abs(picture.width / picture.height - bounds[2] / bounds[3]) < .01


def test_region_crop_keeps_the_selected_pixels_and_rejects_invalid_requests(desktop):
    image = Image.new('RGB', (200, 100), 'blue')
    image.paste(Image.new('RGB', (100, 100), 'red'), (0, 0))
    left, _ = screen.crop_region(image, 'left')
    right, _ = screen.crop_region(image, 'right')
    assert left.getpixel((50, 50)) == (255, 0, 0)
    assert right.getpixel((50, 50)) == (0, 0, 255)
    for region in ['unknown', None, [], 5]:
        assert snapshot(region=region)['isError']
    assert snapshot(mode='burst', region='left')['isError']
    assert not desktop.grabs
    desktop.locked = True
    assert snapshot(region='left')['isError']
    assert not desktop.grabs


def test_burst_returns_one_ordered_768_jpeg(desktop):
    gateway = FullAwakeMCPGateway()
    identity, _ = screen.probe_game()
    at = time.monotonic() - 3
    for i, color in enumerate([(220, 20, 20), (20, 220, 20), (20, 20, 220), (220, 220, 20)]):
        gateway.desktop.storyboard.record(identity, Image.new('RGB', (384, 216), color), at + i)
    result = snapshot(gateway.app, mode='burst')
    assert not result['isError'] and len(result['content']) == 2
    image, meta = result['content']
    metadata = json.loads(meta['text'])
    assert metadata['frame_count'] == 4 and metadata['duration_s'] == 3.0
    with Image.open(BytesIO(base64.b64decode(image['data']))) as sheet:
        assert sheet.size == (768, 768)
        for i, rgb in enumerate([(220, 20, 20), (20, 220, 20), (20, 20, 220), (220, 220, 20)]):
            x, y = i % 2 * 384, i // 2 * 384
            assert max(abs(a - b) for a, b in zip(sheet.getpixel((x + 192, y + 192)), rgb)) < 6
            assert sheet.getpixel((x + 10, y + 10))[0] > 200
    assert desktop.grabs == []


def test_significant_motion_peak_replaces_an_interior_sample():
    frames = [(i, Image.new('RGB', (32, 18), (240 if i >= 4 else 40,) * 3)) for i in range(6)]
    assert [at for at, _ in select_frames(frames)] == [0, 2, 4, 5]


def test_buffer_is_bounded_and_flushes_on_lock_and_switch(desktop):
    story = GameStoryboard()
    identity, _ = screen.probe_game()
    at = time.monotonic()
    for i in range(9):
        story.record(identity, Image.new('RGB', (20, 20)), at - 8 + i)
    assert len(story.frames) == 6
    desktop.locked = True
    assert asyncio.run(story.snapshot())['locked'] and not story.frames
    desktop.locked = False
    story.record(identity, Image.new('RGB', (20, 20)), at)
    desktop.process = 'chrome.exe'
    assert asyncio.run(story.snapshot())['code'] == 'no_foreground_game' and not story.frames


def test_friendly_pet_pixels_are_masked_from_thumbnail(desktop):
    desktop.covered = True
    screen.ctypes.windll.user32.GetPropW = lambda *_: 1
    screen.ctypes.windll.user32.GetWindowRect = lambda _, pointer: _set_pet_rect(pointer._obj)
    result = screen.capture_screenshot(auto_game=True, sample=True)
    image = result['image']
    assert image.getpixel((15, 15)) == (20, 20, 24)
    assert image.getpixel((300, 150)) == (210, 70, 30)


def _set_pet_rect(rect):
    rect.left, rect.top, rect.right, rect.bottom = 10, 10, 70, 70
    return 1


def test_burst_with_switch_during_encoding_discards_the_sheet(desktop, monkeypatch):
    from fullawake.capabilities.desktop_vision import game_storyboard

    story = GameStoryboard()
    identity, _ = screen.probe_game()
    for i in range(4):
        story.record(identity, Image.new('RGB', (20, 20)), time.monotonic() - 3 + i)
    encode = game_storyboard.encode_snapshot

    def change_foreground(*args, **kwargs):
        desktop.process = 'chrome.exe'
        return encode(*args, **kwargs)

    monkeypatch.setattr(game_storyboard, 'encode_snapshot', change_foreground)
    result = asyncio.run(story.snapshot())
    assert result['code'] == 'no_foreground_game' and 'base64_data' not in result
    assert not story.frames
