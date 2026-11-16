"""An in-memory storyboard of the currently shared foreground game."""

import asyncio
from collections import deque
import logging
import time

from PIL import Image, ImageChops, ImageDraw, ImageStat

from .screen import capture_screenshot, encode_snapshot, probe_game


def select_frames(frames):
    """Preserve the endpoints and keep a strong motion peak if uniform samples miss it."""
    last = len(frames) - 1
    indexes = [round(last * slot / 3) for slot in range(4)]
    small = [frame.convert('L').resize((32, 18), Image.Resampling.BOX) for _, frame in frames]
    motion = [ImageStat.Stat(ImageChops.difference(a, b)).mean[0] for a, b in zip(small, small[1:])]
    peak = max(range(1, last + 1), key=lambda i: motion[i - 1])
    if peak not in indexes and motion[peak - 1] >= max(12, 1.5 * sorted(motion)[len(motion) // 2]):
        slot = min((1, 2), key=lambda i: abs(indexes[i] - peak))
        indexes[slot] = peak
    return [frames[i] for i in sorted(indexes)]


def contact_sheet(frames):
    sheet = Image.new('RGB', (768, 768), (20, 20, 24))
    draw = ImageDraw.Draw(sheet)
    end = frames[-1][0]
    for index, (at, frame) in enumerate(select_frames(frames)):
        x, y = (index % 2) * 384, (index // 2) * 384
        sheet.paste(frame, (x + (384 - frame.width) // 2, y + (384 - frame.height) // 2))
        draw.rectangle((x + 8, y + 8, x + 114, y + 31), fill=(255, 220, 65))
        draw.text((x + 15, y + 12), f'[{index + 1}]  {at - end:+.1f}s', fill=(30, 25, 0))
    return sheet


class GameStoryboard:
    def __init__(self):
        self.frames = deque(maxlen=6)
        self.game = None
        self.generation = 0

    def clear(self):
        self.frames.clear()
        self.game = None
        self.generation += 1

    def record(self, game, image, at):
        if game != self.game or (self.frames and at - self.frames[-1][0] > 1.75):
            self.clear()
        self.game = game
        self.frames.append((at, image))

    @staticmethod
    def _sample():
        game, _ = probe_game()
        if game is not None:
            return capture_screenshot(auto_game=True, sample=True)
        return {}

    async def run(self):
        next_sample = 0
        try:
            while True:
                at = time.monotonic()
                if at >= next_sample:
                    next_sample = at + 1
                    try:
                        frame = await asyncio.to_thread(self._sample)
                    except (OSError, RuntimeError, ValueError):
                        logging.getLogger(__name__).debug('Game thumbnail unavailable', exc_info=True)
                        frame = {}
                    if 'image' in frame:
                        self.record(frame['game'], frame['image'], at)
                    else:
                        self.clear()
                await asyncio.sleep(max(0, next_sample - time.monotonic()))
        finally:
            self.clear()

    async def snapshot(self):
        game, error = await asyncio.to_thread(probe_game)
        if error or game != self.game:
            self.clear()
        if error:
            return error
        generation = self.generation
        now = time.monotonic()
        frames = tuple(frame for frame in self.frames if now - frame[0] <= 6)
        if len(frames) < 4 or now - frames[-1][0] > 1.75:
            return {'error': '前台游戏的分镜还没攒够，请保持游戏在前台几秒后再试。', 'code': 'game_burst_unavailable'}
        result = await asyncio.to_thread(
            lambda: encode_snapshot(contact_sheet(frames), target='auto_game', game_process=game[2],
                                    mode='burst', frame_count=4, duration_s=round(frames[-1][0] - frames[0][0], 1)),
        )
        current, error = await asyncio.to_thread(probe_game)
        if error or game != current:
            self.clear()
            return error or {'error': '生成分镜时前台游戏已变化。', 'code': 'game_changed'}
        if generation != self.generation:
            return {'error': '分镜缓存已重置，请保持游戏在前台后再试。', 'code': 'game_changed'}
        return result
