"""Loopback watch transport. The browser owns the clock and the phone owns reactions."""

import asyncio
import base64
import binascii
from collections import deque
from io import BytesIO
import hmac
from ipaddress import ip_address
import json
import math
import os
import re
import subprocess
import time
import uuid
import wave
from anyio import CancelScope

from fastapi import HTTPException, Request, WebSocket
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from fullawake.capabilities.base import BaseCapability, ToolDefinition
from fullawake.core.session import is_desktop_locked
from fullawake.acoustic_stitcher import utterance_sync
from fullawake.lease_arbiter import LeaseArbiter, PlaybackLease
from .see_now import DifferentialScreenSampler, render_contact_sheet

CLOCK_TTL = 3.0
REACTION_TTL = 15.0
MAX_WAV_BYTES = 1024 * 1024


class WatchInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)


class Subtitle(WatchInput):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=280)


class Sample(WatchInput):
    mediaTime: float = Field(ge=0)
    jpeg: str = Field(max_length=85_000)


class PlayerClock(WatchInput):
    client: str = Field(min_length=1, max_length=60)
    source: str = Field(pattern=r'^[a-zA-Z0-9_-]{8,80}$')
    segment: int = Field(ge=0, le=2**31 - 1)
    sequence: int = Field(ge=0, le=2**31 - 1)
    videoId: str = Field(pattern=r'^[a-zA-Z0-9_-]{1,100}$')
    title: str = Field(max_length=240)
    playbackPositionSec: float = Field(ge=0)
    durationSec: float = Field(gt=0, le=86400)
    paused: bool
    seeking: bool = False
    stopped: bool = False
    speed: float = Field(gt=0, le=16)
    subtitles: list[Subtitle] = Field(default_factory=list, max_length=24)
    frame: Sample | None = None
    controlId: str | None = Field(default=None, max_length=40)
    controlApplied: bool = False


