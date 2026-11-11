"""Opt-in bounded RVC compute. No remote paths/commands or arbitrary file reads."""
import asyncio
import base64
import hashlib
import io
import json
import os
import re
import stat
from functools import cached_property
from pathlib import Path
import tempfile
import time
import wave

from fullawake.core.config import config
from fullawake.capabilities.voice_artifacts import VoiceArtifacts
from fullawake.capabilities.voice_sing import render_song

ASSETS = ('model.onnx', 'hubert.onnx', 'rmvpe.onnx', 'voice.mobile.index')
DEFAULTS = {'pitch': 0, 'brightness': 0, 'indexMethod': 'cosine1', 'indexRatio': .3,
            'protect': .33, 'ttsVoice': 'zh-CN-XiaoxiaoNeural', 'ttsRate': '+0%',
            'synthesisMode': 'chunked', 'noiseScale': 1., 'intonationScale': 1.}

MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_SONG_BYTES = 60 * 1024 * 1024
ASR_SAMPLE_RATE = 16000
AUDIO_UNCLEAR = {'ok': False, 'error': 'AUDIO_UNCLEAR', 'text': ''}


async def communicate(process, timeout):
    task = asyncio.create_task(process.communicate())
    try:
        return await asyncio.wait_for(asyncio.shield(task), timeout)
    except asyncio.TimeoutError as error:
        raise TimeoutError('VOICE_TIMEOUT') from error
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await task


def silk_as_wav(audio: bytes) -> io.BytesIO:
    import pilk

    with tempfile.TemporaryDirectory(prefix='fullawake-asr-') as folder:
        source = Path(folder) / 'input.silk'
        pcm = Path(folder) / 'decoded.pcm'
        source.write_bytes(audio)
        duration = pilk.decode(str(source), str(pcm), pcm_rate=ASR_SAMPLE_RATE)
        if duration <= 0:
            raise ValueError('Invalid Silk audio')
        samples = pcm.read_bytes()
    wav = io.BytesIO()
    with wave.open(wav, 'wb') as output:
        output.setparams((1, 2, ASR_SAMPLE_RATE, 0, 'NONE', 'not compressed'))
        output.writeframes(samples)
    wav.seek(0)
    return wav


def read_voice_audio(output):
    # Bound before reading; the reply is private generated audio, never a client path.
    if not 44 < output.stat().st_size <= MAX_AUDIO_BYTES:
        raise ValueError('VOICE_AUDIO_INVALID')
    audio = output.read_bytes()
    if not 44 < len(audio) <= MAX_AUDIO_BYTES or audio[:4] != b'RIFF' or audio[8:12] != b'WAVE':
        raise ValueError('VOICE_AUDIO_INVALID')
    return audio


def prepare_profile(request):
    # Profile/Python paths are local administrator configuration, never request data.
    if set(request) not in ({'text', 'voice'}, {'audioBase64', 'voice'}):
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
    if settings['synthesisMode'] not in ('continuous', 'chunked') or settings['indexMethod'] not in ('l2-8', 'cosine1'):
        raise ValueError('VOICE_SETTINGS_INVALID')
    if 'text' in request:
        text = request.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 200:
            raise ValueError('VOICE_TEXT_INVALID')
        audio_bytes = None
    else:
        text = None
        raw_b64 = request.get('audioBase64')
        if not isinstance(raw_b64, str) or not 44 < len(raw_b64) <= 12 * 1024 * 1024:
            raise ValueError('VOICE_AUDIO_INVALID')
        if not re.fullmatch(r'[A-Za-z0-9+/=]+', raw_b64):
            raise ValueError('VOICE_AUDIO_INVALID')
        try:
            audio_bytes = base64.b64decode(raw_b64, validate=True)
        except Exception:
            raise ValueError('VOICE_AUDIO_INVALID')
        if not 44 < len(audio_bytes) <= MAX_AUDIO_BYTES or audio_bytes[:4] != b'RIFF' or audio_bytes[8:12] != b'WAVE':
            raise ValueError('VOICE_AUDIO_INVALID')
    # Effective parameters follow the phone's chosen profile, without copying its
    # paths, ttsCommand, credentials or Python environment onto the PC.
    profile['modelsDir'] = str((profile_path.parent / profile['modelsDir']).resolve(strict=True))
    profile.pop('ttsCommand', None)
    profile.pop('pythonPath', None)
    profile.update(settings)
    return profile, text, audio_bytes


