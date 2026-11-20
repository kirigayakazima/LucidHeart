import asyncio
import base64
from io import BytesIO
import time
from PIL import Image
from fullawake.capabilities.desktop_vision import watch

def test_desktop_start_sheet_lock_resume_stop_and_browser_priority(monkeypatch):
    locked = False
    color = 'black'
    source_key = 'window-one'
    def capture(*args, **kwargs):
        buf = BytesIO()
        Image.new('RGB', (768, 432), color).save(buf, format='JPEG')
        return {'success': True, 'base64_data': base64.b64encode(buf.getvalue()).decode()}
    monkeypatch.setattr(watch, 'capture_screenshot', capture)
    monkeypatch.setattr(watch, 'desktop_source_key', lambda _: source_key)
    monkeypatch.setattr(watch, 'is_desktop_locked', lambda: locked)
    async def run():
        nonlocal locked, color, source_key
        service = watch.WatchCapability(token='test-token-desktop-long-enough')
        assert (await service.control({'action': 'start'}))['status'] == 'started'
        first = await service.summary({})
        assert first['watchSessionId'].startswith('desktop-')
        assert first['frameCount'] == 1 and first['tokenCost'] == 384
        image = Image.open(BytesIO(base64.b64decode(first['imageBase64'])))
        assert image.size == (768, 768)
        assert first['watchedInterval'][0] <= first['timecodes'][0] <= first['playbackPositionSec']
        source_key = 'window-two'
        await service.desktop_tick()
        assert (await service.summary({}))['timelineId'] != first['timelineId']
        locked = True
        await service.desktop_tick()
        assert (await service.summary({}))['status'] == 'inactive'
        locked = False
        color = 'white'
        await service.desktop_tick()
        assert (await service.summary({}))['status'] == 'playing'
        clock = watch.PlayerClock(client='browser', source='browser-source', segment=0, sequence=1, videoId='video',
            title='browser', playbackPositionSec=1., durationSec=100., paused=False, speed=1.)
        await service.accept_clock(clock, time.monotonic())
        await service.desktop_tick()
        assert service.clock.client == 'browser'
        await service.control({'action': 'stop'})
        assert service.desktop_task is None
    asyncio.run(run())
