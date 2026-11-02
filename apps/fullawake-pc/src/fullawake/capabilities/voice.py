"""Opt-in bounded RVC compute. No remote paths/commands or arbitrary file reads."""
import asyncio
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import time

from fullawake.core.config import config

ASSETS = ('model.onnx', 'hubert.onnx', 'rmvpe.onnx', 'voice.mobile.index')
DEFAULTS = {'pitch': 0, 'brightness': 0, 'indexMethod': 'cosine1', 'indexRatio': .3,
            'protect': .33, 'ttsVoice': 'zh-CN-XiaoxiaoNeural', 'ttsRate': '+0%',
            'synthesisMode': 'chunked', 'noiseScale': 1., 'intonationScale': 1.}


def prepare_profile(request):
    # Profile/Python paths are local administrator configuration, never request data.
    if set(request) != {'text', 'voice'}:
        raise ValueError('VOICE_REQUEST_INVALID')
    profile_path = Path(config.voice_profile).resolve(strict=True)
    profile = json.loads(profile_path.read_text(encoding='utf-8-sig'))
    voice = request.get('voice')
    if not isinstance(voice, dict):
        raise ValueError('VOICE_REQUEST_INVALID')
    if profile.get('engine') != 'rvc-onnx' or voice.get('id') != profile.get('id'):
        raise ValueError('VOICE_PROFILE_MISMATCH')
    actual = {name: profile['assets'][name]['sha256'] for name in ASSETS}
    if voice.get('assets') != actual:
        raise ValueError('VOICE_ASSET_MISMATCH')
    settings = voice.get('settings', {})
    if not isinstance(settings, dict) or set(settings) != set(DEFAULTS):
        raise ValueError('VOICE_SETTINGS_INVALID')
    if isinstance(settings['pitch'], bool) or settings['pitch'] not in (0, -4) or settings['ttsVoice'] not in ('zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural'):
        raise ValueError('VOICE_SETTINGS_INVALID')
    import re
    rate = settings['ttsRate']
    if not isinstance(rate, str) or not re.fullmatch(r'[+-]\d+%', rate) or not -20 <= int(rate[:-1]) <= 20:
        raise ValueError('VOICE_RATE_INVALID')
    limits = {'brightness': (0, 3.5), 'indexRatio': (0, 1), 'protect': (0, .5), 'noiseScale': (0, 1), 'intonationScale': (.8, 1.6)}
    for key, (low, high) in limits.items():
        value = settings[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
            raise ValueError('VOICE_SETTINGS_INVALID')
    if settings['synthesisMode'] != 'continuous' or settings['indexMethod'] != 'l2-8':
        raise ValueError('VOICE_SETTINGS_INVALID')
    text = request.get('text')
    if not isinstance(text, str) or not text.strip() or len(text) > 200:
        raise ValueError('VOICE_TEXT_INVALID')
    # Effective parameters follow the phone's chosen profile, without copying its
    # paths, ttsCommand, credentials or Python environment onto the PC.
    profile['modelsDir'] = str((profile_path.parent / profile['modelsDir']).resolve(strict=True))
    profile.pop('ttsCommand', None)
    profile.pop('pythonPath', None)
    profile.update(settings)
    return profile, text


class VoiceCompute:
    def __init__(self):
        self.busy = False

    async def synthesize(self, request, disconnected=None):
        if not config.voice_enabled:
            raise ValueError('VOICE_DISABLED')
        if self.busy:
            raise ValueError('VOICE_BUSY')
        profile, text = prepare_profile(request)
        python = Path(config.voice_python).resolve(strict=True)
        worker = Path(__file__).resolve().parents[5] / 'packages' / 'rvc' / 'scripts' / 'voice_profile_speak.py'
        if not python.is_file() or not worker.is_file():
            raise ValueError('VOICE_RUNTIME_UNAVAILABLE')
        root = Path(config.voice_work_dir).resolve()
        root.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        self.busy = True
        try:
            with tempfile.TemporaryDirectory(prefix='rvc-', dir=root) as folder:
                work = Path(folder).resolve()
                if work.parent != root or not work.name.startswith('rvc-'):
                    raise ValueError('VOICE_WORK_PATH_INVALID')
                profile_file, output = work / 'profile.json', work / 'output.wav'
                profile_file.write_text(json.dumps(profile), encoding='utf8')
                cmd = [str(python), str(worker), '--profile', str(profile_file),
                       '--text', text, '--output', str(output), '--seed', '42']
                if getattr(config, 'voice_provider', None):
                    cmd.extend(['--provider', config.voice_provider])
                process = await asyncio.create_subprocess_exec(*cmd,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                task = asyncio.create_task(process.communicate())
                try:
                    while not task.done():
                        await asyncio.wait({task}, timeout=.25)
                        if time.monotonic() - started > 110 or (disconnected and await disconnected()):
                            raise TimeoutError('VOICE_TIMEOUT_OR_DISCONNECTED')
                    stdout, stderr = await task
                    if process.returncode:
                        # Return classified error, never subprocess logs/profile paths.
                        raise ValueError('VOICE_SYNTHESIS_FAILED')
                finally:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
                    if not task.done():
                        await task
                result = json.loads(output.with_suffix('.result.json').read_text(encoding='utf8'))
                audio = output.read_bytes()
                if not 44 < len(audio) <= 1024 * 1024 or audio[:4] != b'RIFF' or audio[8:12] != b'WAVE':
                    raise ValueError('VOICE_AUDIO_INVALID')
                return {'ok': True, 'voiceId': profile['id'], 'assets': request['voice']['assets'],
                        'settings': request['voice']['settings'], 'audioBase64': base64.b64encode(audio).decode('ascii'),
                        'sha256': hashlib.sha256(audio).hexdigest(), 'sampleRate': result['sampleRate'],
                        'durationMs': round((time.monotonic() - started) * 1000),
                        'provider': result['executionProvider'], 'mode': 'pc_onnx_offload',
                        'acoustic': {'pitch': result['pitch'], 'brightness': result['brightness'], 'rate': result['ttsRate']}}
        finally:
            self.busy = False
