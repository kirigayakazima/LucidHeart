#!/usr/bin/env python3
"""
rvc-onnx.py: Lightweight, pure ONNX Runtime RVC v2 inference pipeline.
Designed for low-resource environments (proot Linux container / mobile / edge).

Zero PyTorch dependency during inference.
Requires only: onnxruntime, numpy, scipy / soundfile / librosa, (ffmpeg optional for m4a decode).
Supports:
  - 10-15s segmenting with breakpoint resumption (manifest.json)
  - 200-frame vocoder chunking with Hann-window Overlap-Add (OLA)
  - Memory-safe batched index feature retrieval (Dv5.mobile.index)
  - Unvoiced consonant protection (--protect)
  - Optional high-frequency brightness compensation (--brightness)
  - Clean JSON stdout progress & results for bot integration
"""

import os
import sys
import time
import json
import math
import argparse
import subprocess
import numpy as np

# Optional imports handled gracefully
try:
    import soundfile as sf
except ImportError:
    sf = None

try:
    import scipy.io.wavfile as wavfile
    import scipy.signal as signal
except ImportError:
    wavfile = None
    signal = None

try:
    import librosa
except ImportError:
    librosa = None

import onnxruntime as ort

HUBERT_CONV_KERNELS = [10, 3, 3, 3, 3, 2, 2]
HUBERT_CONV_STRIDES = [5, 2, 2, 2, 2, 2, 2]
RMVPE_CENTS_BASE = 1997.3794084376191
RMVPE_CENTS_PER_BIN = 20.0
VOICE_CHUNK_FRAMES = 200
VOICE_CENTER_FRAMES = 80
VOICE_CONTEXT_FRAMES = (VOICE_CHUNK_FRAMES - VOICE_CENTER_FRAMES) // 2
CHUNK_CROSSFADE_SAMPLES = 768

def calculate_hubert_frame_count(length: int) -> int:
    frame_count = length
    for kernel, stride in zip(HUBERT_CONV_KERNELS, HUBERT_CONV_STRIDES):
        frame_count = (frame_count - kernel) // stride + 1
    return frame_count

def align_hubert_input_length(length: int) -> int:
    candidate = max(801, length)
    while True:
        frame_count = calculate_hubert_frame_count(candidate)
        if frame_count > 0 and frame_count % 2 == 0 and candidate % frame_count != 0:
            return candidate
        candidate += 1

def load_audio(path: str, target_sr: int = 16000) -> np.ndarray:
    """Load any audio format (wav, m4a, mp3) and return float32 mono array at target_sr."""
    if path.lower().endswith(".wav") and sf is not None:
        audio, sr = sf.read(path)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != target_sr:
            if librosa is not None:
                audio = librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=target_sr)
            elif signal is not None:
                num_samples = int(len(audio) * target_sr / sr)
                audio = signal.resample(audio, num_samples).astype(np.float32)
        return audio.astype(np.float32)

    # Use ffmpeg if available for m4a/mp3 or fallback
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", path, "-vn", "-ac", "1", "-ar", str(target_sr),
        "-f", "f32le", "-"
    ]
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        return np.frombuffer(proc.stdout, dtype=np.float32)
    except Exception as e:
        if sf is not None:
            audio, sr = sf.read(path)
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if sr != target_sr and librosa is not None:
                audio = librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=target_sr)
            return audio.astype(np.float32)
        raise RuntimeError(f"Failed to load audio {path}: {e}")

def save_wav(path: str, audio: np.ndarray, sr: int = 40000):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if sf is not None:
        sf.write(path, audio.astype(np.float32), sr)
    elif wavfile is not None:
        scaled = np.clip(audio * 32767.0, -32768.0, 32767.0).astype(np.int16)
        wavfile.write(path, sr, scaled)
    else:
        raise RuntimeError("No audio writer available (install soundfile or scipy)")

def extract_hubert_features(hubert_sess, audio16k: np.ndarray) -> np.ndarray:
    raw_len = len(audio16k)
    aligned_len = align_hubert_input_length(raw_len)
    
    padded_audio = np.zeros((1, aligned_len), dtype=np.float32)
    padded_audio[0, :raw_len] = audio16k
    
    mask = np.zeros((1, aligned_len), dtype=bool)
    mask[0, raw_len:] = True
    
    out = hubert_sess.run(None, {"source": padded_audio, "padding_mask": mask})[0]
    feats = out[0] # [frames, 768]
    feats_100hz = np.repeat(feats, 2, axis=0) # 50Hz -> 100Hz
    return feats_100hz