class VoiceCompute:
    def __init__(self):
        self.active_voice_workers = 0
        self.text_worker_active = False
        self._artifacts = None
        self.sing_provider = None
        self._sing_lock = asyncio.Lock()

    @property
    def artifacts(self):
        root = Path(config.voice_work_dir).absolute()
        if self._artifacts is None or self._artifacts.root != root:
            self._artifacts = VoiceArtifacts(root)
        return self._artifacts

    @cached_property
    def asr_model(self):
        from faster_whisper import WhisperModel

        model_dir = os.environ.get('FULLAWAKE_ASR_MODEL_DIR')
        if not model_dir or not Path(model_dir).is_dir():
            raise RuntimeError('FULLAWAKE_ASR_MODEL_DIR must point to a local model')
        return WhisperModel(model_dir, device='cuda', compute_type='float16', local_files_only=True)

    def transcribe(self, audio: bytes):
        from av.error import FFmpegError
        from faster_whisper.audio import decode_audio

        try:
            is_silk = audio.startswith((b'#!SILK_V3', b'\x02#!SILK_V3'))
            source = silk_as_wav(audio) if is_silk else io.BytesIO(audio)
            samples = decode_audio(source, sampling_rate=ASR_SAMPLE_RATE)
        except (FFmpegError, ValueError, IndexError):
            return AUDIO_UNCLEAR

        asr_prompt = os.environ.get('FULLAWAKE_ASR_PROMPT', '小满，大肥鱼，清羽，阿醒，满宝，妹妹，姐姐')
        segments, info = self.asr_model.transcribe(
            samples, beam_size=1, vad_filter=True, initial_prompt=asr_prompt
        )
        transcript = ''.join(segment.text for segment in segments).strip()
        if not transcript:
            return AUDIO_UNCLEAR
        return {'ok': True, 'text': transcript, 'duration': round(len(samples) / ASR_SAMPLE_RATE, 2),
                'language': info.language}

    async def synthesize(self, request, disconnected=None):
        if not config.voice_enabled:
            raise ValueError('VOICE_DISABLED')
        is_text = 'text' in request
        # Keep full-text and CPU inference exclusive. Allow two short CUDA dry
        # conversions without permitting an unbounded queue of model workers.
        parallel_dry = not is_text and not self.text_worker_active and config.voice_provider == 'CUDAExecutionProvider'
        if self.active_voice_workers >= (2 if parallel_dry else 1):
            raise ValueError('VOICE_BUSY')
        profile, text, audio_bytes = prepare_profile(request)
        python_candidate = Path(config.voice_python)
        uv_python = Path(r"C:\Users\xuaner\AppData\Roaming\uv\python\cpython-3.10-windows-x86_64-none\python.exe")
        if uv_python.is_file():
            python = uv_python.resolve()
        else:
            python = python_candidate.resolve(strict=True)

        worker = Path(__file__).resolve().parents[5] / 'packages' / 'rvc' / 'scripts' / 'voice_profile_speak.py'
        if not python.is_file() or not worker.is_file():
            raise ValueError('VOICE_RUNTIME_UNAVAILABLE')
        cache = self.artifacts
        cache.prepare(cache.root)
        started = time.monotonic()
        self.active_voice_workers += 1
        if is_text:
            self.text_worker_active = True
        try:
            with cache.job(Path(tempfile.mkdtemp(prefix='rvc-', dir=cache.root))) as work:
                profile_file, output = work / 'profile.json', work / 'output.wav'
                profile_file.write_text(json.dumps(profile), encoding='utf8')
                cmd = [str(python), str(worker), '--profile', str(profile_file),
                       '--output', str(output), '--seed', '42']
                if text is not None:
                    cmd.extend(['--text', text])
                else:
                    input_dry = work / 'input_dry.wav'
                    input_dry.write_bytes(audio_bytes)
                    cmd.extend(['--input', str(input_dry)])
                if getattr(config, 'voice_provider', None):
                    cmd.extend(['--provider', config.voice_provider])
                worker_env = dict(os.environ)
                torch_lib = r'D:\CodePackage\DSHA\projects\rvc\.venv310\Lib\site-packages\torch\lib'
                worker_env['PATH'] = torch_lib + os.pathsep + worker_env.get('PATH', '')
                worker_env['PYTHONPATH'] = r'D:\CodePackage\DSHA\projects\rvc\.venv-gpu\Lib\site-packages;D:\CodePackage\DSHA\projects\rvc\.venv310\Lib\site-packages'
                process = await asyncio.create_subprocess_exec(*cmd,
                    env=worker_env,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                task = asyncio.create_task(process.communicate())
                try:
                    while not task.done():
                        await asyncio.wait({task}, timeout=.25)
                        if time.monotonic() - started > 30 or (disconnected and await disconnected()):
                            raise TimeoutError('VOICE_TIMEOUT_OR_DISCONNECTED')
                    stdout, stderr = await task
                    if process.returncode:
                        import logging
                        logging.getLogger('fullawake.gateway').error(
                            "Worker failed with returncode %d.\nSTDOUT:\n%s\nSTDERR:\n%s",
                            process.returncode,
                            stdout.decode('utf8', 'replace'),
                            stderr.decode('utf8', 'replace')
                        )
                        raise ValueError('VOICE_SYNTHESIS_FAILED')
                finally:
                    if process.returncode is None:
                        try:
                            process.kill()
                        except ProcessLookupError:
                            pass
                        await process.wait()
                    if not task.done():
                        await task
                result = json.loads(output.with_suffix('.result.json').read_text(encoding='utf8'))
                audio = read_voice_audio(output)
                return {'ok': True, 'voiceId': profile['id'], 'assets': request['voice']['assets'],
                        'settings': request['voice']['settings'], 'audioBase64': base64.b64encode(audio).decode('ascii'),
                        'sha256': hashlib.sha256(audio).hexdigest(), 'sampleRate': result['sampleRate'],
                        'durationMs': round((time.monotonic() - started) * 1000),
                        'provider': result['executionProvider'], 'mode': 'pc_onnx_offload',
                        'acoustic': {'pitch': result['pitch'], 'brightness': result['brightness'], 'rate': result['ttsRate']}}
        finally:
            self.active_voice_workers -= 1
            if is_text:
                self.text_worker_active = False

    def get_separated_file(self, task: str, stem: str):
        clean_task = re.sub(r'[^a-zA-Z0-9_-]', '_', task)[:60]
        root = self.artifacts.task_dir('separated', clean_task)
        if stem in ("vocals", "vocal"):
            candidate = root / "vocals.wav"
        elif stem in ("accompaniment", "no_vocals", "inst", "bgm"):
            candidate = root / "no_vocals.wav"
            if not self.artifacts.safe(candidate, stat.S_ISREG):
                candidate = root / "accompaniment.wav"
        else:
            return None
        return candidate if self.artifacts.safe(candidate, stat.S_ISREG) else None

    async def separate(self, task: str, audio_bytes: bytes, audio_format: str = "m4a") -> dict:
        if not config.voice_enabled:
            raise ValueError('VOICE_DISABLED')
        if not audio_bytes or len(audio_bytes) < 100:
            raise ValueError('VOICE_AUDIO_EMPTY')
        if len(audio_bytes) > 60 * 1024 * 1024:
            raise ValueError('VOICE_AUDIO_TOO_LARGE')

        clean_task = re.sub(r'[^a-zA-Z0-9_-]', '_', task)[:60]
        if not clean_task:
            raise ValueError('VOICE_TASK_INVALID')

        cache = self.artifacts
        with cache.job(cache.task_dir('separated', clean_task)) as destination:
            work = Path(tempfile.mkdtemp(prefix='work-', dir=destination))
            return await self._separate(clean_task, audio_bytes, audio_format, work, destination)

    async def _separate(self, clean_task, audio_bytes, audio_format, task_dir, destination):
        clean_fmt = audio_format.lower() if audio_format.lower() in ('m4a', 'mp3', 'wav', 'flac') else 'm4a'
        in_file = task_dir / f"input.{clean_fmt}"
        in_file.write_bytes(audio_bytes)

        python = Path(r"C:\Users\xuaner\AppData\Roaming\uv\python\cpython-3.10-windows-x86_64-none\python.exe")
        if not python.is_file():
            python = Path(config.voice_python)

        out_demucs_dir = task_dir / "out"
        out_demucs_dir.mkdir(parents=True, exist_ok=True)

        cmd = [
            str(python), "-m", "demucs.separate",
            "-n", "htdemucs",
            "--two-stems", "vocals",
            "-o", str(out_demucs_dir),
            str(in_file),
        ]
        env = dict(os.environ)
        env["PYTHONPATH"] = r"D:\CodePackage\DSHA\projects\rvc\.venv310\Lib\site-packages"

        started = time.monotonic()
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await communicate(process, timeout=300)
        elapsed = time.monotonic() - started

        if process.returncode != 0:
            import logging
            logging.getLogger('fullawake.gateway').error(
                "Demucs separation failed with returncode %d.\nSTDOUT:\n%s\nSTDERR:\n%s",
                process.returncode,
                stdout.decode('utf8', 'replace'),
                stderr.decode('utf8', 'replace')
            )
            raise ValueError('VOICE_SEPARATION_FAILED')

        found_voc = list(out_demucs_dir.rglob("vocals.wav"))
        found_bgm = list(out_demucs_dir.rglob("no_vocals.wav"))
        if not found_voc or not found_bgm:
            raise ValueError('VOICE_SEPARATION_OUTPUT_MISSING')

        found_voc[0].replace(destination / 'vocals.wav')
        found_bgm[0].replace(destination / 'no_vocals.wav')

        return {
            "ok": True,
            "task": clean_task,
            "elapsedSeconds": round(elapsed, 2),
            "vocalsUrl": f"/v1/voice/download/{clean_task}/vocals",
            "accompanimentUrl": f"/v1/voice/download/{clean_task}/accompaniment",
        }

    def get_singing_song_file(self, task: str, audio_format: str | None = None):
        clean_task = re.sub(r'[^a-zA-Z0-9_-]', '_', task)[:60]
        root = self.artifacts.task_dir('singing', clean_task)
        candidates = [
            root / f"song_{clean_task}.mp3",
            root / "song.mp3",
            root / f"song_{clean_task}.wav",
        ]
        for c in candidates:
            if audio_format is not None and c.suffix != f'.{audio_format}':
                continue
            if self.artifacts.safe(c, stat.S_ISREG):
                return c
        return None

    async def process_singing_pipeline(self, task: str, audio_bytes: bytes, audio_format: str = "m4a",
                                       pitch: int = 0, *, progress=None, queued=False) -> dict:
        if not config.voice_enabled:
            raise ValueError('VOICE_DISABLED')
        if not audio_bytes or len(audio_bytes) < 100:
            raise ValueError('VOICE_AUDIO_EMPTY')
        if len(audio_bytes) > MAX_SONG_BYTES:
            raise ValueError('VOICE_AUDIO_TOO_LARGE')

        import logging
        logger = logging.getLogger('fullawake.gateway')

        clean_task = re.sub(r'[^a-zA-Z0-9_-]', '_', task)[:60]
        if not clean_task:
            raise ValueError('VOICE_TASK_INVALID')

        pitch = int(pitch)
        if pitch == -2:
            pitch = -4
        if pitch not in (0, -4):
            pitch = 0

        if not queued and self._sing_lock.locked():
            raise ValueError('VOICE_BUSY')
        async with self._sing_lock:
            if self.sing_provider is not None:
                await self.sing_provider.prepare()
            cache = self.artifacts
            with cache.job(cache.task_dir('singing', clean_task)) as destination:
                work = Path(tempfile.mkdtemp(prefix='work-', dir=destination))
                callbacks = {'progress': progress} if progress is not None else {}
                return await self._sing(clean_task, audio_bytes, audio_format, pitch, work, destination, logger, **callbacks)

    async def _sing(self, clean_task, audio_bytes, audio_format, pitch, root, destination, logger, *, progress=None):
        return await render_song(
            self.artifacts, communicate, clean_task, audio_bytes, audio_format, pitch,
            root, destination, logger, progress=progress, resident=self.sing_provider,
        )
