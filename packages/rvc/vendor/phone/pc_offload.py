#!/usr/bin/env python3
"""pc_offload.py: PC RVC Offload Engine with per-chunk fallback and seamless Hann OLA.

Designed for Xiaoman (大肥鱼) singing pipeline:
1. convert_via_pc(chunk_wav) -> bytes | None
   - Bounded 8MiB WAV transmission, 300s timeout
   - Strict response validation matching saveOffloadAudio (RIFF/WAVE header, SHA256, assets, settings)
   - Clean None return on failure to trigger per-chunk fallback
2. Hann-window Overlap-Add (OLA) crossfade for click-free chunk seams
3. Resumable manifest for chunk-level progress persistence
4. Mixing stays on phone (mix.py)
"""

import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path
from typing import Optional, Union

import numpy as np

try:
    import soundfile as sf
except ImportError:
    sf = None

try:
    import scipy.io.wavfile as wavfile
except ImportError:
    wavfile = None


ASSETS = ('model.onnx', 'hubert.onnx', 'rmvpe.onnx', 'voice.mobile.index')
DEFAULTS = {
    'pitch': 0, 'brightness': 0, 'indexMethod': 'l2-8', 'indexRatio': 0.3,
    'protect': 0.33, 'ttsVoice': 'zh-CN-XiaoyiNeural', 'ttsRate': '+0%',
    'synthesisMode': 'chunked', 'noiseScale': 1.0, 'intonationScale': 1.0
}
MAX_AUDIO_BYTES = 8 * 1024 * 1024


def audio_to_wav_bytes(audio: Union[str, Path, bytes, np.ndarray], sr: int = 16000) -> bytes:
    """Normalize input audio to 16-bit mono WAV bytes."""
    if isinstance(audio, (str, Path)):
        p = Path(audio)
        if not p.is_file():
            raise FileNotFoundError(f"Audio file not found: {p}")
        data = p.read_bytes()
        if data[:4] == b'RIFF' and data[8:12] == b'WAVE':
            return data
        # Non-WAV file; load via sf or librosa
        if sf is not None:
            samples, file_sr = sf.read(str(p), dtype='float32')
            if samples.ndim > 1:
                samples = samples.mean(axis=1)
            audio = samples
            sr = file_sr
        else:
            raise ValueError(f"File {p} is not WAV and soundfile is unavailable")

    if isinstance(audio, np.ndarray):
        samples = np.asarray(audio, dtype=np.float32)
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        # Rescale float to int16
        peak = np.max(np.abs(samples)) if len(samples) else 0.0
        if peak > 1.0:
            samples = samples / peak
        pcm = np.clip(samples * 32767.0, -32768.0, 32767.0).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(pcm.tobytes())
        return buf.getvalue()

    if isinstance(audio, bytes):
        if not (44 < len(audio) <= MAX_AUDIO_BYTES and audio[:4] == b'RIFF' and audio[8:12] == b'WAVE'):
            raise ValueError("Input bytes are not a valid RIFF/WAVE stream")
        return audio

    raise TypeError(f"Unsupported audio type: {type(audio)}")


def wav_bytes_to_audio(data: bytes) -> tuple[np.ndarray, int]:
    """Decode RIFF/WAVE bytes into float32 numpy array and sample rate."""
    if sf is not None:
        arr, sr = sf.read(io.BytesIO(data), dtype='float32')
        if arr.ndim > 1:
            arr = arr.mean(axis=1)
        return arr, sr
    with wave.open(io.BytesIO(data), 'rb') as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sr = wf.getframerate()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)
        if sampwidth == 2:
            arr = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        elif sampwidth == 4:
            arr = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
        else:
            raise ValueError(f"Unsupported WAV sample width: {sampwidth}")
        if n_channels > 1:
            arr = arr.reshape(-1, n_channels).mean(axis=1)
        return arr, sr


