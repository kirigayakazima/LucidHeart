"""Full-song Demucs, CUDA RVC and mastering pipeline."""
import asyncio
import json
import os
from pathlib import Path
import sys
import time

from fullawake.core.config import config
from fullawake.capabilities.voice_sing_provider import run_sing_stage, run_song_mastering


async def render_song(artifacts, communicate, clean_task, audio_bytes, audio_format, pitch, root, destination, logger,
                      *, progress=None, resident=None):
    python = Path(config.voice_python or sys.executable)
    vendor = Path(__file__).resolve().parents[5] / 'packages' / 'rvc' / 'vendor' / 'phone'
    rvc_script = vendor / 'rvc_onnx.py'
    if not all(file.is_file() for file in (python, rvc_script)):
        raise ValueError('VOICE_RUNTIME_UNAVAILABLE')
    profile_path = Path(config.voice_profile).resolve(strict=True)
    if not profile_path.is_file():
        raise ValueError('VOICE_PROFILE_UNAVAILABLE')

    clean_fmt = audio_format.lower() if audio_format.lower() in ('m4a', 'mp3', 'wav', 'flac') else 'm4a'
    in_file = root / f"input.{clean_fmt}"
    write = asyncio.create_task(asyncio.to_thread(in_file.write_bytes, audio_bytes))
    try:
        await asyncio.shield(write)
    except asyncio.CancelledError:
        await asyncio.gather(write, return_exceptions=True)
        raise

    worker_env = dict(os.environ)

    async def run(command):
        if resident is not None:
            return await run_sing_stage(command, worker_env)
        process = await asyncio.create_subprocess_exec(
            *command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=worker_env,
        )
        stdout, stderr = await communicate(process, timeout=300)
        return process.returncode, stdout, stderr

    started = time.monotonic()
    vocals_wav = root / "vocals.wav"
    bgm_wav = root / "no_vocals.wav"
    if progress:
        progress("separation")

    # Stage 1: Demucs Separation on GPU
    if not vocals_wav.is_file() or not bgm_wav.is_file():
        logger.info("[Singing] Stage 1: Running Demucs GPU separation for %s...", clean_task)
        out_demucs_dir = root / "demucs_out"
        out_demucs_dir.mkdir(parents=True, exist_ok=True)
        cmd_sep = [
            str(python), "-m", "demucs.separate",
            "-n", "htdemucs",
            "--device", "cuda",
            "--two-stems", "vocals",
            "-o", str(out_demucs_dir),
            str(in_file),
        ]
        code, _, stderr_sep = await run(cmd_sep)
        if code != 0:
            logger.error("Singing Demucs failed: %s", stderr_sep.decode('utf8', 'replace')[-500:])
            raise ValueError('VOICE_SEPARATION_FAILED')
        found_voc = list(out_demucs_dir.rglob("vocals.wav"))
        found_bgm = list(out_demucs_dir.rglob("no_vocals.wav"))
        if not found_voc or not found_bgm:
            raise ValueError('VOICE_SEPARATION_OUTPUT_MISSING')
        found_voc[0].replace(vocals_wav)
        found_bgm[0].replace(bgm_wav)

    t_sep = time.monotonic() - started
    logger.info("[Singing] Stage 1 completed in %.2fs", t_sep)

    # Stage 2: RVC Full-Song GPU Conversion
    if progress:
        progress("rvc")
    logger.info("[Singing] Stage 2: Running RVC GPU conversion for %s (pitch=%d)...", clean_task, pitch)
    t_rvc_start = time.monotonic()
    voc_new_wav = root / "voc_new.wav"
    models_dir = str(profile_path.parent)
    index_path = str(profile_path.parent / "voice.mobile.index")

    if resident is not None:
        provider = await resident.convert(vocals_wav, voc_new_wav, root / ".rvc_work", pitch,
                                          progress=(lambda slices: progress("rvc", slices)) if progress else None)
    else:
        cmd_rvc = [
            str(python), "-u", str(rvc_script),
            str(vocals_wav),
            "--models_dir", models_dir,
            "--output", str(voc_new_wav),
            "--work_dir", str(root / ".rvc_work"),
            "--pitch", str(pitch),
            "--segment_seconds", "15",
            "--threads", "4",
            "--provider", "CUDAExecutionProvider",
            "--json",
        ]
        if Path(index_path).is_file():
            cmd_rvc.extend(["--index-path", index_path, "--index-ratio", "0.3"])
        code, stdout_rvc, stderr_rvc = await run(cmd_rvc)
        if code != 0:
            logger.error("Singing RVC failed: %s", stderr_rvc.decode('utf8', 'replace')[-500:])
            raise ValueError('VOICE_RVC_CONVERSION_FAILED')
        try:
            provider = json.loads(stdout_rvc.decode('utf8').strip().rsplit('\n', 1)[-1])["executionProvider"]
        except (ValueError, KeyError, TypeError) as error:
            raise ValueError('VOICE_RVC_PROVIDER_UNKNOWN') from error
    if not voc_new_wav.is_file():
        raise ValueError('VOICE_RVC_CONVERSION_FAILED')
    if provider != "CUDAExecutionProvider":
        raise ValueError('VOICE_RVC_CUDA_UNAVAILABLE')

    t_rvc = time.monotonic() - t_rvc_start
    logger.info("[Singing] Stage 2 completed in %.2fs", t_rvc)

    # Preserve the legacy streaming stage name. Async jobs expose mastering at 90%.
    if progress:
        progress("mixing")
    logger.info("[Singing] Stage 3: Mastering %s...", clean_task)
    t_mix_start = time.monotonic()
    final_mp3 = root / 'mix.mp3'
    final_wav = root / 'mix.wav'
    levels = await run_song_mastering(python, voc_new_wav, bgm_wav, final_mp3, final_wav, worker_env)
    final_wav.replace(destination / f'song_{clean_task}.wav')
    published = final_mp3.replace(destination / f'song_{clean_task}.mp3')
    t_mix = time.monotonic() - t_mix_start
    total_elapsed = time.monotonic() - started
    logger.info("[Singing] All stages completed in %.2fs (sep=%.1fs, rvc=%.1fs, mix=%.1fs)", total_elapsed, t_sep, t_rvc, t_mix)

    return {
        "ok": True,
        "task": clean_task,
        "elapsedTotalSeconds": round(total_elapsed, 2),
        "stageSeconds": {
            "separation": round(t_sep, 2),
            "rvc_gpu": round(t_rvc, 2),
            "mixing": round(t_mix, 2),
        },
        "downloadUrl": f"/v1/voice/sing/download/{clean_task}",
        "wavDownloadUrl": f"/v1/voice/sing/download/{clean_task}?format=wav",
        "mastering": levels,
        "artifactId": artifacts.artifact_id(published),
        "mode": "pc_gpu_pipeline",
        "executionProvider": provider,
    }
