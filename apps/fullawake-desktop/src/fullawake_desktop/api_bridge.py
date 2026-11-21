"""Expose fixed console operations to local WebView content."""
import json
from threading import Thread

import httpx
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
            stop.wait(.5)

    def _start(self):
        self._listener = Thread(target=self._listen, daemon=True)
        self._listener.start()

    def _close(self):
        if self._listener:
            self._listener.join(timeout=2)
        self._client.close()

    def state(self):
        current = self._state
        if current is None:
            current = self._request('GET', 'state', timeout=.6)
        supervisor = self._supervisor
        return {**current, 'gateway_online': 'error' not in current, 'usb': supervisor.usb,
                'usb_error': supervisor.usb_error, 'gateway_error': supervisor.gateway_error,
                'pet_running': supervisor.pet_running(),
                'auto_launch_pet': bool(supervisor.config.get('auto_launch_pet', False)),
                'logs': current.get('logs') or list(supervisor.lines)}

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
