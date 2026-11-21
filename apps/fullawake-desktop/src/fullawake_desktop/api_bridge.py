"""Expose fixed console operations to local WebView content."""
import base64
import binascii
from io import BytesIO
import json
from pathlib import Path
from threading import Thread

import httpx
from PIL import Image
from websockets.sync.client import connect
from websockets.exceptions import WebSocketException


class ConsoleApi:
    def __init__(self, supervisor, *, transport=None):
        self._supervisor = supervisor
        self._headers = {'Authorization': f'Bearer {supervisor.token}'}
        self._client = httpx.Client(base_url='http://127.0.0.1:8765/v1/desktop/', headers=self._headers,
                                    timeout=2.5, trust_env=False, transport=transport)
        self._state = None
        self._listener = None
        self._select_home_export = lambda: None

    def _request(self, method, route, **kwargs):
        try:
            response = self._client.request(method, route, **kwargs)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as error:
            return {'error': f'网关拒绝操作（HTTP {error.response.status_code}）。'}
        except (httpx.RequestError, ValueError):
            return {'error': '等待本地网关。'}

    def _listen(self):
        stop = self._supervisor.shutdown
        while not stop.is_set():
            try:
                with connect('ws://127.0.0.1:8765/ws/desktop', additional_headers=self._headers,
                             proxy=None, open_timeout=1, close_timeout=.25) as socket:
                    while not stop.is_set():
                        try:
                            self._state = json.loads(socket.recv(timeout=.5))
                        except TimeoutError:
                            continue
            except (OSError, WebSocketException, ValueError, TimeoutError):
                self._state = None
                fallback = self._request('GET', 'state', timeout=.6)
                self._state = fallback if not stop.is_set() else None
            stop.wait(.5)

    def _start(self):
        self._listener = Thread(target=self._listen, daemon=True)
        self._listener.start()

    def _close(self):
        if self._listener:
            self._listener.join(timeout=2)
        self._client.close()

    def state(self):
        current = self._state or {'error': '等待本地网关。'}
        supervisor = self._supervisor
        pet_running = supervisor.pet_running()
        return {**current, 'gateway_online': 'error' not in current, 'usb': supervisor.usb,
                'usb_error': supervisor.usb_error, 'gateway_error': supervisor.gateway_error,
                'pet_running': pet_running,
                'home': self._home_with_pet(current.get('home'), pet_running),
                'auto_launch_pet': bool(supervisor.config.get('auto_launch_pet', False)),
                'logs': current.get('logs') or list(supervisor.lines)}

    @staticmethod
    def _home_with_pet(home, pet_running):
        if not home or not pet_running or home.get('stale'):
            return home
        scene = home.get('sceneState', {})
        if scene.get('source') in ('heart', 'decoration'):
            return {**home, 'sceneState': {'place': 'door', 'pose': 'idle', 'source': 'desktop_pet',
                                         'label': '小满正在桌面陪你'}}
        return home

    def home(self):
        return self._home_with_pet(self._request('GET', 'home', timeout=2.0), self._supervisor.pet_running())

    def save_home_image(self, encoded):
        if type(encoded) is not str or len(encoded) > 8_000_000:
            return {'error': '小屋画面格式无效。'}
        try:
            image = base64.b64decode(encoded, validate=True)
            with Image.open(BytesIO(image), formats=('PNG',)) as parsed:
                width, height = parsed.size
                if not (960 <= width <= 1920 and 560 <= height <= 1120):
                    raise ValueError('invalid canvas dimensions')
                parsed.verify()
        except (OSError, ValueError, binascii.Error, Image.DecompressionBombError):
            return {'error': '小屋画面格式无效。'}
        try:
            selected = self._select_home_export()
            if not selected:
                return {'saved': False}
            path = Path(selected[0])
            if path.suffix.lower() != '.png':
                return {'error': '请选择 PNG 文件。'}
            path.write_bytes(image)
            return {'saved': True}
        except (OSError, RuntimeError):
            return {'error': '无法保存小屋画面。'}

    def sources(self):
        return self._request('GET', 'sources')

    def preview(self):
        return self._request('GET', 'preview')

    def target(self, value):
        return self._request('POST', 'target', json=value)

    def call(self, enabled):
        return self._request('POST', 'call', json={'enabled': enabled}, timeout=4.5)

    def watch(self, enabled):
        return self._request('POST', 'watch', json={'action': 'start' if enabled else 'stop', 'mode': 'desktop'}, timeout=4.5)

    def audio(self, value):
        return self._request('POST', 'audio/config', json=value)

    def reconnect(self):
        if self._state is None or self._supervisor.gateway_error:
            self._supervisor.restart()
        self._supervisor.refresh_usb()
        return self._request('POST', 'reconnect', timeout=4.5)

    def sync_session(self):
        return self._request('POST', 'sync', timeout=4.5)

    def toggle_pet(self):
        if self._supervisor.pet_running(force_refresh=True):
            return self._supervisor.stop_pet()
        return self._supervisor.start_pet()

    def set_auto_pet(self, enabled):
        return self._supervisor.set_auto_launch_pet(enabled)

    def restart_gateway(self):
        self._supervisor.restart()
        return {'error': self._supervisor.gateway_error} if self._supervisor.gateway_error else {}