def shape_intonation(pitchf: np.ndarray, scale: float = 1.0) -> np.ndarray:
    """Experimental: expand voiced log-F0 around its median, not a global shift.

    Preserve unvoiced frames and cap each frame's added deviation at 2 semitones.
    Scale 1 is an exact bypass, keeping accepted/default synthesis unchanged.
    """
    if not np.isfinite(scale) or not 0.8 <= scale <= 1.6:
        raise ValueError('Intonation scale must be finite and within 0.8..1.6')
    if not np.isfinite(pitchf).all() or np.any(pitchf < 0):
        raise ValueError('F0 must contain finite nonnegative values')
    if scale == 1.0:
        return pitchf
    voiced = pitchf > 0
    if voiced.sum() < 2:
        return pitchf.copy()
    result = pitchf.copy()
    log_f0 = np.log2(pitchf[voiced].astype(np.float64))
    center = np.median(log_f0)
    extra = np.clip((log_f0 - center) * (scale - 1.0), -2 / 12, 2 / 12)
    result[voiced] = np.clip(np.exp2(log_f0 + extra), 50, 1100)
    return result


def extract_rmvpe_pitch(rmvpe_sess, audio16k: np.ndarray, target_frame_count: int, pitch_change: float = 0.0,
                        intonation_scale: float = 1.0):
    # Mel Filterbank calculation
    if librosa is not None:
        mel_fb = librosa.filters.mel(sr=16000, n_fft=1024, n_mels=128, fmin=30, fmax=8000, htk=True)
        D = np.abs(librosa.stft(audio16k, n_fft=1024, hop_length=160, win_length=1024, window='hann', center=True, pad_mode='reflect'))
        mel = np.log(np.clip(np.matmul(mel_fb, D), a_min=1e-5, a_max=None)).astype(np.float32)
    else:
        raise RuntimeError("librosa required for mel filterbank calculation")
        
    n_frames = mel.shape[-1]
    n_pad = 32 * ((n_frames - 1) // 32 + 1) - n_frames
    if n_pad > 0:
        mel = np.pad(mel, ((0, 0), (0, n_pad)), mode='constant')
        
    mel_input = np.expand_dims(mel, 0)
    output = rmvpe_sess.run(None, {"input": mel_input})[0]
    salience = output[0]
    
    semitone_factor = 2.0 ** (pitch_change / 12.0)
    pitchf = np.zeros(target_frame_count, dtype=np.float32)
    
    for f in range(target_frame_count):
        src_f = min(f, salience.shape[0] - 1)
        best_bin = np.argmax(salience[src_f])
        conf = salience[src_f, best_bin]
        if conf >= 0.05:
            cents = RMVPE_CENTS_BASE + RMVPE_CENTS_PER_BIN * best_bin
            freq = 10.0 * (2.0 ** (cents / 1200.0))
            pitchf[f] = freq * semitone_factor
        else:
            pitchf[f] = 0.0
            
    pitchf = shape_intonation(pitchf, intonation_scale)
    f0_min = 50.0
    f0_max = 1100.0
    f0_mel_min = 1127.0 * np.log(1.0 + f0_min / 700.0)
    f0_mel_max = 1127.0 * np.log(1.0 + f0_max / 700.0)
    
    pitch = pitchf.copy()
    f0_mel = 1127.0 * np.log(1.0 + pitch / 700.0)
    voiced = pitch > 0
    f0_mel[voiced] = (f0_mel[voiced] - f0_mel_min) * 254.0 / (f0_mel_max - f0_mel_min) + 1.0
    f0_mel[~voiced] = 1.0
    f0_mel[f0_mel <= 1.0] = 1.0
    f0_mel[f0_mel > 255.0] = 255.0
    pitch_quantized = np.rint(f0_mel).astype(np.int64)
    
    return pitchf, pitch_quantized

def load_mobile_index(path: str, normalize: bool = True) -> np.ndarray:
    """读 mobile index: magic URVCIDX1 + uint32 count + float32 向量矩阵。"""
    with open(path, "rb") as f:
        magic = f.read(8)
        if magic != b"URVCIDX1":
            raise RuntimeError(f"不认识的 index 格式: {magic!r}")
        count = int.from_bytes(f.read(4), "little")
        vec = np.frombuffer(f.read(), dtype=np.float32)
    dim = vec.size // count
    vec = vec[: count * dim].reshape(count, dim)
    if normalize:
        vec = (vec / (np.linalg.norm(vec, axis=1, keepdims=True) + 1e-9)).astype(np.float32)
    print(f"[index] 载入 {count} 条 x {dim} 维", flush=True)
    return vec

def apply_index(phone: np.ndarray, table: np.ndarray, ratio: float, batch_size: int = 500, method: str = 'cosine1') -> np.ndarray:
    """按相似度分批检索最接近的训练特征，按 ratio 混合回去。
    分批检索 (batch_size=500 帧) 避免全曲长音频时 (T, 55548) 相似度矩阵占用数 GB 内存导致 OOM。
    """
    if ratio <= 0.0 or table is None or len(table) == 0:
        return phone
    if method == 'l2-8':
        # Standard RVC retrieval: raw vectors, squared-L2 nearest 8 and inverse-square weights.
        # Bounded batches keep this path usable without FAISS on ARM64.
        norms = np.sum(table * table, axis=1)
        results = []
        k = min(8, len(table))
        for i in range(0, len(phone), batch_size):
            query = phone[i:i + batch_size].astype(np.float32)
            scores = np.maximum(np.sum(query * query, axis=1, keepdims=True) + norms - 2 * query @ table.T, 0)
            nearest = np.argpartition(scores, k - 1, axis=1)[:, :k]
            distances = np.take_along_axis(scores, nearest, axis=1)
            weights = np.square(1.0 / np.maximum(distances, 1e-6))
            weights /= weights.sum(axis=1, keepdims=True)
            retrieved = np.sum(table[nearest] * weights[..., None], axis=1)
            results.append(retrieved * ratio + query * (1.0 - ratio))
        return np.concatenate(results).astype(np.float32)
    if method != 'cosine1':
        raise ValueError(f'Unknown index method: {method}')
    q = phone.astype(np.float32)
    q = q / (np.linalg.norm(q, axis=1, keepdims=True) + 1e-9)
    n_frames = q.shape[0]
    got_list = []
    for i in range(0, n_frames, batch_size):
        q_batch = q[i : i + batch_size]
        sim_batch = q_batch @ table.T
        best_idx = np.argmax(sim_batch, axis=1)
        got_list.append(table[best_idx])
    got = np.concatenate(got_list, axis=0)
    return (phone * (1.0 - ratio) + got * ratio).astype(np.float32)

def apply_brightness(audio: np.ndarray, sr: int = 40000, gain_db: float = 2.5, cutoff_hz: float = 7000.0) -> np.ndarray:
    """轻微高频提升（High-shelf filter），补偿 RVC 40k 声码器的高频衰减（约 25% 频谱质心损失）。
    默认 gain_db=2.5dB, cutoff=7000Hz，避免齿音过冲。
    """
    if gain_db <= 0.0:
        return audio
    try:
        from scipy import signal
        A = 10.0 ** (gain_db / 40.0)
        w0 = 2.0 * math.pi * cutoff_hz / sr
        alpha = math.sin(w0) / 2.0 * math.sqrt(2.0)
        cos_w0 = math.cos(w0)
        
        b0 = A * ((A + 1.0) + (A - 1.0) * cos_w0 + 2.0 * math.sqrt(A) * alpha)
        b1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cos_w0)
        b2 = A * ((A + 1.0) + (A - 1.0) * cos_w0 - 2.0 * math.sqrt(A) * alpha)
        a0 = (A + 1.0) - (A - 1.0) * cos_w0 + 2.0 * math.sqrt(A) * alpha
        a1 = 2.0 * ((A - 1.0) - (A + 1.0) * cos_w0)
        a2 = (A + 1.0) - (A - 1.0) * cos_w0 - 2.0 * math.sqrt(A) * alpha
        
        b = np.array([b0, b1, b2], dtype=np.float64) / a0
        a = np.array([a0, a1, a2], dtype=np.float64) / a0
        out = signal.lfilter(b, a, audio.astype(np.float64))
        max_val = np.max(np.abs(out))
        if max_val > 0.99:
            out = out * (0.99 / max_val)
        return out.astype(np.float32)
    except Exception as e:
        print(f"[warning] brightness filter failed: {e}", flush=True)
        return audio

