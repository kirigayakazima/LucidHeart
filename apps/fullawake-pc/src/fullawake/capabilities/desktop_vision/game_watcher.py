"""Foreground-only visual candidates for a user-started game watch."""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass, field
import json
from pathlib import Path
import time
from uuid import uuid4

from PIL import Image, ImageChops, ImageStat

from .screen import capture_screenshot, probe_game

POLL_SECONDS = 2.5
AWAY_SECONDS = 180
EVENT_SECONDS = 2.5
SIGNATURE_SIZE = (24, 12)


def _roi(box):
    if (not isinstance(box, list) or len(box) != 4 or
            not all(type(point) in (int, float) and 0 <= point <= 1 for point in box)
            or box[2] - box[0] < .02 or box[3] - box[1] < .02):
        raise ValueError('Invalid game ROI')
    return tuple(box)


def _crop(frame, roi):
    x0, y0, x1, y1 = roi
    return frame.crop((int(frame.width * x0), int(frame.height * y0),
                       int(frame.width * x1), int(frame.height * y1)))


def _signature(image):
    return image.convert('L').resize(SIGNATURE_SIZE, Image.Resampling.BOX)


def _difference(first, second):
    return ImageStat.Stat(ImageChops.difference(first, second)).mean[0] / 255


@dataclass(frozen=True)
class Marker:
    roi: tuple
    reference: Image.Image

    def present(self, frame):
        return _difference(_signature(_crop(frame, self.roi)), self.reference) <= .075


@dataclass(frozen=True)
class GameProfile:
    death: Marker
    timer: tuple
    victory: Marker
    defeat: Marker
    base: Marker
    minimap: Marker


def load_profiles(file):
    if not file:
        return {}
    path = Path(file).resolve()
    with path.open(encoding='utf-8-sig') as stream:
        raw = json.load(stream)
    if not isinstance(raw, dict) or len(raw) > 16:
        raise ValueError('Invalid game watch profile list')

    def marker(entry):
        if not isinstance(entry, dict) or not isinstance(entry.get('template'), str):
            raise ValueError('Invalid game marker')
        asset = (path.parent / entry['template']).resolve()
        if not asset.is_relative_to(path.parent) or asset.stat().st_size > 512 * 1024:
            raise ValueError('Invalid game marker template path or size')
        try:
            with Image.open(asset, formats=['PNG', 'JPEG']) as template:
                if template.width < 4 or template.height < 4 or template.width * template.height > 200_000:
                    raise ValueError('Invalid game marker template dimensions')
                return Marker(_roi(entry['roi']), _signature(template))
        except Image.DecompressionBombError as error:
            raise ValueError('Invalid game marker template dimensions') from error

    profiles = {}
    for name, item in raw.items():
        key = name.casefold()
        if not key.endswith('.exe') or key in profiles or any(sep in key for sep in ('/', '\\')) or not isinstance(item, dict):
            raise ValueError('Invalid game executable or profile')
        profiles[key] = GameProfile(marker(item['death']), _roi(item['timer']), marker(item['victory']),
                                    marker(item['defeat']), marker(item['base']), marker(item['minimap']))
    return profiles


@dataclass(frozen=True)
class Sample:
    at: float
    scene: Image.Image
    saturation: float
    death: bool
    timer: Image.Image
    result: str | None
    base: bool
    minimap: Image.Image
    base_map: bool


def measure_frame(image, at, profile):
    small = image.resize((32, 18), Image.Resampling.BOX)
    timer = _signature(_crop(image, profile.timer))
    win, loss = profile.victory.present(image), profile.defeat.present(image)
    minimap = _signature(_crop(image, profile.minimap.roi))
    return Sample(at, _signature(small), ImageStat.Stat(small.convert('HSV')).mean[1] / 255,
                  profile.death.present(image), timer, ('win' if win else 'loss') if win != loss else None,
                  profile.base.present(image), minimap, profile.minimap.present(image))


def timer_visible(timer):
    pixels = timer.histogram()
    return sum(pixels[175:]) >= 3 and sum(pixels[:90]) >= 10


@dataclass(frozen=True)
class GameEvent:
    id: str
    type: str
    timestamp: float
    outcome: str | None = None
    snapshot_burst: tuple[float, ...] = ()  # Local sample timestamps. Image features remain in the session.


