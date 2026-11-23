"""Local console API. USB bridge credentials cannot operate the console."""
import asyncio
from collections import deque
import hmac
from io import BytesIO
import logging
import os
from typing import Literal

import mss
from fastapi import Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from fullawake.capabilities.desktop_vision.screen import capture_screenshot, encode_snapshot, grab_area
from fullawake.capabilities.desktop_vision.uia_backend import list_top_level_windows
from fullawake.capabilities.desktop_vision.watch import native_loopback
from fullawake.capabilities.home_state import HomeSnapshot, HomeState
from fullawake.capabilities.voice_vad import PTT_VIRTUAL_KEYS
from fullawake.core.config import config
from fullawake.core.session import is_desktop_locked


class Input(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid')


class Target(Input):
    kind: Literal['auto', 'monitor', 'window']
    monitor_id: int | None = Field(default=None, gt=0)
    hwnd: int | None = Field(default=None, gt=0)


class Call(Input):
    enabled: bool


class Watch(Input):
    action: Literal['start', 'stop']
    mode: Literal['desktop'] = 'desktop'
    monitor_id: int | None = Field(default=None, gt=0)
    hwnd: int | None = Field(default=None, gt=0)


class Audio(Input):
    ptt_key: str | None = Field(default=None, max_length=16)
    vad_mode: Literal['ptt', 'auto'] | None = None
    muted: bool | None = None


def allowed(scope):
    token = os.getenv('FULLAWAKE_DESKTOP_TOKEN', '')
    return (len(token) >= 32 and token != config.auth_token and scope.client is not None
            and scope.client.host == '127.0.0.1' and 'origin' not in scope.headers
            and hmac.compare_digest(scope.headers.get('authorization', '').encode(), f'Bearer {token}'.encode()))


async def authenticate(request: Request):
    if not allowed(request):
        raise HTTPException(403, 'DESKTOP_CONSOLE_FORBIDDEN')


def enumerate_sources(thumbnails=False):
    if is_desktop_locked():
        return [], []
    with mss.MSS() as capture:
        monitors = []
        for number, display in enumerate(capture.monitors[1:], 1):
            primary = bool(display.get('is_primary', display['left'] == display['top'] == 0))
            monitor = {**{key: display[key] for key in ('left', 'top', 'width', 'height')},
                       'id': number, 'name': display.get('name') or f'显示器 {number}', 'is_primary': primary}
            monitor['thumbnail_data_url'] = None
            if thumbnails and not is_desktop_locked():
                try:
                    image, _, _ = grab_area(capture, display)
                    image.thumbnail((160, 90))
                    canvas = Image.new('RGB', (160, 90))
                    canvas.paste(image, ((160 - image.width) // 2, (90 - image.height) // 2))
                    monitor['thumbnail_data_url'] = encode_snapshot(canvas)['data_url']
                except Exception:
                    pass
            monitors.append(monitor)
    windows = []
    for window in list_top_level_windows():
        if window['is_minimized']:
            continue
        bounds = window['bounds']
        def overlap(monitor):
            return (max(0, min(bounds['right'], monitor['left'] + monitor['width']) - max(bounds['left'], monitor['left']))
                    * max(0, min(bounds['bottom'], monitor['top'] + monitor['height']) - max(bounds['top'], monitor['top'])))
        screen = max(monitors, key=overlap, default=None)
        windows.append({'hwnd': window['hwnd'], 'title': window['title'], 'process': window['process_name'],
                        'bounds': bounds, 'monitor_id': screen['id'] if screen and overlap(screen) else None})
    return ([], []) if is_desktop_locked() else (monitors, windows)


class ConsoleLog(logging.Handler):
    def __init__(self):
        super().__init__()
        self.lines = deque(maxlen=100)

    def emit(self, record):
        message = self.format(record)
        for secret in (config.auth_token, config.breeze_api_key, os.getenv('FULLAWAKE_DESKTOP_TOKEN'), os.getenv('FULLAWAKE_WATCH_TOKEN')):
            if secret:
                message = message.replace(secret, '[redacted]')
        self.lines.append(message[:500])

    def snapshot(self):
        with self.lock:
            return list(self.lines)


class DesktopConsole:
    def __init__(self, gateway):
        self.gateway = gateway
        self.watch = gateway.watch
        self.bridge = gateway.interrupts
        self.target = {'kind': 'auto', 'label': '跟随前台窗口所在屏'}
        self.lock = asyncio.Lock()
        self.watch_peer = None
        self.ptt_key = config.ptt_key if config.ptt_key in PTT_VIRTUAL_KEYS else 'rctrl'
        self.vad_mode = 'ptt' if config.ptt_key in PTT_VIRTUAL_KEYS else 'auto'
        self.log = ConsoleLog()
        self.home = HomeState()
        self.watch.on_pet_event = self._on_pet_event
        gateway.desktop.capture_target = self.capture_target
        self.watch.capture_target = self.capture_target

    def capture_target(self):
        kind = self.target['kind']
        if kind == 'auto':
            return {}
        key = 'hwnd' if kind == 'window' else 'monitor_id'
        return {key: self.target[key], 'console_target': True}

    def _on_pet_event(self, event):
        kind, utterance = event.get('event'), event.get('utteranceId')
        if kind == 'action':
            self.home.set_speech(event.get('text'), intent=event.get('intent', 'talk'),
                                 duration_ms=event.get('audioDurationMs') or event.get('durationMs'),
                                 utterance_id=utterance)
        elif kind == 'playback_clock' and event.get('mode') == 'idle':
            self.home.clear_speech(utterance)
        elif kind in ('audio_cancel', 'interrupt'):
            self.home.clear_speech(utterance, immediate=True)

    async def select(self, target):
        if target.kind == 'auto' and target.monitor_id is None and target.hwnd is None:
            self.target = {'kind': 'auto', 'label': '跟随前台窗口所在屏'}
        elif target.kind in ('monitor', 'window'):
            monitors, windows = await asyncio.to_thread(enumerate_sources)
            if target.kind == 'monitor' and target.hwnd is None:
                match = next((item for item in monitors if item['id'] == target.monitor_id), None)
                if match:
                    self.target = {'kind': 'monitor', 'monitor_id': match['id'], 'label': match['name']}
                else:
                    raise HTTPException(422, 'DESKTOP_SOURCE_UNAVAILABLE')
            elif target.kind == 'window' and target.monitor_id is None:
                match = next((item for item in windows if item['hwnd'] == target.hwnd), None)
                if match:
                    self.target = {'kind': 'window', 'hwnd': match['hwnd'], 'label': match['title'][:240]}
                else:
                    raise HTTPException(422, 'DESKTOP_SOURCE_UNAVAILABLE')
            else:
                raise HTTPException(422, 'DESKTOP_INVALID_TARGET')
        else:
            raise HTTPException(422, 'DESKTOP_INVALID_TARGET')
        if self.watch.clock and self.watch.clock.client == 'desktop':
            self.watch.detach_clock()
        return self.target

    def home_view(self, *, include_album=False):
        peer = self.bridge.peer
        game = self.bridge.game_watch.session
        task = self.watch.desktop_task
        return self.home.view({
            'call_active': bool(peer and peer.call_active),
            'watch_active': task is not None and not task.done(),
            'target_label': self.target['label'],
            'game_watch_active': peer is not None and game is not None and game.owner is peer,
            'pet_running': self.watch.player is not None,
        }, include_album=include_album)

    def state(self):
        peer, vad = self.bridge.peer, self.bridge.vad
        turns = []
        for trace in self.bridge.recent_turns:
            turn = {key: trace.get(key) for key in ('turnId', 'asr', 'reply')}
            for name, start, end in [('asr_ms', 'released', 'asr_done'), ('phone_llm_ms', 'asr_done', 'command'),
                                     ('render_ms', 'command', 'played'), ('total_ms', 'released', 'played')]:
                if start in trace and end in trace:
                    turn[name] = round((trace[end] - trace[start]) * 1000)
            turns.append(turn)
        return {'bridge_connected': bool(peer and peer.sent_seq), 'desktop_control': bool(peer and peer.desktop_control),
                'call_active': bool(peer and peer.call_active),
                'watch_active': self.watch.desktop_task is not None and not self.watch.desktop_task.done(),
                'watch_session_id': self.watch.session, 'target_label': self.target['label'],
                'active_target': self.target, 'ptt_key': self.ptt_key, 'vad_mode': self.vad_mode,
                'muted': self.bridge.mic_muted, 'mic_rms': getattr(vad, 'rms', 0.0),
                'ptt_active': getattr(vad, 'ptt_active', False), 'renderer_online': self.watch.player is not None,
                'asr_backend': getattr(self.gateway.voice, 'last_asr_backend', None), 'recent_turns': turns,
                'home': self.home_view()}

    async def disconnect(self, peer):
        if self.bridge.peer is None or self.bridge.peer is peer:
            self.home.invalidate()
        if self.watch_peer is peer:
            self.watch_peer = None
            await self.watch.stop_desktop()

    def mount(self, app):
        auth = [Depends(authenticate)]

        @app.post('/v1/home/snapshot', status_code=204)
        async def publish_home(request: Request):
            token = config.auth_token.strip()
            if not token or not native_loopback(request) or not hmac.compare_digest(
                request.headers.get('authorization', '').encode(), f'Bearer {token}'.encode()
            ):
                raise HTTPException(403, 'HOME_PUBLISH_FORBIDDEN')
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > 12_288:
                    raise HTTPException(413, 'HOME_SNAPSHOT_TOO_LARGE')
                body.extend(chunk)
            try:
                snapshot = HomeSnapshot.model_validate_json(body)
            except ValidationError:
                raise HTTPException(422, 'HOME_SNAPSHOT_INVALID') from None
            if not self.home.accept(snapshot):
                raise HTTPException(409, 'HOME_SNAPSHOT_STALE')

        @app.get('/v1/desktop/home', dependencies=auth)
        async def home():
            return self.home_view(include_album=True)

        @app.get('/v1/desktop/state', dependencies=auth)
        async def state():
            return self.state()

        @app.get('/v1/desktop/sources', dependencies=auth)
        async def sources():
            monitors, windows = await asyncio.to_thread(enumerate_sources, True)
            return {'monitors': monitors, 'windows': windows, 'active_target': self.target}

        @app.post('/v1/desktop/target', dependencies=auth)
        async def target(body: Target):
            async with self.lock:
                return await self.select(body)

        @app.get('/v1/desktop/preview', dependencies=auth)
        async def preview():
            target = self.target
            result = await asyncio.to_thread(capture_screenshot, region='full', **self.capture_target())
            if self.target is not target or is_desktop_locked():
                return {'error': '当前画面不可预览。'}
            result.pop('base64_data', None)
            return result

        @app.post('/v1/desktop/call', dependencies=auth)
        async def call(body: Call):
            async with self.lock:
                reply = await self.bridge.request_desktop('call', enabled=body.enabled, source='pc_desktop_app')
                return {'accepted': bool(reply and reply.accepted), 'reason': (reply.reason if reply else ''), **self.state()}

        @app.post('/v1/desktop/watch', dependencies=auth)
        async def watch(body: Watch):
            async with self.lock:
                if body.action == 'start':
                    peer = self.bridge.peer
                    if not peer or not peer.desktop_control:
                        return {'accepted': False, **self.state()}
                    if body.monitor_id is not None or body.hwnd is not None:
                        await self.select(Target(kind='window' if body.hwnd else 'monitor',
                                                 hwnd=body.hwnd, monitor_id=body.monitor_id))
                    await self.watch.control({'action': 'start', 'mode': 'desktop'}, force_desktop=True)
                    self.watch_peer = peer
                else:
                    self.watch_peer = None
                    await self.watch.stop_desktop()
                reply = await self.bridge.request_desktop('watch', action=body.action, mode='desktop',
                                                          targetLabel=self.target['label'])
                if body.action == 'start' and not (reply and reply.accepted):
                    self.watch_peer = None
                    await self.watch.stop_desktop()
                return {'accepted': bool(reply and reply.accepted), 'reason': (reply.reason if reply else ''), **self.state()}

        @app.post('/v1/desktop/audio/config', dependencies=auth)
        async def audio(body: Audio):
            if body.ptt_key is not None:
                key = body.ptt_key.lower()
                if key not in PTT_VIRTUAL_KEYS:
                    raise HTTPException(422, 'DESKTOP_INVALID_PTT_KEY')
                self.ptt_key = key
            self.vad_mode = body.vad_mode or self.vad_mode
            config.ptt_key = self.ptt_key if self.vad_mode == 'ptt' else ''
            if body.muted is not None:
                self.bridge.mic_muted = body.muted
            if self.bridge.peer:
                self.bridge.peer.call_generation += 1
            if self.bridge.vad:
                self.bridge.vad.configure(config.ptt_key, self.bridge.mic_muted)
            return self.state()

        @app.post('/v1/desktop/reconnect', dependencies=auth)
        async def reconnect():
            peer = self.bridge.peer
            if peer and peer.close_socket:
                await peer.close_socket(code=1001)
            return {'reconnecting': True}

        @app.post('/v1/desktop/sync', dependencies=auth)
        async def sync_session():
            reply = await self.bridge.request_desktop('sync', source='pc_desktop_app')
            return {'accepted': bool(reply and reply.accepted), 'synced': bool(reply and reply.accepted), 'reason': (reply.reason if reply else ''), **self.state()}

        @app.websocket('/ws/desktop')
        async def events(socket: WebSocket):
            if not allowed(socket):
                await socket.close(code=1008)
                return
            await socket.accept()
            try:
                previous = None
                while True:
                    current = {**self.state(), 'logs': self.log.snapshot()}
                    if current != previous:
                        await socket.send_json(current)
                        previous = current
                    try:
                        if (await asyncio.wait_for(socket.receive(), .25))['type'] == 'websocket.disconnect':
                            return
                    except asyncio.TimeoutError:
                        pass
            except (WebSocketDisconnect, OSError):
                return