def synthesize_segment(voice_sess, phone: np.ndarray, pitch: np.ndarray, pitchf: np.ndarray,
                       mode: str = 'chunked', noise_scale: float = 1.0, max_frames: int = 1000) -> np.ndarray:
    total_frames = len(pitch)
    if mode not in ('chunked', 'continuous') or not np.isfinite(noise_scale) or not 0 <= noise_scale <= 1:
        raise ValueError('Invalid synthesis mode/noise scale')
    if mode == 'continuous':
        # Independently synthesized voiced chunks have unrelated oscillator phases.
        # Cross-fading those waveforms can cancel harmonics and produce tremolo.
        # Keep one phase trajectory per bounded utterance; never silently fall back.
        if total_frames > max_frames or total_frames < 1:
            raise ValueError(f'Continuous synthesis requires 1..{max_frames} frames; split the utterance first')
        inputs = {'phone': np.asarray(phone[:total_frames], dtype=np.float32)[None],
                  'phone_lengths': np.array([total_frames], dtype=np.int64),
                  'pitch': np.asarray(pitch, dtype=np.int64)[None],
                  'pitchf': np.asarray(pitchf, dtype=np.float32)[None],
                  'ds': np.array([0], dtype=np.int64),
                  'rnd': np.random.randn(1, 192, total_frames).astype(np.float32) * noise_scale}
        return voice_sess.run(None, inputs)[0].reshape(-1)[:total_frames * 400].astype(np.float32)
    hop_size = 400  # 40000 / 100
    expected = total_frames * hop_size
    acc = np.zeros(expected + hop_size * 2, dtype=np.float64)
    wsum = np.zeros_like(acc)

    for center_start in range(0, total_frames, VOICE_CENTER_FRAMES):
        chunk_start = max(0, center_start - VOICE_CONTEXT_FRAMES)
        chunk_end = min(total_frames, chunk_start + VOICE_CHUNK_FRAMES)
        chunk_len = chunk_end - chunk_start

        chunk_phone = np.zeros((1, VOICE_CHUNK_FRAMES, 768), dtype=np.float32)
        chunk_phone[0, :chunk_len] = phone[chunk_start:chunk_end]

        chunk_pitch = np.ones((1, VOICE_CHUNK_FRAMES), dtype=np.int64)
        chunk_pitch[0, :chunk_len] = pitch[chunk_start:chunk_end]

        chunk_pitchf = np.zeros((1, VOICE_CHUNK_FRAMES), dtype=np.float32)
        chunk_pitchf[0, :chunk_len] = pitchf[chunk_start:chunk_end]

        chunk_lengths = np.array([VOICE_CHUNK_FRAMES], dtype=np.int64)
        chunk_ds = np.array([0], dtype=np.int64)
        chunk_rnd = np.random.randn(1, 192, VOICE_CHUNK_FRAMES).astype(np.float32) * noise_scale

        ort_inputs = {
            "phone": chunk_phone,
            "phone_lengths": chunk_lengths,
            "pitch": chunk_pitch,
            "pitchf": chunk_pitchf,
            "ds": chunk_ds,
            "rnd": chunk_rnd,
        }

        wav_chunk = voice_sess.run(None, ort_inputs)[0].flatten()
        seg = wav_chunk[: chunk_len * hop_size].astype(np.float64)
        if len(seg) < 2:
            continue

        # 以本块的"中心区"为基准，前后用 hann 半窗淡入淡出，重叠相加 (OLA)
        center_off = (center_start - chunk_start) * hop_size
        center_samples = min(VOICE_CENTER_FRAMES, total_frames - center_start) * hop_size
        lo = max(0, center_off - hop_size * 4)
        hi = min(len(seg), center_off + center_samples + hop_size * 4)
        seg = seg[lo:hi]
        s = chunk_start * hop_size + lo

        win = np.ones(len(seg), dtype=np.float64)
        fade = min(hop_size * 4, len(seg) // 2)
        if fade > 2:
            ramp = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, fade))
            win[:fade] = ramp
            win[-fade:] = ramp[::-1]
        e = s + len(seg)
        if e > len(acc):
            pad = e - len(acc)
            acc = np.pad(acc, (0, pad))
            wsum = np.pad(wsum, (0, pad))
        acc[s:e] += seg * win
        wsum[s:e] += win

    out = acc / np.maximum(wsum, 1e-6)
    return out[:expected].astype(np.float32)

