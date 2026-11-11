from concurrent.futures import ThreadPoolExecutor
import base64
from io import BytesIO
import json
import time
import wave

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from fullawake.capabilities.desktop_vision.see_now import DifferentialScreenSampler
from fullawake.gateway.mcp_server import FullAwakeMCPGateway

TOKEN = 'a-local-watch-test-token-only'


def jpeg(color):
    buf = BytesIO()
    Image.new('RGB', (384, 216), color).save(buf, format='JPEG')
    return base64.b64encode(buf.getvalue()).decode()


def test_static_frames_hard_cuts_and_real_compositor():
    sampler = DifferentialScreenSampler(target_grid=9)
    black = Image.new('RGB', (384, 216), 'black')
    white = Image.new('RGB', (384, 216), 'white')
    for second in range(8):
        assert sampler.process_frame(black, second) is None
    for second in range(8, 14):
        assert sampler.process_frame(black if second % 2 else white, second).diff_score >= 0.45
    sheet, data = sampler.pack_contact_sheet()
    assert sheet.size == (768, 768)
    assert data == {'frames_count': 6, 'timecodes': list(range(8, 14)), 'token_cost': 384}
    assert sheet.getpixel((128, 128)) == (255, 255, 255)
    assert sheet.getpixel((128, 250)) != (255, 255, 255)
    sampler.prune(45)
    assert not sampler.frames


@pytest.fixture
def bridge(monkeypatch):
    monkeypatch.setenv('FULLAWAKE_WATCH_TOKEN', TOKEN)
    monkeypatch.setattr('fullawake.capabilities.desktop_vision.watch.is_desktop_locked', lambda: False)
    gateway = FullAwakeMCPGateway()
    with TestClient(gateway.app, client=('127.0.0.1', 45555)) as client:
        yield client, gateway.watch


def clock(client, second, *, seq=None, segment=0, frame=None, subtitles=(), **extra):
    return client.post('/v1/watch/clock', headers={'x-fullawake-watch': TOKEN}, json={
        'client': 'bilibili-web-player', 'source': 'browser_123', 'segment': segment,
        'sequence': int(second) if seq is None else seq, 'videoId': 'BVexample', 'title': 'Test',
        'playbackPositionSec': second, 'durationSec': 400, 'paused': False, 'speed': 1,
        'frame': frame, 'subtitles': list(subtitles), **extra,
    })


def mcp(client, tool='pc_watch_get_summary', headers=None, **args):
    response = client.post('/mcp', headers=headers, json={
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': tool, 'arguments': args},
    })
    response.raise_for_status()
    return response.json()


def summary(client, **args):
    blocks = mcp(client, **args)['result']['content']
    return json.loads(next(b['text'] for b in blocks if b['type'] == 'text')), [b for b in blocks if b['type'] == 'image']


def scene(client):
    assert clock(client, 10, frame={'mediaTime': 10, 'jpeg': jpeg('black')}).is_success
    assert clock(client, 11, frame={'mediaTime': 11, 'jpeg': jpeg('white')}, subtitles=[
        {'start': 10, 'end': 11, 'text': 'already played'},
        {'start': 10, 'end': 12, 'text': 'future ending'},
        {'start': 12, 'end': 13, 'text': 'future line'},
    ]).is_success
    return summary(client)


def test_clock_filters_future_replay_and_cross_origin(bridge):
    client, watch = bridge
    cue, images = scene(client)
    assert len(images) == 1 and images[0]['mimeType'] == 'image/png'
    assert Image.open(BytesIO(base64.b64decode(images[0]['data']))).size == (768, 768)
    assert cue['watchedInterval'] == [10, 11] and cue['tokenCost'] == 384
    assert [s['text'] for s in cue['subtitles']] == ['already played']
    assert clock(client, 11, frame={'mediaTime': 11, 'jpeg': jpeg('black')}).status_code == 409
    assert clock(client, 12, frame={'mediaTime': 13, 'jpeg': jpeg('black')}).is_success
    assert summary(client)[0]['timecodes'] == [11]
    assert mcp(client, headers={'Origin': 'https://www.bilibili.com'})['error']['message'] == 'WATCH_LOOPBACK_ONLY'
    assert client.post('/v1/watch/clock', json={}).status_code == 403
    assert client.post('/v1/watch/clock', headers={'x-fullawake-watch': TOKEN}, content=b'x' * 120_001).status_code == 413
    assert clock(client, 4, seq=13, segment=1, seeking=True).is_success
    after, images = summary(client)
    assert after['watchSessionId'] == cue['watchSessionId'] and after['timelineId'] != cue['timelineId']
    assert after['subtitles'] == [] and images == []
    watch.received -= 4
    assert summary(client)[0]['status'] == 'inactive'