def load_voice_contract(profile_path: Union[str, Path], pitch: int = 0) -> dict:
    """Load voice profile and build strict verification contract."""
    p = Path(profile_path)
    if not p.is_file():
        raise FileNotFoundError(f"Voice profile not found at {p}")
    prof = json.loads(p.read_text(encoding='utf-8-sig'))
    if prof.get('engine') != 'rvc-onnx':
        raise ValueError(f"Unsupported profile engine: {prof.get('engine')}")
    assets = {}
    for name in ASSETS:
        sha = prof.get('assets', {}).get(name, {}).get('sha256')
        if not sha or not re.fullmatch(r'[a-f0-9]{64}', sha, re.IGNORECASE):
            raise ValueError(f"Invalid or missing asset hash for {name}")
        assets[name] = sha

    settings = dict(DEFAULTS)
    for k in DEFAULTS:
        if k in prof:
            settings[k] = prof[k]
    settings['pitch'] = int(pitch)
    settings['synthesisMode'] = 'chunked'
    return {'id': prof['id'], 'assets': assets, 'settings': settings}


def validate_pc_response(res: dict, contract: dict) -> bytes:
    """Strictly validate PC offload response according to saveOffloadAudio specification."""
    if not isinstance(res, dict) or not res.get('ok'):
        raise ValueError("PC response ok is False or missing")
    if res.get('voiceId') != contract['id']:
        raise ValueError(f"voiceId mismatch: expected {contract['id']}, got {res.get('voiceId')}")
    if res.get('mode') != 'pc_onnx_offload':
        raise ValueError(f"mode mismatch: expected pc_onnx_offload, got {res.get('mode')}")
    if res.get('provider') not in ('CPUExecutionProvider', 'CUDAExecutionProvider'):
        raise ValueError(f"unsupported provider: {res.get('provider')}")
    if res.get('sampleRate') != 40000:
        raise ValueError(f"sampleRate must be 40000, got {res.get('sampleRate')}")

    # Asset verification
    res_assets = res.get('assets', {})
    for k, expected_sha in contract['assets'].items():
        if res_assets.get(k) != expected_sha:
            raise ValueError(f"Asset hash mismatch for {k}: expected {expected_sha}, got {res_assets.get(k)}")

    # Settings verification
    res_settings = res.get('settings', {})
    for k, expected_val in contract['settings'].items():
        if res_settings.get(k) != expected_val:
            raise ValueError(f"Setting mismatch for {k}: expected {expected_val}, got {res_settings.get(k)}")

    # AudioBase64 verification
    b64_str = res.get('audioBase64')
    if not isinstance(b64_str, str) or len(b64_str) > 11184812:
        raise ValueError("audioBase64 invalid length or type")
    if not re.fullmatch(r'[A-Za-z0-9+/=]+', b64_str):
        raise ValueError("audioBase64 character set invalid")

    data = base64.b64decode(b64_str, validate=True)
    if not (44 < len(data) <= MAX_AUDIO_BYTES):
        raise ValueError(f"Decoded audio byte size out of bounds: {len(data)}")
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise ValueError("Decoded audio is not valid RIFF/WAVE")
    actual_sha = hashlib.sha256(data).hexdigest()
    if actual_sha != res.get('sha256'):
        raise ValueError(f"Audio sha256 checksum mismatch: {actual_sha} vs {res.get('sha256')}")

    return data