@dataclass
class WatchSession:
    owner: object
    game: tuple
    profile: GameProfile
    id: str = field(default_factory=lambda: uuid4().hex)
    frames: deque = field(default_factory=lambda: deque(maxlen=2))
    state: str = 'playing'
    away_since: float | None = None
    base_since: float | None = None
    base_reset_seen: bool = False
    pending: GameEvent | None = None
    claimed: bool = False

    def suspend(self, now):
        if self.away_since is None:
            self.away_since = now
        self.frames.clear()
        self.state, self.base_since, self.pending, self.claimed = 'playing', None, None, False
        self.base_reset_seen = False

    def update(self, sample):
        self.away_since = None
        previous = self.frames[-1] if self.frames else None
        self.frames.append(sample)
        if previous is None:
            return None
        motion = _difference(previous.scene, sample.scene)
        stationary = motion < .055
        base = sample.base and sample.base_map
        if not base:
            self.base_reset_seen = False
            self.base_since = None
        else:
            if not previous.base_map and _difference(previous.minimap, sample.minimap) >= .065:
                self.base_reset_seen = True
            if not stationary:
                self.base_since = None
            elif self.base_reset_seen and self.base_since is None:
                self.base_since = sample.at
        death = (sample.death and sample.saturation < .15 and timer_visible(sample.timer) and
                 (self.state == 'death' or (previous.saturation - sample.saturation >= .14 and
                  _difference(previous.timer, sample.timer) >= .08)) and motion < .22)
        result = sample.result if stationary and sample.result == previous.result else None
        recall = base and self.base_since is not None and sample.at - self.base_since >= 4
        state = 'victory' if result else 'death' if death else 'recall' if recall else 'playing'
        changed = self.state != state
        self.state = state
        if changed:
            self.pending, self.claimed = None, False
        if changed and state != 'playing':
            self.pending = GameEvent(uuid4().hex, state, sample.at, result, tuple(frame.at for frame in self.frames))
            return self.pending
        return None

    def permits(self, event, sample):
        if self.pending is not event or not self.frames or _difference(self.frames[-1].scene, sample.scene) >= .08:
            return False
        if event.type == 'death':
            return sample.death and sample.saturation < .15 and timer_visible(sample.timer)
        if event.type == 'victory':
            return sample.result == event.outcome
        return sample.base and sample.base_map


class GameWatcher:
    def __init__(self, profiles, *, clock=time.monotonic, probe=probe_game,
                 capture=capture_screenshot):
        self.profiles = profiles
        self.clock, self.probe, self.capture = clock, probe, capture
        self.session = None

    async def start(self, owner):
        if self.session is not None:
            return self.session if self.session.owner is owner else None
        try:
            game, _ = await asyncio.to_thread(self.probe)
        except (OSError, RuntimeError, ValueError):
            return None
        profile = self.profiles.get(game[2].casefold()) if game else None
        if profile is None:
            return None
        self.session = WatchSession(owner, game, profile)
        return self.session

    def stop(self, owner):
        if self.session is not None and self.session.owner is owner:
            session, self.session = self.session, None
            session.suspend(self.clock())
            return session

    def event(self, owner, event_id):
        session = self.session
        if session and session.owner is owner and session.pending and session.pending.id == event_id:
            return session, session.pending
        return None, None

    def _sample(self, session):
        game, error = self.probe()
        if game != session.game:
            return None, bool(error and error.get('locked'))
        image = self.capture(auto_game=True, sample=True)
        if image.get('game') != session.game:
            return None, bool(image.get('locked'))
        return measure_frame(image['image'], self.clock(), session.profile), False

    async def _read_sample(self, session):
        try:
            return await asyncio.to_thread(self._sample, session)
        except (OSError, RuntimeError, ValueError):
            return None, False

    async def revalidate(self, session, event):
        remaining = event.timestamp + EVENT_SECONDS - self.clock()
        if self.session is not session or session.pending is not event or remaining <= 0:
            return False
        try:
            sample, _ = await asyncio.wait_for(self._read_sample(session), remaining)
        except asyncio.TimeoutError:
            return False
        return (self.session is session and sample is not None and self.clock() < event.timestamp + EVENT_SECONDS
                and session.permits(event, sample))

    async def tick(self, on_event, on_end):
        session = self.session
        if session is None:
            return
        sample, locked = await self._read_sample(session)
        if self.session is not session:
            return
        if sample is None:
            now = self.clock()
            session.suspend(now)
            if locked or now - session.away_since >= AWAY_SECONDS:
                self.stop(session.owner)
                on_end(session, 'locked' if locked else 'away')
        elif (event := session.update(sample)) is not None:
            on_event(session, event)

    async def run(self, on_event, on_end):
        while True:
            start = self.clock()
            await self.tick(on_event, on_end)
            await asyncio.sleep(max(0, start + POLL_SECONDS - self.clock()))