class Reaction(WatchInput):
    watchSessionId: str = Field(max_length=140)
    cueId: str = Field(max_length=40)
    text: str = Field(min_length=1, max_length=120)
    intent: str = Field(pattern=r'^(nod|smile|wave|shock)$')
    audioBase64: str | None = Field(default=None, max_length=4 * ((MAX_WAV_BYTES + 2) // 3))


def loopback(scope):
    try:
        return bool(scope.client and ip_address(scope.client.host).is_loopback)
    except ValueError:
        return False


def native_loopback(scope):
    return loopback(scope) and 'origin' not in scope.headers


async def read_input(request, model, limit):
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, 'WATCH_REQUEST_TOO_LARGE')
        body.extend(chunk)
    try:
        return model.model_validate_json(body)
    except ValidationError as error:
        raise HTTPException(422, 'WATCH_INVALID_PAYLOAD') from error


def decode_frame(sample):
    try:
        with Image.open(BytesIO(base64.b64decode(sample.jpeg, validate=True)), formats=['JPEG']) as image:
            if 0 < image.width <= 384 and 0 < image.height <= 384:
                return image.convert('RGB')
    except (OSError, ValueError, Image.DecompressionBombError):
        pass
    return None


def wav_duration(encoded):
    data = base64.b64decode(encoded, validate=True)
    if len(data) > MAX_WAV_BYTES:
        raise ValueError('Invalid WAV size')
    with wave.open(BytesIO(data), 'rb') as wav:
        if wav.getnchannels() not in (1, 2) or wav.getsampwidth() != 2 or not 8000 <= wav.getframerate() <= 48000:
            raise ValueError('Invalid WAV format')
        duration = wav.getnframes() / wav.getframerate()
        if not 0 < duration <= 10:
            raise ValueError('Invalid WAV duration')
        if len(wav.readframes(wav.getnframes())) != wav.getnframes() * wav.getnchannels() * 2:
            raise ValueError('Truncated WAV')
        return round(duration * 1000)


class WatchCapability(BaseCapability):
    name = 'watch'
    description = 'Timestamped samples from an explicitly shared player'

    def __init__(self, token=None):
        self.token = os.getenv('FULLAWAKE_WATCH_TOKEN', '') if token is None else token
        self.sampler = DifferentialScreenSampler()
        self.clock = None
        self.received = 0.0
        self.session = None
        self.timeline = None
        self.start = 0.0
        self.subtitles = deque(maxlen=60)
        self.cues = {}
        self.pending = None
        self.active = None
        self.command = None
        self.command_result = None
        self.render_lock = asyncio.Lock()
        self.cached_sheet = None
        self.subscribers = set()
        self.player = None
        self.bridge_output = None
        self.bridge_receipt = None
        self.interrupt_receipt = None
        self.audio_leases = LeaseArbiter()
        self.song_output = None
        self.song_capable = False
        self.song_deadline = 0
        self.heart_mood = 'calm'

    def update_heart_mood(self, mood):
        if mood != self.heart_mood:
            self.heart_mood = mood
            self.publish({'event': 'heart_mood', 'mood': mood}, player_only=True)

    @staticmethod
    def _audio_event(utterance, audio, text, **metadata):
        sync = utterance_sync(base64.b64decode(audio, validate=True), text)
        return {'event': 'playback_audio', 'audioBase64': audio,
                'utteranceId': utterance, **sync, **metadata}

    def queue_song(self, task):
        if not self.player or not self.song_capable or is_desktop_locked():
            return None
        token = uuid.uuid4().hex

        def start():
            self.song_output = token
            self.song_deadline = time.monotonic() + 12
            self.publish({'event': 'action', 'utteranceId': token, 'hasAudio': True,
                          'intent': 'talk', 'song': True}, player_only=True)
            self.publish({'event': 'playback_song', 'utteranceId': token, 'task': task, 'song': True}, player_only=True)

        def stop():
            if self.song_output == token:
                self.song_output = None
                self.publish({'event': 'playback_clock', 'mode': 'idle', 'utteranceId': token}, player_only=True)

        return self.audio_leases.acquire(PlaybackLease(token, 'song', start, stop))

    def interrupt_media(self):
        if self.bridge_output is None:
            self.cancel_output(release=False)
            self.audio_leases.revoke()

    @property
    def enabled(self):
        return len(self.token) >= 24

    def available(self, now):
        return self.clock is not None and now - self.received < CLOCK_TTL and not is_desktop_locked()

    def playing(self, now):
        return self.available(now) and not self.clock.paused and not self.clock.seeking

    def reset(self, clock, new_video):
        if new_video:
            self.session = f'{clock.videoId}_{time.time_ns()}'
        self.timeline = uuid.uuid4().hex
        self.start = clock.playbackPositionSec
        self.clear_timeline()

    def clear_timeline(self):
        self.sampler.reset()
        self.subtitles.clear()
        self.cues.clear()
        self.cached_sheet = None
        self.command = self.command_result = None
        self.cancel_output()

    async def expire_clocks(self):
        while True:
            await asyncio.sleep(1)
            if self.clock and not self.available(time.monotonic()):
                self.detach_clock()

    def detach_clock(self):
        self.clock = self.timeline = self.session = None
        self.clear_timeline()

    def publish(self, event, *, player_only=False):
        for queue in tuple(self.subscribers):
            if player_only and queue is not self.player:
                continue
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(event)

    def cancel_output(self, *, bridge_utterance=None, interrupt_id=None, release=True):
        if bridge_utterance is not None:
            return self._stop_bridge(bridge_utterance, interrupt_id)
        if self.pending:
            _, _, waiter, _ = self.pending
            if not waiter.done():
                waiter.set_result(False)
            self.pending = None
        if self.active:
            token = self.active[0]
            self.active = None
            self.publish({'event': 'playback_clock', 'mode': 'idle', 'mouth': 0, 'positionMs': 0, 'utteranceId': token})
            if release:
                self.audio_leases.finish(token)

    def play_bridge(self, utterance, text, audio, duration_ms, intent='talk'):
        if not self.player or self.pending or self.bridge_output or self.audio_leases.active or is_desktop_locked():
            return None
        if self.active:
            if time.monotonic() < self.active[1]:
                return None
            self.cancel_output()
        playback = self._audio_event(utterance, audio, text, voiceBridge=True) if audio is not None else None
        self.bridge_output = utterance
        self.bridge_receipt = asyncio.get_running_loop().create_future()
        metadata = {'utteranceId': utterance, 'voiceBridge': True}

        def start():
            self.publish({'event': 'action', 'intent': intent, 'text': text, 'hasAudio': audio is not None,
                          'durationMs': duration_ms, 'bridgeText': audio is None, **metadata}, player_only=True)
            if playback is not None:
                self.publish(playback, player_only=True)

        if audio is None:
            start()
        else:
            self.audio_leases.acquire(PlaybackLease(utterance, 'speech', start, lambda: None))
        return self.bridge_receipt

    def _complete_bridge(self, outcome, *, release=True):
        token, self.bridge_output = self.bridge_output, None
        receipt, self.bridge_receipt = self.bridge_receipt, None
        if receipt and not receipt.done():
            receipt.set_result(outcome)
        if release:
            self.audio_leases.finish(token)

    def _stop_bridge(self, utterance, interrupt_id):
        if self.bridge_output != utterance:
            return None
        self._complete_bridge('discarded', release=False)
        if interrupt_id is not None:
            self.audio_leases.revoke()
        if not self.player:
            return None
        if interrupt_id is None:
            self.publish({'event': 'playback_clock', 'mode': 'idle', 'utteranceId': utterance}, player_only=True)
            self.audio_leases.finish(utterance)
            return None
        receipt = asyncio.get_running_loop().create_future()
        self.interrupt_receipt = (interrupt_id, utterance, receipt)

        def clear(_):
            if self.interrupt_receipt and self.interrupt_receipt[2] is receipt:
                self.interrupt_receipt = None

        receipt.add_done_callback(clear)
        self.publish({'event': 'interrupt', 'utteranceId': utterance, 'interruptId': interrupt_id}, player_only=True)
        return receipt

    async def accept_clock(self, clock, now):
        old = self.clock
        if clock.playbackPositionSec > clock.durationSec:
            raise HTTPException(422, 'WATCH_INVALID_POSITION')
        if old and self.available(now):
            if old.source != clock.source:
                raise HTTPException(409, 'WATCH_PLAYER_ALREADY_ACTIVE')
            if clock.sequence <= old.sequence or clock.segment < old.segment:
                raise HTTPException(409, 'WATCH_CLOCK_OUT_OF_ORDER')
        if clock.stopped:
            self.detach_clock()
            return {'ok': True, 'watchSessionId': None, 'command': None}
        offset = clock.playbackPositionSec - old.playbackPositionSec if old else 0
        new_video = not self.available(now) or old.videoId != clock.videoId
        if (new_video or old.segment != clock.segment or
                old.seeking != clock.seeking or offset < -0.1 or
                offset > (now - self.received) * max(clock.speed, old.speed) + 1.25):
            self.reset(clock, new_video)
        self.clock, self.received = clock, now
        at = clock.playbackPositionSec
        self.sampler.prune(at)
        if self.cached_sheet and any(t < at - 30 for t in self.cached_sheet[0][2]):
            self.cached_sheet = None
        if self.playing(now):
            sample = clock.frame
            if (sample and max(self.start, at - 1.5) <= sample.mediaTime <= at and
                    (self.sampler.last_sec is None or sample.mediaTime > self.sampler.last_sec)):
                image = decode_frame(sample)
                if image:
                    self.sampler.process_frame(image, sample.mediaTime)
        else:
            self.cues.clear()
            self.cancel_output()
        if not clock.seeking:
            for subtitle in clock.subtitles:
                item = (subtitle.start, subtitle.end, subtitle.text)
                if max(self.start, at - 30) <= subtitle.start < subtitle.end <= at and item not in self.subtitles:
                    self.subtitles.append(item)
        await self.flush_reaction(now)
        if self.command and self.command['id'] == clock.controlId:
            self.command_result = {'id': clock.controlId, 'status': 'applied' if clock.controlApplied else 'rejected'}
            self.command = None
        if self.command and now >= self.command['expires']:
            self.command_result = {'id': self.command['id'], 'status': 'expired'}
            self.command = None
        command = {k: self.command[k] for k in ('id', 'action')} if self.command else None
        return {'ok': True, 'watchSessionId': self.session, 'command': command}

    def valid_cue(self, session, cue, now):
        data = self.cues.get(cue)
        return (self.playing(now) and self.session == session and data is not None and
                now - data[1] < REACTION_TTL and 0 <= self.clock.playbackPositionSec - data[0] <= REACTION_TTL)

    async def flush_reaction(self, now):
        if not self.pending:
            return
        request, event, waiter, disconnected = self.pending
        gone = await disconnected()
        if not self.pending or self.pending[2] is not waiter:
            return
        self.pending = None
        if waiter.done():
            return
        allowed = (not gone and self.player is not None and self.bridge_output is None and not self.audio_leases.active and
                   self.valid_cue(request.watchSessionId, request.cueId, now))
        if allowed:
            self.cues.clear()
            self.active = (event['utteranceId'], now + max(4, event.get('audioDurationMs', 0) / 1000 + 2))
            playback = event.get('playback')
            self.publish({**{k: v for k, v in event.items() if k != 'playback'}, 'hasAudio': playback is not None})
            if playback is not None:
                token = event['utteranceId']
                self.audio_leases.acquire(PlaybackLease(token, 'speech',
                    lambda: self.publish(playback, player_only=True), lambda: None))
        waiter.set_result(allowed)

    async def summary(self, args):
        now = time.monotonic()
        if not self.enabled or not self.available(now):
            self.cancel_output()
            return {'status': 'inactive', 'widgetOnline': self.player is not None}
        duration = args.get('durationSec', 15)
        if type(duration) not in (int, float) or not math.isfinite(duration) or not 1 <= duration <= 30:
            return {'error': 'WATCH_INVALID_DURATION'}
        session, timeline, clock = self.session, self.timeline, self.clock
        end = clock.playbackPositionSec
        start = max(self.start, end - duration)
        latest = self.sampler.frames[-1] if self.sampler.frames else None
        result = {'status': 'paused' if not self.playing(now) else 'playing', 'watchSessionId': session, 'timelineId': timeline,
                  'videoId': clock.videoId, 'title': clock.title, 'playbackPositionSec': end,
                  'watchedInterval': [start, end], 'frameCount': 0, 'timecodes': [],
                  'tokenCost': 0, 'sceneAtSec': None, 'cueId': None, 'control': self.command_result,
                  'latestCandidateSec': latest.timestamp_sec if latest else None,
                  'latestCandidateDiff': latest.diff_score if latest else None,
                  'widgetOnline': self.player is not None,
                  'subtitles': [{'start': a, 'end': b, 'text': text} for a, b, text in self.subtitles
                                if start <= a < b <= end], 'emotionHint': 'calm'}
        if args.get('clockOnly') is True or result['status'] != 'playing':
            return result
        frames = self.sampler.select(duration, until_sec=end)
        if not frames:
            return result
        cells = self.sampler.target_grid
        key = (timeline, cells, tuple(f.timestamp_sec for f in frames))
        async with self.render_lock:
            if self.cached_sheet and self.cached_sheet[0] == key:
                encoded = self.cached_sheet[1]
            else:
                try:
                    image = await asyncio.to_thread(render_contact_sheet, frames, cells)
                except (OSError, subprocess.SubprocessError):
                    return {'error': 'WATCH_COMPOSITOR_UNAVAILABLE'}
                encoded = base64.b64encode(image).decode('ascii')
                if self.timeline == timeline:
                    self.cached_sheet = (key, encoded)
        now = time.monotonic()
        scene = frames[-1].timestamp_sec
        if self.timeline != timeline or not self.playing(now) or self.clock.playbackPositionSec < end:
            return {'status': 'stale'}
        self.cues = {cue: data for cue, data in self.cues.items() if now - data[1] < REACTION_TTL}
        cue = uuid.uuid4().hex
        if len(self.cues) >= 16:
            self.cues.pop(next(iter(self.cues)))
        self.cues[cue] = (scene, now)
        return {**result, 'frameCount': len(frames), 'timecodes': [f.timestamp_sec for f in frames],
                'tokenCost': 384, 'sceneAtSec': scene, 'cueId': cue, 'imageBase64': encoded,
                'emotionHint': 'surprised' if frames[-1].diff_score >= self.sampler.shot_cut_threshold else 'engaged'}

    async def control(self, args):
        now = time.monotonic()
        if not self.enabled or not self.available(now) or args.get('watchSessionId') != self.session:
            return {'status': 'inactive'}
        action = args.get('action')
        if action == 'sensitivity':
            value = args.get('sensitivity')
            if type(value) not in (int, float) or not 0.04 <= value <= 0.4:
                return {'error': 'WATCH_INVALID_SENSITIVITY'}
            self.sampler.min_diff_threshold = value
            return {'status': 'applied', 'sensitivity': value}
        if action not in ('pause', 'play'):
            return {'error': 'WATCH_INVALID_ACTION'}
        if self.command and now < self.command['expires']:
            return {'error': 'WATCH_CONTROL_BUSY'}
        self.command = {'id': uuid.uuid4().hex, 'action': action, 'expires': now + CLOCK_TTL}
        return {'status': 'queued', 'id': self.command['id']}

    def get_tools(self):
        return [ToolDefinition(name='pc_watch_get_summary', description='Read only presented video frames and completed subtitles',
                               parameters={'type': 'object', 'properties': {'durationSec': {'type': 'number', 'minimum': 1, 'maximum': 30},
                                                                           'clockOnly': {'type': 'boolean'}}}, handler=self.summary),
                ToolDefinition(name='pc_watch_control', description='Control only the explicitly shared player',
                               parameters={'type': 'object', 'required': ['action', 'watchSessionId'], 'properties': {
                                   'action': {'enum': ['pause', 'play', 'sensitivity']}, 'watchSessionId': {'type': 'string'},
                                   'sensitivity': {'type': 'number', 'minimum': 0.04, 'maximum': 0.4}}}, handler=self.control)]

    def mount(self, app, interrupt_playback=None):
        @app.post('/v1/watch/clock')
        async def clock_endpoint(request: Request):
            origin = request.headers.get('origin', '')
            supplied = request.headers.get('x-fullawake-watch', '')
            if (not self.enabled or not loopback(request) or
                    (origin and not re.fullmatch(r'chrome-extension://[a-p]{32}', origin)) or
                    not hmac.compare_digest(self.token.encode(), supplied.encode())):
                raise HTTPException(403, 'WATCH_CLOCK_FORBIDDEN')
            if is_desktop_locked():
                raise HTTPException(409, 'WATCH_DESKTOP_LOCKED')
            clock = await read_input(request, PlayerClock, 120_000)
            return await self.accept_clock(clock, time.monotonic())

        @app.post('/v1/watch/reaction')
        async def reaction_endpoint(request: Request):
            if not self.enabled or not native_loopback(request):
                raise HTTPException(403, 'WATCH_REACTION_FORBIDDEN')
            reaction = await read_input(request, Reaction, 1_410_000)
            now = time.monotonic()
            if (not self.player or not self.valid_cue(reaction.watchSessionId, reaction.cueId, now) or
                    self.pending or self.bridge_output or (self.active and now < self.active[1])):
                return {'status': 'discarded'}
            event = {'event': 'action', 'intent': reaction.intent, 'text': reaction.text,
                     'durationMs': 4000, 'utteranceId': uuid.uuid4().hex}
            if reaction.audioBase64:
                try:
                    event['audioDurationMs'] = wav_duration(reaction.audioBase64)
                    event['playback'] = self._audio_event(event['utteranceId'], reaction.audioBase64, reaction.text)
                except (ValueError, wave.Error, EOFError, binascii.Error) as error:
                    raise HTTPException(422, 'WATCH_INVALID_WAV') from error
            waiter = asyncio.get_running_loop().create_future()
            self.pending = (reaction, event, waiter, request.is_disconnected)
            try:
                # The next browser heartbeat confirms the scene survived synthesis.
                ok = await asyncio.wait_for(waiter, CLOCK_TTL)
            except asyncio.TimeoutError:
                ok = False
            finally:
                if self.pending and self.pending[2] is waiter:
                    self.pending = None
            return {'status': 'dispatched' if ok else 'discarded'}

        @app.websocket('/ws/pet')
        async def pet(socket: WebSocket):
            player = socket.query_params.get('player') == '1'
            if not self.enabled or not native_loopback(socket) or (player and self.player is not None) or len(self.subscribers) >= 8:
                await socket.close(code=1008)
                return
            queue = asyncio.Queue(maxsize=32)
            self.subscribers.add(queue)
            heartbeat = player and socket.query_params.get('heartbeat') == '1'
            last_pong = time.monotonic()
            next_ping = last_pong
            nonces = deque(maxlen=3)
            if player:
                self.player = queue
                self.song_capable = heartbeat

            async def relay():
                while True:
                    nonlocal next_ping
                    now = time.monotonic()
                    if heartbeat:
                        if now - last_pong >= 5:
                            await socket.close(code=1011, reason='RENDERER_DISCONNECTED')
                            return
                        if now >= next_ping:
                            nonce = uuid.uuid4().hex
                            nonces.append(nonce)
                            next_ping = now + 2
                            await asyncio.wait_for(socket.send_json({'event': 'ping', 'nonce': nonce}), 2)
                    if not self.playing(now):
                        self.cancel_output()
                    if player and self.song_output and (now >= self.song_deadline or is_desktop_locked()):
                        self.interrupt_media()
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=0.25)
                    except asyncio.TimeoutError:
                        continue
                    if event.get('voiceBridge') and self.bridge_output != event['utteranceId']:
                        continue
                    if event.get('song') and self.song_output != event['utteranceId']:
                        continue
                    await asyncio.wait_for(socket.send_json(event), 2)

            async def listen():
                nonlocal last_pong
                while True:
                    raw = await socket.receive_text()
                    if not player or len(raw) > 1024:
                        continue
                    try:
                        value = json.loads(raw)
                    except ValueError:
                        continue
                    if not isinstance(value, dict):
                        continue
                    if value.get('event') == 'interrupt_request':
                        if heartbeat and interrupt_playback:
                            interrupt_playback()
                        continue
                    if value.get('event') == 'pong':
                        nonce = value.get('nonce')
                        if heartbeat and nonce in nonces:
                            nonces.remove(nonce)
                            last_pong = time.monotonic()
                        continue
                    utterance = value.get('utteranceId')
                    if value.get('event') == 'interrupt_ack':
                        elapsed = value.get('elapsedAudioMs')
                        if self.interrupt_receipt and type(elapsed) is int and 0 <= elapsed <= 10_000:
                            interrupt_id, expected_utterance, receipt = self.interrupt_receipt
                            if (value.get('interruptId') == interrupt_id and utterance == expected_utterance
                                    and not receipt.done()):
                                receipt.set_result(elapsed)
                        continue
                    if self.song_output and utterance == self.song_output:
                        if value.get('event') == 'playback_clock' and value.get('mode') == 'idle':
                            self.song_output = None
                            self.audio_leases.finish(utterance)
                        elif value.get('event') == 'playback_clock' and value.get('mode') == 'speaking':
                            self.song_deadline = time.monotonic() + 5
                        continue
                    if self.bridge_output and utterance == self.bridge_output:
                        if value.get('mode') == 'idle':
                            outcome = value.get('outcome') if value.get('event') == 'playback_clock' else None
                            self._complete_bridge(outcome if outcome in ('played', 'text_delivered') else 'discarded')
                        continue
                    if not self.active or not self.playing(time.monotonic()) or utterance != self.active[0]:
                        continue
                    if value.get('mode') == 'idle':
                        self.cancel_output()
                    elif (value.get('mode') == 'speaking' and type(value.get('mouth')) is int and
                          value['mouth'] in (0, 1, 2) and type(value.get('positionMs')) is int and
                          0 <= value['positionMs'] <= 10_000):
                        self.publish({'event': 'playback_clock', 'mode': 'speaking', 'utteranceId': self.active[0],
                                      'mouth': value['mouth'], 'positionMs': value['positionMs']})

            tasks = []
            try:
                await socket.accept()
                if heartbeat and self.heart_mood != 'calm':
                    queue.put_nowait({'event': 'heart_mood', 'mood': self.heart_mood})
                tasks = [asyncio.create_task(relay()), asyncio.create_task(listen())]
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                with CancelScope(shield=True):
                    for task in tasks:
                        task.cancel()
                    self.subscribers.discard(queue)
                    if self.player is queue:
                        self.player = None
                        self.song_capable = False
                        self.audio_leases.revoke()
                        self._complete_bridge('discarded', release=False)
                        if self.interrupt_receipt and not self.interrupt_receipt[2].done():
                            self.interrupt_receipt[2].set_result(None)
                        self.cancel_output()
                    await asyncio.gather(*tasks, return_exceptions=True)