def convert_via_pc(
    chunk_wav: Union[str, Path, bytes, np.ndarray],
    voice_profile_path: Union[str, Path] = "/sdcard/rvc/models/feiyu-rvc-v1/voice-profile.json",
    gateway_url: str = "http://127.0.0.1:28765",
    auth_token: str = "xiaoman-pc-bridge-secret-2026",
    pitch: int = 0,
    timeout: float = 300.0,
    sr: int = 16000
) -> Optional[bytes]:
    """Single-chunk PC RVC offload converter.

    Returns:
        WAV bytes of 40kHz converted audio on success, or None on failure/fallback.
    """
    try:
        wav_bytes = audio_to_wav_bytes(chunk_wav, sr=sr)
        if len(wav_bytes) > MAX_AUDIO_BYTES:
            print(f"[pc_offload] Chunk exceeds 8MiB limit ({len(wav_bytes)} bytes), skipping PC", file=sys.stderr)
            return None

        contract = load_voice_contract(voice_profile_path, pitch=pitch)
        payload = {
            'audioBase64': base64.b64encode(wav_bytes).decode('ascii'),
            'voice': {
                'id': contract['id'],
                'assets': contract['assets'],
                'settings': contract['settings']
            }
        }

        endpoint = f"{gateway_url.rstrip('/')}/v1/voice/rvc"
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {auth_token}'
            }
        )

        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status != 200:
                print(f"[pc_offload] PC Gateway returned HTTP {resp.status}", file=sys.stderr)
                return None
            body = json.loads(resp.read().decode('utf-8'))
            return validate_pc_response(body, contract)

    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = f": {e.read().decode('utf-8', 'replace')}"
        except Exception:
            pass
        print(f"[pc_offload] PC HTTP {e.code} ({e.reason}){detail}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"[pc_offload] PC Connection failed: {e.reason}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[pc_offload] PC offload error/validation failed: {e}", file=sys.stderr)
        return None


def stitch_chunks_ola(
    chunks: list[np.ndarray],
    step_samples: int,
    overlap_samples: int
) -> np.ndarray:
    """Seamlessly stitch audio chunks using Hann-window Overlap-Add (OLA).

    Guarantee: cos^2(t) + sin^2(t) == 1 everywhere in the overlap.
    """
    if not chunks:
        return np.array([], dtype=np.float32)
    if len(chunks) == 1:
        return chunks[0]

    # Precalculate Hann crossfade ramps
    t = np.linspace(0, np.pi, overlap_samples, endpoint=False, dtype=np.float32)
    fade_out = 0.5 * (1.0 + np.cos(t))
    fade_in = 0.5 * (1.0 - np.cos(t))

    total_len = (len(chunks) - 1) * step_samples + len(chunks[-1])
    out = np.zeros(total_len, dtype=np.float32)

    current_pos = 0
    for i, c in enumerate(chunks):
        c_len = len(c)
        if i == 0:
            out[:c_len] = c
            current_pos = step_samples
            continue

        # Overlap region with previous chunk
        ov_len = min(overlap_samples, c_len, total_len - current_pos)
        prev_tail = out[current_pos : current_pos + ov_len]
        curr_head = c[:ov_len]

        if ov_len == overlap_samples:
            blended = prev_tail * fade_out + curr_head * fade_in
        else:
            # Partial overlap on boundary
            t_part = np.linspace(0, np.pi, ov_len, endpoint=False, dtype=np.float32)
            blended = prev_tail * (0.5 * (1.0 + np.cos(t_part))) + curr_head * (0.5 * (1.0 - np.cos(t_part)))

        out[current_pos : current_pos + ov_len] = blended
        if c_len > ov_len:
            out[current_pos + ov_len : current_pos + c_len] = c[ov_len:]

        current_pos += step_samples

    return out


def convert_song_offload(
    input_audio: str,
    output_wav: str,
    models_dir: str = "/sdcard/rvc/models/feiyu-rvc-v1",
    work_dir: Optional[str] = None,
    pitch: int = 0,
    segment_seconds: float = 15.0,
    overlap_seconds: float = 0.5,
    gateway_url: str = "http://127.0.0.1:28765",
    auth_token: str = "xiaoman-pc-bridge-secret-2026",
    local_rvc_script: Optional[str] = None
) -> dict:
    """Full song conversion engine with chunk-by-chunk PC offload & local fallback.

    Args:
        input_audio: Path to vocals.wav
        output_wav: Path for the synthesized 40kHz vocals
        models_dir: Directory containing voice-profile.json and model assets
        segment_seconds: Chunk duration step (default 15s)
        overlap_seconds: Overlap for Hann OLA crossfade (default 0.5s)
    """
    start_time = time.time()
    profile_path = os.path.join(models_dir, "voice-profile.json")
    if not os.path.exists(profile_path):
        raise FileNotFoundError(f"voice-profile.json not found in {models_dir}")

    if work_dir is None:
        work_dir = os.path.join(os.path.dirname(os.path.abspath(output_wav)), ".sing_work")
    os.makedirs(work_dir, exist_ok=True)
    chunks_dir = os.path.join(work_dir, "chunks")
    os.makedirs(chunks_dir, exist_ok=True)
    manifest_path = os.path.join(work_dir, "manifest.json")

    # Load input audio at 16kHz
    print(f"[sing_offload] Loading input audio: {input_audio}", flush=True)
    if sf is not None:
        audio, in_sr = sf.read(input_audio, dtype='float32')
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if in_sr != 16000:
            import scipy.signal as signal
            num_samples = int(len(audio) * 16000 / in_sr)
            audio = signal.resample(audio, num_samples).astype(np.float32)
        audio16k = audio
    else:
        with wave.open(input_audio, 'rb') as wf:
            in_sr = wf.getframerate()
            raw = wf.readframes(wf.getnframes())
            audio16k = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    total_len_16k = len(audio16k)
    duration_s = total_len_16k / 16000.0
    print(f"[sing_offload] Input length: {duration_s:.1f}s ({total_len_16k} samples at 16kHz)", flush=True)

    step_16k = int(segment_seconds * 16000)
    overlap_16k = int(overlap_seconds * 16000)
    step_40k = int(segment_seconds * 40000)
    overlap_40k = int(overlap_seconds * 40000)

    segments = []
    start = 0
    while start < total_len_16k:
        end = min(total_len_16k, start + step_16k + overlap_16k)
        idx = len(segments)
        segments.append({
            'index': idx,
            'start_16k': start,
            'end_16k': end,
            'out_file': os.path.join(chunks_dir, f'chunk_{idx:04d}.wav')
        })
        start += step_16k
        if start >= total_len_16k:
            break

    num_segments = len(segments)
    print(f"[sing_offload] Split into {num_segments} chunks (step={segment_seconds}s, overlap={overlap_seconds}s)", flush=True)

    manifest = {'input': os.path.abspath(input_audio), 'total': num_segments, 'completed': {}, 'status': 'running'}
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, 'r', encoding='utf-8') as f:
                old = json.load(f)
                if old.get('input') == os.path.abspath(input_audio) and old.get('total') == num_segments:
                    manifest['completed'] = old.get('completed', {})
        except Exception:
            pass

    pc_count = 0
    local_count = 0

    for seg in segments:
        idx = seg['index']
        out_f = seg['out_file']

        # Skip if already cached
        if str(idx) in manifest['completed'] and os.path.exists(out_f) and os.path.getsize(out_f) > 1000:
            source = manifest['completed'][str(idx)]
            print(f"[{idx+1}/{num_segments}] Already completed via {source}, skipping", flush=True)
            if source == 'pc':
                pc_count += 1
            else:
                local_count += 1
            continue

        chunk_16k = audio16k[seg['start_16k'] : seg['end_16k']]
        chunk_dur = len(chunk_16k) / 16000.0
        print(f"[{idx+1}/{num_segments}] Converting {chunk_dur:.1f}s chunk...", end='', flush=True)

        t_chunk = time.time()
        # 1. Try PC Offload
        pc_wav = convert_via_pc(
            chunk_16k,
            voice_profile_path=profile_path,
            gateway_url=gateway_url,
            auth_token=auth_token,
            pitch=pitch,
            sr=16000
        )

        if pc_wav is not None:
            Path(out_f).write_bytes(pc_wav)
            manifest['completed'][str(idx)] = 'pc'
            pc_count += 1
            print(f" OK [PC Offload: {time.time()-t_chunk:.1f}s]", flush=True)
        else:
            # 2. Fallback to Local RVC
            print(f" Falling back to local ONNX...", end='', flush=True)
            t_loc = time.time()
            success = run_local_chunk_fallback(
                chunk_16k, out_f, models_dir=models_dir, pitch=pitch,
                local_rvc_script=local_rvc_script
            )
            if not success:
                raise RuntimeError(f"Chunk {idx+1}/{num_segments} failed on both PC and local fallback")
            manifest['completed'][str(idx)] = 'local'
            local_count += 1
            print(f" OK [Local ONNX: {time.time()-t_loc:.1f}s]", flush=True)

        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, indent=2)

    # 3. Stitch all chunks via Hann OLA
    print(f"[sing_offload] Stitching {num_segments} chunks with Hann OLA crossfade...", flush=True)
    chunks_40k = []
    for seg in segments:
        arr, sr = wav_bytes_to_audio(Path(seg['out_file']).read_bytes())
        if sr != 40000:
            raise ValueError(f"Chunk {seg['index']} sample rate is {sr}, expected 40000")
        chunks_40k.append(arr)

    final_audio = stitch_chunks_ola(chunks_40k, step_samples=step_40k, overlap_samples=overlap_40k)

    # Peak normalization
    peak = float(np.max(np.abs(final_audio))) if len(final_audio) else 0.0
    if peak > 0.95:
        final_audio = final_audio * (0.95 / peak)

    # Save output
    os.makedirs(os.path.dirname(os.path.abspath(output_wav)), exist_ok=True)
    if sf is not None:
        sf.write(output_wav, final_audio, 40000, subtype='PCM_16')
    else:
        pcm16 = np.clip(final_audio * 32767.0, -32768.0, 32767.0).astype(np.int16)
        with wave.open(output_wav, 'wb') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(40000)
            wf.writeframes(pcm16.tobytes())

    manifest['status'] = 'completed'
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)

    elapsed_s = time.time() - start_time
    print(f"[sing_offload] Completed in {elapsed_s:.1f}s (PC: {pc_count}, Local: {local_count}) -> {output_wav}", flush=True)

    return {
        'ok': True,
        'output': os.path.abspath(output_wav),
        'duration_seconds': round(duration_s, 2),
        'elapsed_seconds': round(elapsed_s, 2),
        'chunks': num_segments,
        'pc_chunks': pc_count,
        'local_chunks': local_count,
        'seam_strategy': 'hann_ola_0.5s'
    }


