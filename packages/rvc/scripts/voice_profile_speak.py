"""Opt-in voice profile worker using the exact bundled phone ONNX CPU runtime."""
import argparse
import asyncio
import hashlib
import importlib.util
import json
import subprocess
import sys
import time
import platform
import re
from pathlib import Path


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--input', type=Path, help='Existing dry voice: no TTS/network required')
    parser.add_argument('--text')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--rate', help='Edge TTS rate, e.g. +8%%; text input only')
    parser.add_argument('--intonation-scale', type=float, help='Experimental F0 contour range, 0.8..1.6; default 1')
    parser.add_argument('--seed', type=int, help='Seed latent and ORT noise for controlled auditions')
    args = parser.parse_args()
    started = time.perf_counter()
    profile_path = args.profile.resolve()
    profile = json.loads(profile_path.read_text(encoding='utf-8-sig'))
    if profile.get('schema') != 'lucidheart-voice-profile-v1' or profile.get('engine') != 'rvc-onnx':
        raise ValueError('Unsupported voice profile; CosyVoice is not an RVC checkpoint')
    models = (profile_path.parent / profile['modelsDir']).resolve()
    for name, asset in profile['assets'].items():
        file = (models / name).resolve()
        if not file.is_relative_to(models) or digest(file) != asset['sha256']:
            raise ValueError(f'Asset path/hash mismatch: {name}')
    if profile.get('pitch', 0) not in (0, -4):
        raise ValueError('Profile pitch must obey current 0/-4 policy')
    rate = args.rate if args.rate is not None else profile.get('ttsRate', '+0%')
    if not isinstance(rate, str) or not re.fullmatch(r'[+-]\d+%', rate) or not -20 <= int(rate[:-1]) <= 20:
        raise ValueError('TTS rate must be a signed percentage within -20%..+20%')
    intonation_scale = args.intonation_scale if args.intonation_scale is not None else profile.get('intonationScale', 1.0)
    if not isinstance(intonation_scale, (int, float)) or not 0.8 <= intonation_scale <= 1.6:
        raise ValueError('Intonation scale must be within 0.8..1.6')
    if args.input and args.rate is not None:
        raise ValueError('--rate cannot change an existing dry recording; generate new TTS with --text')
    output = args.output.resolve()
    if output.is_relative_to(models) or output.exists():
        raise ValueError('Output must be a new path outside the model directory')
    output.parent.mkdir(parents=True, exist_ok=True)
    dry = args.input.resolve() if args.input else output.with_suffix('.dry.mp3')
    if not args.input:
        if not args.text or not args.text.strip():
            raise ValueError('--input or --text is required')
        if profile.get('ttsCommand'):
            cmd = [*profile['ttsCommand'], args.text, profile.get('ttsVoice', 'zh-CN-XiaoyiNeural'), str(dry)]
            if rate != '+0%':
                cmd.extend(['--rate', rate])
            proc = subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=120)
            dry = Path(proc.stdout.strip().splitlines()[-1])
        else:
            import edge_tts
            asyncio.run(edge_tts.Communicate(args.text, profile.get('ttsVoice', 'zh-CN-XiaoyiNeural'), rate=rate).save(str(dry)))
    runtime = Path(__file__).resolve().parents[1] / 'vendor' / 'phone' / 'rvc_onnx.py'
    spec = importlib.util.spec_from_file_location('lucidheart_phone_rvc', runtime)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.shape_intonation(module.np.array([], dtype=module.np.float32), intonation_scale)  # Validate before model loading.
    if args.seed is not None:
        if not 0 <= args.seed < 2 ** 32:
            raise ValueError('Seed must be within 0..2**32-1')
        module.np.random.seed(args.seed)
        module.ort.set_seed(args.seed)
    dry_duration = len(module.load_audio(str(dry), target_sr=16000)) / 16000
    if profile.get('synthesisMode') == 'continuous' and dry_duration >= 10:
        raise ValueError('Continuous audition currently requires a dry clip shorter than 10 seconds')
    result = module.convert_audio(input_path=str(dry), models_dir=str(models), output_path=str(output),
                                  work_dir=str(output.with_suffix('.work')), pitch_change=profile.get('pitch', 0),
                                  index_path=str(models / profile['index']), index_ratio=profile.get('indexRatio', 0.3),
                                  index_method=profile.get('indexMethod', 'cosine1'), protect=profile.get('protect', 0.33),
                                  brightness=profile.get('brightness', 0), num_threads=4,
                                  synthesis_mode=profile.get('synthesisMode', 'chunked'),
                                  noise_scale=profile.get('noiseScale', 1.0), intonation_scale=intonation_scale)
    import numpy as np
    import soundfile as sf
    audio, sr = sf.read(output)
    if sr != 40000 or not np.isfinite(audio).all() or not len(audio) or float(np.max(np.abs(audio))) < 1e-5:
        raise ValueError('Output failed audio validation')
    result.update(profileId=profile['id'], mode='profile_phone_onnx_cpu', profileSha256=digest(profile_path),
                  runtimeSha256=digest(runtime), outputSha256=digest(output), sampleRate=sr,
                  elapsedTotalMs=round((time.perf_counter() - started) * 1000),
                  pitch=profile.get('pitch', 0), brightness=profile.get('brightness', 0),
                  indexMethod=profile.get('indexMethod', 'cosine1'), indexRatio=profile.get('indexRatio', 0.3),
                  synthesisMode=profile.get('synthesisMode', 'chunked'), noiseScale=profile.get('noiseScale', 1.0),
                  intonationScale=intonation_scale, ttsRate=rate if not args.input else None,
                  inputSha256=digest(dry), seed=args.seed,
                  peak=float(np.max(np.abs(audio))), validatedOn=sys.platform,
                  scope='PC CPU validation is not ARM64/Proot acceptance or reference audio parity')
    result.update(architecture=platform.machine(), onnxruntime=module.ort.__version__, numpy=np.__version__,
                  torchImported='torch' in sys.modules, executionProvider='CPUExecutionProvider')
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ['PeakWorkingSetSize', 'WorkingSetSize', 'QuotaPeakPagedPoolUsage',
                 'QuotaPagedPoolUsage', 'QuotaPeakNonPagedPoolUsage', 'QuotaNonPagedPoolUsage', 'PagefileUsage', 'PeakPagefileUsage']]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        ctypes.windll.kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        if ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            result['peakWorkingSetMiB'] = round(counters.PeakWorkingSetSize / 1024**2, 1)
    output.with_suffix('.result.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
