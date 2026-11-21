"""Own only the gateway and renderer started by this console."""

from collections import deque
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
from threading import Event, Lock, Thread

SUITE = Path(__file__).resolve().parents[4]
PC = SUITE / 'apps/fullawake-pc'
LOCAL = SUITE / 'local/fullawake'
HIDDEN = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
ENV_KEYS = ('FULLAWAKE_AUTH_TOKEN', 'FULLAWAKE_BREEZE_API_KEY', 'FULLAWAKE_WATCH_TOKEN',
            'FULLAWAKE_VOICE_PROFILE', 'FULLAWAKE_VOICE_PYTHON', 'FULLAWAKE_PTT_KEY',
            'FULLAWAKE_ASR_MODEL_DIR', 'FULLAWAKE_SENSEVOICE_MODEL_DIR', 'FULLAWAKE_ASR_BACKEND',
            'FULLAWAKE_VAD_DEVICE', 'FULLAWAKE_VAD_DEVICE_MODE')


def base_python(venv):
    settings = dict(line.split(' = ', 1) for line in (venv / 'pyvenv.cfg').read_text().splitlines() if ' = ' in line)
    home = Path(settings['home'])
    executable = home / 'python.exe'
    if not executable.is_file():
        raise FileNotFoundError('FullAwake PC 的 uv 基座 Python 不可用。')
    return executable


def usb_devices(listing):
    return [fields[0] for line in listing.splitlines() if len(fields := line.split()) >= 2
            and fields[1] == 'device' and ':' not in fields[0] and not fields[0].startswith('emulator-')]


