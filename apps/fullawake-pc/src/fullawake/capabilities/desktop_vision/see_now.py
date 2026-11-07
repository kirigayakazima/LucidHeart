"""Select recent presented video frames, using playback seconds as the clock."""

from collections import deque
from dataclasses import dataclass
from io import BytesIO
import json
import math
import os
from pathlib import Path
import subprocess

from PIL import Image, ImageChops


@dataclass(frozen=True)
class FrameCandidate:
    timestamp_sec: float
    diff_score: float
    image: Image.Image


class DifferentialScreenSampler:
    def __init__(self, min_diff_threshold=0.06, shot_cut_threshold=0.35,
                 max_buffer_seconds=30.0, target_grid=9):
        if target_grid not in (4, 9):
            raise ValueError('Expected 4 or 9 cells')
        self.min_diff_threshold = min_diff_threshold
        self.shot_cut_threshold = shot_cut_threshold
        self.max_buffer_seconds = max_buffer_seconds
        self.target_grid = target_grid
        self.reset()

    def reset(self):
        self.frames = deque(maxlen=90)
        self.previous = None
        self.last_sec = None
        self.motion = 0.0

    def prune(self, playback_sec):
        while self.frames and self.frames[0].timestamp_sec < playback_sec - self.max_buffer_seconds:
            self.frames.popleft()

    def process_frame(self, current_img, playback_sec):
        if not math.isfinite(playback_sec) or playback_sec < 0:
            raise ValueError('Invalid playback timestamp')
        if self.last_sec is not None and playback_sec < self.last_sec:
            self.reset()
        self.last_sec = playback_sec
        self.prune(playback_sec)

        sample = current_img.convert('RGB').resize((64, 36), Image.Resampling.BILINEAR)
        hue, saturation, value = sample.convert('HSV').split()
        # Suppress unstable hue in gray regions and bucket all three channels.
        hsv = Image.merge('RGB', (ImageChops.multiply(hue, saturation), saturation, value))
        histogram = hsv.histogram()
        bins = [sum(histogram[i:i + 16]) for i in range(0, 768, 16)]
        if self.previous is None:
            self.previous = (sample, bins)
            return None
        previous, previous_bins = self.previous
        self.previous = (sample, bins)
        pixels = 64 * 36 * 3
        difference = ImageChops.difference(previous, sample).histogram()
        mean = sum((i % 256) * count for i, count in enumerate(difference)) / (255 * pixels)
        changed = sum(count for i, count in enumerate(difference) if i % 256 >= 28) / pixels
        histogram_delta = sum(abs(a - b) for a, b in zip(bins, previous_bins)) / (2 * pixels)
        score = 0.4 * mean + 0.4 * changed + 0.2 * histogram_delta
        self.motion = 0.7 * self.motion + max(0.0, score - 0.025)
        if score < self.min_diff_threshold and self.motion < self.min_diff_threshold:
            return None
        # Collapse neighboring motion samples while keeping distinct hard cuts.
        if self.frames and playback_sec - self.frames[-1].timestamp_sec < 0.6 and score < self.shot_cut_threshold:
            return None
        candidate = FrameCandidate(playback_sec, min(1.0, max(score, self.motion)), current_img.copy())
        self.frames.append(candidate)
        self.motion = 0.0
        return candidate

    def select(self, duration_sec=15.0, *, until_sec=None):
        end = self.last_sec if until_sec is None else until_sec
        if end is None:
            return []
        recent = [frame for frame in self.frames if end - duration_sec <= frame.timestamp_sec <= end]
        ranked = sorted(recent, key=lambda frame: (frame.diff_score >= self.shot_cut_threshold,
                                                   frame.diff_score, frame.timestamp_sec), reverse=True)
        return sorted(ranked[:self.target_grid], key=lambda frame: frame.timestamp_sec)

    def pack_contact_sheet(self, duration_sec=15.0):
        frames = self.select(duration_sec)
        image = Image.open(BytesIO(render_contact_sheet(frames, self.target_grid)))
        image.load()
        return image, {'frames_count': len(frames), 'timecodes': [f.timestamp_sec for f in frames], 'token_cost': 384}


def render_contact_sheet(frames, cells):
    """Use the sovereign storyboard compositor with only already-decoded RGB cells."""
    cell_size = 768 // math.isqrt(cells)
    payload = bytearray()
    header = {'cells': cells, 'frames': []}
    for frame in frames:
        image = frame.image.convert('RGB')
        image.thumbnail((cell_size, cell_size), Image.Resampling.LANCZOS)
        header['frames'].append([image.width, image.height, frame.timestamp_sec])
        payload.extend(image.tobytes())
    renderer = Path(os.environ.get('FULLAWAKE_WATCH_COMPOSITOR') or
                    Path(__file__).resolve().parents[4] / 'scripts/watch_contact_sheet.mjs')
    return subprocess.run(
        ['node', str(renderer)], input=json.dumps(header).encode() + b'\n' + payload,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=4,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    ).stdout