def plan_speech_segments(audio16k: np.ndarray, max_seconds: float = 8.0):
    """Partition on 10ms boundaries, preferring real >=80ms pauses.

    Centers <=8s plus 0.5s context on either side stay below the continuous
    vocoder's 1000-frame bound. No samples/pauses are removed or duplicated.
    Short utterances keep the accepted single-forward path unchanged.
    """
    audio = np.asarray(audio16k)
    if audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
        raise ValueError('Speech input must be finite, nonempty mono audio')
    if not np.isfinite(max_seconds) or not 2 <= max_seconds <= 8:
        raise ValueError('Speech segment centers must be within 2..8 seconds')
    hop, context = 160, 8000
    size = int(max_seconds * 100) * hop
    if len(audio) <= size:
        return [{'start_16k': 0, 'end_16k': len(audio), 'ctx_start_16k': 0,
                 'ctx_end_16k': len(audio), 'boundary': 'end'}]
    frames = np.pad(audio, (0, (-len(audio)) % hop)).reshape(-1, hop)
    energy = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    threshold = max(0.001, min(0.008, float(np.percentile(energy, 90)) * 0.04))
    quiet = energy <= threshold
    spans, start = [], 0
    while start < len(audio):
        limit = min(len(audio), start + size)
        end, boundary = limit, 'end'
        if limit < len(audio):
            # Prefer the latest usable pause, without producing tiny fragments.
            low = start // hop + min(300, size // hop // 2)
            high = limit // hop
            candidates = []
            run_start = None
            for frame in range(low, high):
                if quiet[frame] and run_start is None:
                    run_start = frame
                if run_start is not None and (not quiet[frame] or frame == high - 1):
                    stop = frame if not quiet[frame] else frame + 1
                    if stop - run_start >= 8:
                        candidates.append((run_start + stop) // 2)
                    run_start = None
            if candidates:
                end, boundary = candidates[-1] * hop, 'pause'
            else:
                # No audible pause: low-energy 50ms region in the final 2s.
                low = max(low, high - 200)
                smooth = np.convolve(energy, np.ones(5) / 5, mode='same')
                cut = low + int(np.argmin(smooth[low:high + 1]))
                end, boundary = cut * hop, 'low_energy'
        spans.append({'start_16k': start, 'end_16k': end,
                      'ctx_start_16k': max(0, start - context),
                      'ctx_end_16k': min(len(audio), end + context), 'boundary': boundary})
        start = end
    return spans


def crop_speech_segment(wav, seg, total_samples):
    """Keep exactly the center, including the final fractional 10ms frame."""
    first = (seg['start_16k'] - seg['ctx_start_16k']) * 5 // 2
    count = round(seg['end_16k'] * 2.5) - round(seg['start_16k'] * 2.5)
    if len(wav) < first + count:
        raise ValueError('Continuous segment output is incomplete; refusing to lose speech')
    result = np.array(wav[first:first + count], dtype=np.float32, copy=True)
    # Independent phases are never cross-faded over voiced audio. A tiny ramp
    # suppresses clicks at joins, retaining the original timeline and pauses.
    fade = min(200, len(result) // 2)  # 5ms at 40kHz
    if fade:
        ramp = np.linspace(0, 1, fade, dtype=np.float32)
        if seg['start_16k']:
            result[:fade] *= ramp
        if seg['end_16k'] < total_samples:
            result[-fade:] *= ramp[::-1]
    return result


def convert_audio(
    input_path: str,
    models_dir: str,
    output_path: str,
    work_dir: str = None,
    pitch_change: float = 0.0,
    segment_duration: float = 15.0,
    num_threads: int = 4,
    clean_chunks: bool = False,
    index_path: str = "",
    index_ratio: float = 0.0,
    protect: float = 0.33,
    brightness: float = 0.0,
    progress_callback = None,
    index_method: str = 'cosine1',
    synthesis_mode: str = 'chunked',
    noise_scale: float = 1.0,
    intonation_scale: float = 1.0,
    execution_providers = None,
    pc_offload: bool = False,
    pc_url: str = "http://127.0.0.1:28765",
):
    start_time = time.time()
    if execution_providers is None:
        execution_providers = ["CPUExecutionProvider"]
    
    if work_dir is None:
        work_dir = os.path.join(os.path.dirname(os.path.abspath(output_path)), ".rvc_work")
    os.makedirs(work_dir, exist_ok=True)
    chunks_dir = os.path.join(work_dir, "chunks")
    os.makedirs(chunks_dir, exist_ok=True)
    manifest_path = os.path.join(work_dir, "manifest.json")
    
    # Model files
    hubert_path = os.path.join(models_dir, "hubert.onnx")
    rmvpe_path = os.path.join(models_dir, "rmvpe.onnx")
    voice_path = os.path.join(models_dir, "model.onnx")
    if not os.path.exists(voice_path):
        # Fallback to any .onnx in models_dir
        onnx_candidates = [f for f in os.listdir(models_dir) if f.endswith(".onnx") and f not in ("hubert.onnx", "rmvpe.onnx")]
        if onnx_candidates:
            voice_path = os.path.join(models_dir, onnx_candidates[0])
            
    for p, name in [(hubert_path, "hubert.onnx"), (rmvpe_path, "rmvpe.onnx"), (voice_path, "voice onnx model")]:
        if not os.path.exists(p):
            raise FileNotFoundError(f"Missing required model {name} at {p}")

    # Load entire input audio at 16kHz
    if progress_callback:
        progress_callback(1.0, "Loading input audio")
    audio16k = load_audio(input_path, target_sr=16000)
    total_audio_len_16k = len(audio16k)
    duration_s = total_audio_len_16k / 16000.0
    
    # Continuous speech uses pause-aware bounded centers, shared model sessions,
    # and one phase trajectory per segment. Legacy Dv5 chunked mode is unchanged.
    segment_samples_16k = int(segment_duration * 16000)
    context_samples_16k = int(0.5 * 16000)
    
    segments = []
    start = 0
    while start < total_audio_len_16k:
        end = min(total_audio_len_16k, start + segment_samples_16k)
        # Context on both sides
        ctx_start = max(0, start - context_samples_16k)
        ctx_end = min(total_audio_len_16k, end + context_samples_16k)
        segments.append({
            "index": len(segments),
            "start_16k": start,
            "end_16k": end,
            "ctx_start_16k": ctx_start,
            "ctx_end_16k": ctx_end,
            "out_file": os.path.join(chunks_dir, f"chunk_{len(segments):04d}.wav")
        })
        start = end

    speech_split = False
    if synthesis_mode == 'continuous':
        segments = plan_speech_segments(audio16k)
        speech_split = len(segments) > 1
        for idx, seg in enumerate(segments):
            seg.update(index=idx, out_file=os.path.join(chunks_dir, f'chunk_{idx:04d}.wav'))
        
    num_segments = len(segments)
    
    # Load manifest for resumption
    manifest = {
        "input": os.path.abspath(input_path),
        "total_segments": num_segments,
        "completed": [],
        "state": "running"
    }
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as f:
                old_m = json.load(f)
                # Continuous segments have a new boundary plan and must never
                # reuse legacy cache entries for the same input filename.
                if synthesis_mode != 'continuous' and old_m.get("input") == os.path.abspath(input_path) and old_m.get("total_segments") == num_segments:
                    manifest["completed"] = old_m.get("completed", [])
        except Exception:
            pass

    # Initialize ONNX sessions
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = num_threads
    
    if "CUDAExecutionProvider" in execution_providers and sys.platform == "win32":
        try:
            torch_lib = os.path.abspath(r"D:\CodePackage\DSHA\projects\rvc\.venv310\Lib\site-packages\torch\lib")
            if os.path.isdir(torch_lib):
                if hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(torch_lib)
                if torch_lib not in os.environ.get("PATH", ""):
                    os.environ["PATH"] = torch_lib + os.pathsep + os.environ.get("PATH", "")
        except Exception:
            pass

    if progress_callback:
        progress_callback(5.0, "Loading ONNX inference runtime")
    hubert_sess = ort.InferenceSession(hubert_path, opts, providers=execution_providers)
    rmvpe_sess = ort.InferenceSession(rmvpe_path, opts, providers=execution_providers)
    voice_sess = ort.InferenceSession(voice_path, opts, providers=execution_providers)
    actual_provider = voice_sess.get_providers()[0] if hasattr(voice_sess, 'get_providers') else 'CPUExecutionProvider'

    index_table = None
    if index_path and index_ratio > 0.0:
        t0_idx = time.time()
        index_table = load_mobile_index(index_path, normalize=index_method == 'cosine1')
        print(f"[index] 载入耗时 {time.time() - t0_idx:.1f}s", flush=True)

    # Process each segment
    for seg in segments:
        idx = seg["index"]
        out_f = seg["out_file"]
        
        # Check if already completed and valid
        if idx in manifest["completed"] and os.path.exists(out_f) and os.path.getsize(out_f) > 1000:
            if progress_callback:
                pct = 5.0 + 90.0 * (idx + 1) / num_segments
                progress_callback(pct, f"Chunk {idx+1}/{num_segments} already cached, skipping")
            continue
            
        seg_audio16k = audio16k[seg["ctx_start_16k"] : seg["ctx_end_16k"]]
        if speech_split and seg['ctx_end_16k'] == total_audio_len_16k:
            # Hubert's receptive field otherwise loses the last few frames.
            # Padding is context only; exact center cropping removes it later.
            seg_audio16k = np.pad(seg_audio16k, (0, 640))
        
        valid_seg_wav = None
        if pc_offload:
            try:
                script_dir = os.path.dirname(os.path.abspath(__file__))
                if script_dir not in sys.path:
                    sys.path.insert(0, script_dir)
                from pc_offload import convert_via_pc, wav_bytes_to_audio
                prof_json = os.path.join(models_dir, "voice-profile.json")
                if os.path.exists(prof_json):
                    pc_wav = convert_via_pc(
                        seg_audio16k,
                        voice_profile_path=prof_json,
                        gateway_url=pc_url,
                        pitch=int(pitch_change)
                    )
                    if pc_wav is not None:
                        arr, sr = wav_bytes_to_audio(pc_wav)
                        if sr == 40000:
                            hop_size_40k = 400
                            hop_size_16k = 160
                            ctx_leading_frames = (seg["start_16k"] - seg["ctx_start_16k"]) // hop_size_16k
                            center_frames = (seg["end_16k"] - seg["start_16k"]) // hop_size_16k
                            v_start = ctx_leading_frames * hop_size_40k
                            v_end = v_start + center_frames * hop_size_40k
                            valid_seg_wav = arr[v_start : min(len(arr), v_end)]
                            if speech_split:
                                valid_seg_wav = crop_speech_segment(arr, seg, total_audio_len_16k)
            except Exception as e:
                print(f"[pc_offload] Chunk {idx} offload error: {e}, falling back to local ONNX", flush=True)

        if valid_seg_wav is None:
            # Step A: Hubert features
            phone = extract_hubert_features(hubert_sess, seg_audio16k)
            phone_orig = phone.copy()
            if index_table is not None and index_ratio > 0.0:
                phone = apply_index(phone, index_table, index_ratio, batch_size=128 if index_method == 'l2-8' else 500, method=index_method)
            
            # Step B: RMVPE pitch
            target_frames = phone.shape[0]
            pitchf, pitch = extract_rmvpe_pitch(rmvpe_sess, seg_audio16k, target_frames, pitch_change, intonation_scale)
            
            # Consonant protection: blend unvoiced frames with original Hubert features
            if protect < 0.5 and index_table is not None and index_ratio > 0.0:
                pitchff = np.where(pitchf[:len(phone)] > 0, 1.0, protect).reshape(-1, 1).astype(np.float32)
                phone = phone * pitchff + phone_orig * (1.0 - pitchff)
            
            # Step C: Synthesize voice at 40kHz (OLA)
            seg_wav = synthesize_segment(voice_sess, phone, pitch, pitchf, mode=synthesis_mode, noise_scale=noise_scale)
            
            # Slice out the valid center region (without context padding)
            hop_size_40k = 400
            hop_size_16k = 160
            ctx_leading_frames = (seg["start_16k"] - seg["ctx_start_16k"]) // hop_size_16k
            center_frames = (seg["end_16k"] - seg["start_16k"]) // hop_size_16k
            
            v_start = ctx_leading_frames * hop_size_40k
            v_end = v_start + center_frames * hop_size_40k
            valid_seg_wav = seg_wav[v_start : min(len(seg_wav), v_end)]
            if speech_split:
                valid_seg_wav = crop_speech_segment(seg_wav, seg, total_audio_len_16k)
        
        # Save chunk immediately to disk
        save_wav(out_f, valid_seg_wav, 40000)
        
        manifest["completed"].append(idx)
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
            
        if progress_callback:
            pct = 5.0 + 90.0 * len(manifest["completed"]) / num_segments
            progress_callback(pct, f"Processed chunk {idx+1}/{num_segments}")

    # Stitch all chunks together
    if progress_callback:
        progress_callback(96.0, "Stitching output audio")
        
    full_audio = []
    for seg in segments:
        chunk_wav, sr = sf.read(seg["out_file"]) if sf else (None, 40000)
        if sf is None:
            _, chunk_wav = wavfile.read(seg["out_file"])
            chunk_wav = chunk_wav.astype(np.float32) / 32767.0
        full_audio.append(chunk_wav)
        
    final_output = np.concatenate(full_audio)
    
    # Optional brightness compensation (High-shelf filter)
    if brightness > 0.0:
        final_output = apply_brightness(final_output, sr=40000, gain_db=brightness)
        
    # Peak normalization
    peak = np.max(np.abs(final_output))
    if peak > 0.95:
        final_output = final_output * (0.95 / peak)
        
    save_wav(output_path, final_output, 40000)
    
    # Mark manifest completed
    manifest["state"] = "completed"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        
    elapsed_ms = int((time.time() - start_time) * 1000)
    
    if clean_chunks:
        import shutil
        shutil.rmtree(chunks_dir, ignore_errors=True)
        
    return {
        "ok": True,
        "output": os.path.abspath(output_path),
        "duration_seconds": round(duration_s, 2),
        "elapsedMs": elapsed_ms,
        "rtf": round((elapsed_ms / 1000.0) / max(0.1, duration_s), 3),
        "chunks": num_segments,
        "executionProvider": actual_provider,
        "segmentation": {'strategy': 'pause-aware-v1' if synthesis_mode == 'continuous' else 'legacy-fixed',
                         'split': speech_split, 'segments': [
                             {key: seg[key] for key in ('start_16k', 'end_16k', 'ctx_start_16k', 'ctx_end_16k', 'boundary')}
                             for seg in segments] if synthesis_mode == 'continuous' else []},
    }

def main():
    parser = argparse.ArgumentParser(description="Pure ONNX RVC v2 Command Line Converter")
    parser.add_argument("input", help="Path to input audio (wav/m4a/mp3)")
    parser.add_argument("--models_dir", default="models", help="Directory containing hubert.onnx, rmvpe.onnx, model.onnx")
    parser.add_argument("--output", default="output.wav", help="Path to output wav")
    parser.add_argument("--work_dir", default=None, help="Working directory for chunk caching")
    parser.add_argument("--pitch", type=float, default=0.0, help="Semitone pitch shift (e.g. +12 or -12)")
    parser.add_argument("--segment_seconds", type=float, default=15.0, help="Segment duration in seconds (default 15s)")
    parser.add_argument("--threads", type=int, default=4, help="Intra-op CPU threads")
    parser.add_argument("--index-path", default="", help="Path to mobile index (URVCIDX1)")
    parser.add_argument("--index-ratio", type=float, default=0.0, help="0~1, how much to blend retrieved features (default 0.0=disabled)")
    parser.add_argument("--index-method", choices=['cosine1', 'l2-8'], default='cosine1')
    parser.add_argument("--synthesis-mode", choices=['chunked', 'continuous'], default='chunked')
    parser.add_argument("--noise-scale", type=float, default=1.0)
    parser.add_argument("--intonation-scale", type=float, default=1.0)
    parser.add_argument("--protect", type=float, default=0.33, help="Protect unvoiced consonants (0~0.5, default 0.33)")
    parser.add_argument("--brightness", type=float, default=0.0, help="High-frequency boost in dB (default 0.0=disabled, recommended 2.0~3.0)")
    parser.add_argument("--clean", action="store_true", help="Clean up intermediate chunks after completion")
    parser.add_argument("--json", action="store_true", help="Print only JSON result at end")
    parser.add_argument("--pc_offload", action="store_true", help="Offload chunk inference to PC FullAwake Gateway")
    parser.add_argument("--pc_url", default="http://127.0.0.1:28765", help="PC FullAwake Gateway URL")
    parser.add_argument("--provider", choices=["CPUExecutionProvider", "CUDAExecutionProvider"], default=None, help="ONNX execution provider")
    args = parser.parse_args()

    def on_progress(percent, msg):
        if not args.json:
            print(f"[{percent:5.1f}%] {msg}", flush=True)

    try:
        res = convert_audio(
            input_path=args.input,
            models_dir=args.models_dir,
            output_path=args.output,
            work_dir=args.work_dir,
            pitch_change=args.pitch,
            segment_duration=args.segment_seconds,
            num_threads=args.threads,
            clean_chunks=args.clean,
            index_path=args.index_path,
            index_ratio=args.index_ratio,
            protect=args.protect,
            brightness=args.brightness,
            progress_callback=on_progress,
            index_method=args.index_method,
            synthesis_mode=args.synthesis_mode,
            noise_scale=args.noise_scale,
            intonation_scale=args.intonation_scale,
            pc_offload=args.pc_offload,
            pc_url=args.pc_url,
            execution_providers=[args.provider, "CPUExecutionProvider"] if args.provider else None,
        )
        if args.json:
            print(json.dumps(res))
        else:
            print(f"\nInference completed successfully!")
            print(f"Output: {res['output']}")
            print(f"Total time: {res['elapsedMs']/1000.0:.2f}s (RTF: {res['rtf']}x)")
            print(json.dumps(res))
    except Exception as e:
        err = {"ok": False, "error": str(e)}
        if args.json:
            print(json.dumps(err))
        else:
            print(f"\nError: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