class Supervisor:
    def __init__(self, config=None):
        file = LOCAL / 'desktop-config.json'
        self.config = config if config is not None else (json.loads(file.read_text(encoding='utf-8-sig')) if file.exists() else {})
        self.serial = os.environ.get('FULLAWAKE_ADB_SERIAL') or self.config.get('adb_serial')
        self.adb = self.config.get('adb_path') or shutil.which('adb.exe') or shutil.which('adb')
        self.token = os.environ.get('FULLAWAKE_DESKTOP_TOKEN') or secrets.token_urlsafe(32)
        self.shutdown = Event()
        self.lock = Lock()
        self.process = None
        self.renderer = None
        self.pet = None
        self._pet_alive_cache = False
        self._pet_checked_at = 0.0
        self.usb = False
        self.usb_error = ''
        self.gateway_error = ''
        self.lines = deque(maxlen=150)
        self.thread = None

    def env(self):
        env = os.environ.copy()
        for name in ENV_KEYS:
            if name not in env and isinstance(self.config.get(name), str):
                env[name] = self.config[name]
        env.setdefault('FULLAWAKE_WATCH_TOKEN', secrets.token_urlsafe(32))
        env.setdefault('FULLAWAKE_PTT_KEY', 'rctrl')
        env.setdefault('FULLAWAKE_VAD_DEVICE_MODE', 'speaker')
        env.setdefault('FULLAWAKE_ASR_MODEL_DIR', str(LOCAL / 'faster-whisper-base'))
        env.setdefault('FULLAWAKE_SENSEVOICE_MODEL_DIR', str(LOCAL / 'sensevoice-small'))
        env.setdefault('FULLAWAKE_VOICE_WORK_DIR', str(LOCAL / 'voice-work'))
        env.setdefault('FULLAWAKE_LOG_FILE', str(LOCAL / 'desktop-gateway.log'))
        voice_profile = SUITE / 'local/feiyu/rvc-onnx-phasefix/voice-profile.json'
        if voice_profile.is_file():
            env.setdefault('FULLAWAKE_VOICE_PROFILE', str(voice_profile))
        for relative in ('rvc/.venv-gpu/Scripts/python.exe', 'rvc/.venv310/Scripts/python.exe'):
            worker = SUITE.parent / relative
            if worker.is_file():
                env.setdefault('FULLAWAKE_VOICE_PYTHON', str(worker))
                break
        site = PC / '.venv/Lib/site-packages'
        paths = [PC / 'src', site, site / 'win32', site / 'win32/lib']
        env.update(VIRTUAL_ENV=str(PC / '.venv'), PYTHONPATH=os.pathsep.join(map(str, paths)), PYTHONUTF8='1',
                   FULLAWAKE_DESKTOP_TOKEN=self.token, FULLAWAKE_BIND_HOST='127.0.0.1', VOICE_VAD_ENABLED='true',
                   FULLAWAKE_VOICE_ENABLED='1')
        return env

    def _launch(self, module, env, *args):
        child = subprocess.Popen([str(base_python(PC / '.venv')), '-m', module, *args], cwd=SUITE, env=env,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, encoding='utf-8', errors='replace', creationflags=HIDDEN)
        def read():
            with child.stdout:
                for line in child.stdout:
                    for key in ('FULLAWAKE_AUTH_TOKEN', 'FULLAWAKE_BREEZE_API_KEY', 'FULLAWAKE_DESKTOP_TOKEN', 'FULLAWAKE_WATCH_TOKEN'):
                        if secret := env.get(key):
                            line = line.replace(secret, '[redacted]')
                    self.lines.append(line.rstrip()[:500])
        Thread(target=read, daemon=True).start()
        return child

    @staticmethod
    def _port_open(port=8765):
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=.2):
                return True
        except OSError:
            return False

    def _reclaim_orphan_gateway(self):
        """Terminate orphaned fullawake.gateway.mcp_server processes if they still hold port 8765."""
        if os.name != 'nt' or not self._port_open():
            return
        try:
            cmd = (
                "Get-CimInstance Win32_Process | Where-Object { "
                "$_.CommandLine -match 'fullawake\\.gateway\\.mcp_server' "
                "} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
            )
            subprocess.run(['powershell', '-NoProfile', '-Command', cmd],
                           capture_output=True, text=True, timeout=4, creationflags=HIDDEN)
        except (OSError, subprocess.SubprocessError):
            return
        for _ in range(10):
            if not self._port_open():
                return
            self.shutdown.wait(.2)

    def start_gateway(self):
        with self.lock:
            if self.shutdown.is_set() or (self.process and self.process.poll() is None):
                return
            env = self.env()
            auth = env.get('FULLAWAKE_AUTH_TOKEN', '')
            if len(auth) < 24 or auth == self.token or len(self.token) < 32:
                self.gateway_error = '请配置手机配对密钥，并使用独立的本地控制台密钥。'
                return
            if self._port_open():
                self._reclaim_orphan_gateway()
            if self._port_open():
                self.gateway_error = '8765 端口已由另一个进程占用。请先关闭旧网关，再点重启。'
                return
            try:
                LOCAL.mkdir(parents=True, exist_ok=True)
                self.process = self._launch('fullawake.gateway.mcp_server', env)
                self.gateway_error = ''
                if self.config.get('launch_renderer', True):
                    self.renderer = self._launch('fullawake.widget', env, '--watch')
            except (OSError, ValueError, KeyError) as error:
                self.gateway_error = f'启动组件失败（{type(error).__name__}）。'

    def _adb(self, *args):
        return subprocess.run([self.adb, *args], capture_output=True, text=True, timeout=2,
                              creationflags=HIDDEN, check=True).stdout

    def refresh_usb(self):
        if not self.adb:
            self.usb = False
            self.usb_error = '找不到 adb.exe。'
            return
        try:
            devices = usb_devices(self._adb('devices'))
            serial = self.serial if self.serial in devices else None
            if not self.serial and len(devices) == 1:
                serial = devices[0]
            if not serial:
                self.usb = False
                self.usb_error = '等待已授权的 USB 手机，连接多台时请配置设备序列号。'
                return
            mappings = self._adb('-s', serial, 'reverse', '--list').splitlines()
            if not any(line.split()[-2:] == ['tcp:28765', 'tcp:8765'] for line in mappings):
                self._adb('-s', serial, 'reverse', 'tcp:28765', 'tcp:8765')
            self.usb = True
            self.usb_error = ''
        except (OSError, subprocess.SubprocessError):
            self.usb = False
            self.usb_error = 'ADB 隧道建立失败。'

    def _pet_dir(self):
        configured = self.config.get('pet_dir')
        candidates = ([Path(configured)] if isinstance(configured, str) and configured.strip() else []) + [
            SUITE.parent / 'dsh-pet-indesktop',
        ]
        for candidate in candidates:
            if (candidate / 'pet').is_dir():
                return candidate
        return None

    def _external_pet_pids(self):
        if os.name != 'nt':
            return []
        try:
            cmd = (
                "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { "
                "$_.CommandLine -match 'pythonw?(\\.exe)?\"?\\s+.*-m\\s+pet(\\s|$)' "
                "} | Select-Object -ExpandProperty ProcessId"
            )
            out = subprocess.run(['powershell', '-NoProfile', '-Command', cmd],
                                 capture_output=True, text=True, timeout=3, creationflags=HIDDEN).stdout
            return [int(line.strip()) for line in out.splitlines() if line.strip().isdigit()]
        except (OSError, subprocess.SubprocessError, ValueError):
            return []

    def pet_running(self, *, force_refresh=False):
        if self.pet is not None and self.pet.poll() is None:
            self._pet_alive_cache = True
            return True
        import time
        now = time.monotonic()
        if force_refresh or now - self._pet_checked_at >= 3.0:
            self._pet_checked_at = now
            self._pet_alive_cache = bool(self._external_pet_pids())
        return self._pet_alive_cache

    def start_pet(self):
        with self.lock:
            if self.pet_running(force_refresh=True):
                return {'pet_running': True, 'accepted': True}
            pet_dir = self._pet_dir()
            if pet_dir is None:
                return {'pet_running': False, 'accepted': False, 'error': '未找到桌宠目录 dsh-pet-indesktop。'}
            try:
                venv = pet_dir / '.venv'
                py_exe = base_python(venv) if (venv / 'pyvenv.cfg').is_file() else base_python(PC / '.venv')
                pyw = py_exe.with_name('pythonw.exe')
                runner = pyw if pyw.is_file() else py_exe
                env = self.env()
                site = venv / 'Lib/site-packages'
                pet_paths = [pet_dir] + ([site] if site.is_dir() else [])
                env['PYTHONPATH'] = os.pathsep.join(map(str, pet_paths))
                env['VIRTUAL_ENV'] = str(venv)
                env.setdefault('FULLAWAKE_GATEWAY_URL', 'http://127.0.0.1:8765')
                self.pet = subprocess.Popen([str(runner), '-m', 'pet', '--no-chat'], cwd=pet_dir, env=env,
                                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                            stderr=subprocess.DEVNULL, creationflags=HIDDEN)
                self._pet_alive_cache = True
                return {'pet_running': True, 'accepted': True}
            except (OSError, ValueError, FileNotFoundError) as error:
                return {'pet_running': False, 'accepted': False, 'error': f'启动桌宠失败（{type(error).__name__}）。'}

    def stop_pet(self):
        with self.lock:
            self._stop(self.pet)
            self.pet = None
            for pid in self._external_pet_pids():
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid)],
                                   capture_output=True, timeout=3, creationflags=HIDDEN)
            self._pet_alive_cache = False
            self._pet_checked_at = 0.0
            return {'pet_running': False, 'accepted': True}

    def set_auto_launch_pet(self, enabled):
        flag = bool(enabled)
        self.config['auto_launch_pet'] = flag
        file = LOCAL / 'desktop-config.json'
        try:
            LOCAL.mkdir(parents=True, exist_ok=True)
            data = json.loads(file.read_text(encoding='utf-8-sig')) if file.exists() else {}
            data['auto_launch_pet'] = flag
            file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        except (OSError, ValueError):
            pass
        return {'auto_launch_pet': flag, 'accepted': True}

    def start(self):
        def run():
            self.start_gateway()
            if self.config.get('auto_launch_pet'):
                self.start_pet()
            while not self.shutdown.is_set():
                self.refresh_usb()
                if self.process and (code := self.process.poll()) is not None:
                    self.gateway_error = f'网关已退出（{code}），可手动重启。'
                self.shutdown.wait(3)
        self.thread = Thread(target=run, daemon=True)
        self.thread.start()

    @staticmethod
    def _stop(child):
        if child and child.poll() is None:
            child.terminate()
            try:
                child.wait(1.5)
            except subprocess.TimeoutExpired:
                child.kill()
                try:
                    child.wait(1.5)
                except subprocess.TimeoutExpired:
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/F', '/T', '/PID', str(child.pid)],
                                       capture_output=True, timeout=3, creationflags=HIDDEN)

    def restart(self):
        with self.lock:
            self._stop(self.renderer)
            self._stop(self.process)
            self.renderer = self.process = None
            self._reclaim_orphan_gateway()
        self.start_gateway()

    def close(self):
        self.shutdown.set()
        with self.lock:
            self._stop(self.renderer)
            self._stop(self.process)
        if self.thread:
            self.thread.join(timeout=3)