def run_local_chunk_fallback(
    chunk_16k: np.ndarray,
    out_file: str,
    models_dir: str,
    pitch: int = 0,
    local_rvc_script: Optional[str] = None
) -> bool:
    """Run local RVC ONNX inference for a single chunk."""
    # Attempt Python import first
    try:
        import importlib.util
        script = local_rvc_script or os.path.join(os.path.dirname(__file__), "rvc_onnx.py")
        if not os.path.exists(script):
            script = "/sdcard/rvc/rvc_onnx.py"
        if os.path.exists(script):
            spec = importlib.util.spec_from_file_location("local_rvc", script)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            # Save chunk temporarily to disk
            tmp_in = out_file + ".in.wav"
            mod.save_wav(tmp_in, chunk_16k, 16000)
            try:
                mod.convert_audio(
                    input_path=tmp_in,
                    models_dir=models_dir,
                    output_path=out_file,
                    pitch_change=pitch,
                    segment_duration=30.0,
                    synthesis_mode='chunked'
                )
                return os.path.exists(out_file) and os.path.getsize(out_file) > 1000
            finally:
                if os.path.exists(tmp_in):
                    os.remove(tmp_in)
    except Exception as e:
        print(f"[local_fallback] Python execution failed: {e}", file=sys.stderr)

    return False