def test_clock_reports_latest_visual_difference_without_rendering(bridge):
    client, watch = bridge
    assert clock(client, 10, frame={'mediaTime': 10, 'jpeg': jpeg('black')}).is_success
    initial, _ = summary(client, clockOnly=True)
    assert initial['latestCandidateDiff'] is None
    assert clock(client, 11, frame={'mediaTime': 11, 'jpeg': jpeg('white')}).is_success
    metadata, images = summary(client, clockOnly=True)
    assert metadata['latestCandidateSec'] == 11
    assert 0.4 <= metadata['latestCandidateDiff'] <= 1
    assert metadata['tokenCost'] == 0 and images == [] and watch.cached_sheet is None


def test_stopping_share_clears_frames_and_allows_a_new_clock(bridge):
    client, watch = bridge
    first, _ = scene(client)
    assert watch.cached_sheet
    assert clock(client, 11, seq=12, stopped=True).json()['watchSessionId'] is None
    assert watch.cached_sheet is None and not watch.sampler.frames
    assert summary(client)[0]['status'] == 'inactive'
    assert clock(client, 11, seq=1, source='different_tab').json()['watchSessionId'] != first['watchSessionId']


def test_control_is_queued_until_browser_ack(bridge):
    client, _ = bridge
    cue, _ = scene(client)
    reply = mcp(client, 'pc_watch_control', watchSessionId=cue['watchSessionId'], action='pause')
    queued = json.loads(reply['result']['content'][0]['text'])
    assert queued['status'] == 'queued'
    assert clock(client, 12).json()['command'] == {'id': queued['id'], 'action': 'pause'}
    assert clock(client, 12, seq=13, paused=True, controlId=queued['id'], controlApplied=True).json()['command'] is None
    assert summary(client, clockOnly=True)[0]['control'] == {'id': queued['id'], 'status': 'applied'}


def reaction_wav():
    buf = BytesIO()
    with wave.open(buf, 'wb') as output:
        output.setparams((1, 2, 40000, 0, 'NONE', 'not compressed'))
        output.writeframes(b'\x00\x12' * 4000)
    return base64.b64encode(buf.getvalue()).decode()


@pytest.mark.parametrize('seek', [False, True])
def test_reaction_rechecks_browser_after_synthesis_and_relays_playback(bridge, seek):
    client, watch = bridge
    with client.websocket_connect('/ws/pet?player=1') as pet, ThreadPoolExecutor(max_workers=1) as pool:
        cue, _ = scene(client)
        post = pool.submit(client.post, '/v1/watch/reaction', json={
            'watchSessionId': cue['watchSessionId'], 'cueId': cue['cueId'], 'text': '哇！', 'intent': 'shock',
            'audioBase64': reaction_wav(),
        })
        deadline = time.monotonic() + 1
        while not watch.pending and time.monotonic() < deadline:
            time.sleep(0.01)
        assert watch.pending
        assert clock(client, 4 if seek else 12, seq=12, segment=int(seek), seeking=seek).is_success
        assert post.result(timeout=3).json()['status'] == ('discarded' if seek else 'dispatched')
        if not seek:
            action = pet.receive_json()
            audio = pet.receive_json()
            assert action['event'] == 'action' and action['text'] == '哇！'
            assert audio['audioBase64'] == reaction_wav()
            pet.send_json({'mode': 'speaking', 'utteranceId': action['utteranceId'], 'positionMs': 35, 'mouth': 2})
            assert pet.receive_json()['mouth'] == 2
            assert clock(client, 13, segment=1, seeking=True).is_success
            assert pet.receive_json()['mode'] == 'idle'