def main():
    parser = argparse.ArgumentParser(description="PC RVC Offload Engine for Singing")
    parser.add_argument("input", nargs="?", help="Input vocals.wav")
    parser.add_argument("output", nargs="?", help="Output voc_new.wav")
    parser.add_argument("--models_dir", default="/sdcard/rvc/models/feiyu-rvc-v1", help="Path to models directory")
    parser.add_argument("--pitch", type=int, default=0, help="Semitone pitch shift (0 or -4)")
    parser.add_argument("--segment_seconds", type=float, default=15.0, help="Chunk step duration in seconds")
    parser.add_argument("--overlap_seconds", type=float, default=0.5, help="Hann OLA overlap duration in seconds")
    parser.add_argument("--gateway_url", default="http://127.0.0.1:28765", help="FullAwake Gateway URL")
    parser.add_argument("--auth_token", default="xiaoman-pc-bridge-secret-2026", help="FullAwake Auth Token")
    parser.add_argument("--test_pc", action="store_true", help="Test PC connectivity and 1-second synthetic chunk conversion")
    args = parser.parse_args()

    if args.test_pc:
        print(f"Testing PC Gateway at {args.gateway_url}...")
        # Synthetic 1s 440Hz tone
        t = np.linspace(0, 1.0, 16000, endpoint=False, dtype=np.float32)
        tone = (0.2 * np.sin(2 * np.pi * 440.0 * t))
        res = convert_via_pc(
            tone,
            voice_profile_path=os.path.join(args.models_dir, "voice-profile.json"),
            gateway_url=args.gateway_url,
            auth_token=args.auth_token,
            pitch=args.pitch
        )
        if res:
            print(f"SUCCESS: Received {len(res)} bytes 40kHz WAV from PC!")
            sys.exit(0)
        else:
            print("FAILURE: PC conversion returned None", file=sys.stderr)
            sys.exit(1)

    if not args.input or not args.output:
        parser.print_help()
        sys.exit(1)

    result = convert_song_offload(
        input_audio=args.input,
        output_wav=args.output,
        models_dir=args.models_dir,
        pitch=args.pitch,
        segment_seconds=args.segment_seconds,
        overlap_seconds=args.overlap_seconds,
        gateway_url=args.gateway_url,
        auth_token=args.auth_token
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
