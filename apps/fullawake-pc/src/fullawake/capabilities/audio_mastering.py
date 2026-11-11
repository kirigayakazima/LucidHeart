"""Local song mastering with EBU R128 measurement of the delivered MP3."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory


TARGET_LUFS = -14.0
# Reserve margin for differences in block boundaries and true-peak interpolation
# between compliant meters.
PUBLISH_LOUDNESS_TOLERANCE = 0.75
TRUE_PEAK_CEILING = -0.8
PUBLISH_TRUE_PEAK = TRUE_PEAK_CEILING - 0.1
MP3_RATE = 44_100
VOICE_RATE = 24_000
METER_JSON = re.compile(r'\{\s*"input_i".*?\}', re.DOTALL)


@dataclass(frozen=True)
class MasteringLevels:
    integrated_lufs: float | None
    true_peak_dbtp: float | None


def _ffmpeg(executable, *args, meter=False):
    result = subprocess.run(
        [executable, "-nostdin", "-hide_banner", "-nostats", "-y",
         "-loglevel", "info" if meter else "error", *map(str, args)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, encoding="utf-8", errors="replace",
    )
    if result.returncode:
        raise ValueError(f"FFmpeg mastering failed: {result.stderr.strip()[-1200:]}")
    return result.stderr


def _measure(executable, path):
    report = _ffmpeg(
        executable, "-i", path, "-map", "0:a:0",
        "-af", f"loudnorm=I={TARGET_LUFS}:TP={TRUE_PEAK_CEILING}:print_format=json",
        "-f", "null", os.devnull, meter=True,
    )
    match = METER_JSON.search(report)
    if match is None:
        raise ValueError("FFmpeg did not report EBU R128 measurements")
    values = json.loads(match.group())
    loudness, peak = (float(values[key]) for key in ("input_i", "input_tp"))
    if any(not math.isfinite(value) and value != -math.inf for value in (loudness, peak)):
        raise ValueError("Invalid EBU R128 measurements")
    return MasteringLevels(None if loudness == -math.inf else loudness, None if peak == -math.inf else peak)


def _lookahead_soft_clipper(ceiling_dbtp):
    # Run at 4x the MP3 sample rate to catch inter-sample peaks. A linked lookahead
    # limiter handles transients, then a unity-slope soft knee rounds the crest.
    limit = 10 ** (ceiling_dbtp / 20)
    knee, width = 0.88 * limit, 0.20 * limit
    def channel(index):
        value = f"val({index})"
        magnitude = f"abs({value})"
        return (f"if(lte({magnitude},{knee:.9f}),{value},"
                f"sgn({value})*({knee:.9f}+{width:.9f}*tanh(({magnitude}-{knee:.9f})/{width:.9f})))")

    return (f"aresample={4 * MP3_RATE},alimiter=limit={limit:.9f}:attack=5:release=60:level=0:latency=1,"
            f"aeval='{channel(0)}|{channel(1)}':c=stereo,aresample={MP3_RATE}")


def _render(executable, source, mp3, gain_db, ceiling_dbtp, wav):
    filters = f"[0:a]volume={gain_db:.6f}dB:precision=double,{_lookahead_soft_clipper(ceiling_dbtp)}"
    if wav is None:
        filters += "[mp3]"
    else:
        filters += (f",asplit[mp3][voice];[voice]pan=mono|c0=0.5*c0+0.5*c1,"
                    f"aresample={VOICE_RATE}[wav]")
    args = ["-i", source, "-filter_complex", filters, "-map", "[mp3]", "-c:a", "libmp3lame",
            "-b:a", "192k", "-id3v2_version", "3", mp3]
    if wav is not None:
        args += ["-map", "[wav]", "-c:a", "pcm_s16le", wav]
    _ffmpeg(executable, *args)


def master_audio(vocal_path, inst_path, output_mp3_path, vocal_gain=1.0, inst_gain=1.0, *, output_wav_path=None):
    """Mix local stems and publish a verified MP3, optionally with a 24 kHz PCM sidecar.

    The absolute R128 gate leaves silence and sub-gate input at their original
    level. A measurable track must meet both delivery limits before publication.
    """
    if any(not math.isfinite(gain) or gain < 0 for gain in (vocal_gain, inst_gain)):
        raise ValueError("Stem gains must be finite and nonnegative")
    executable = shutil.which("ffmpeg")
    if executable is None:
        raise ValueError("FFmpeg is required for song mastering")
    output = Path(output_mp3_path)
    wav_output = Path(output_wav_path) if output_wav_path is not None else None
    if wav_output is not None and (wav_output.parent.resolve() != output.parent.resolve()
                                   or wav_output.suffix.lower() != ".wav"):
        raise ValueError("PCM sidecar must be a WAV in the MP3 output directory")
    output.parent.mkdir(parents=True, exist_ok=True)

    with TemporaryDirectory(prefix="mastering-", dir=output.parent) as directory:
        scratch = Path(directory)
        mix = scratch / "mix.wav"
        mp3 = scratch / "mix.mp3"
        wav = scratch / "output.wav" if wav_output is not None else None
        stem_format = f"aresample={MP3_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo"
        mix_filters = (
            f"[0:a:0]{stem_format},volume={vocal_gain:.12g}[vocal];"
            f"[1:a:0]{stem_format},volume={inst_gain:.12g}[inst];"
            "[vocal][inst]amix=inputs=2:duration=longest:normalize=0[mix]"
        )
        _ffmpeg(executable, "-i", vocal_path, "-i", inst_path, "-filter_complex", mix_filters,
                "-map", "[mix]", "-c:a", "pcm_f32le", "-rf64", "auto", mix)
        source = _measure(executable, mix)
        normalize = source.integrated_lufs is not None
        gain_db = TARGET_LUFS - source.integrated_lufs if normalize else 0.0
        # A lossy encoder can create peaks beyond its PCM input. Leave headroom,
        # then meter the decoded deliverable and re-render if necessary.
        ceiling_dbtp = TRUE_PEAK_CEILING - 0.4
        for _ in range(8):
            _render(executable, mix, mp3, gain_db, ceiling_dbtp, wav)
            levels = _measure(executable, mp3)
            peak = levels.true_peak_dbtp if levels.true_peak_dbtp is not None else -math.inf
            peak_ok = peak <= PUBLISH_TRUE_PEAK
            if normalize and levels.integrated_lufs is None:
                raise ValueError("Mastered audio fell below the EBU R128 gate")
            correction = TARGET_LUFS - levels.integrated_lufs if normalize else 0.0
            if peak_ok and abs(correction) <= PUBLISH_LOUDNESS_TOLERANCE:
                if wav is not None:
                    wav_peak = _measure(executable, wav).true_peak_dbtp
                    if wav_peak is not None and wav_peak > PUBLISH_TRUE_PEAK:
                        ceiling_dbtp -= wav_peak - TRUE_PEAK_CEILING + 0.2
                        continue
                    wav.replace(wav_output)
                mp3.replace(output)
                return levels
            if not peak_ok:
                ceiling_dbtp -= peak - TRUE_PEAK_CEILING + 0.2
            gain_db += max(-12.0, min(12.0, correction))
            if ceiling_dbtp < -12:
                break
        raise ValueError("Could not meet song loudness and true-peak targets")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vocal_path", type=Path)
    parser.add_argument("inst_path", type=Path)
    parser.add_argument("output_mp3_path", type=Path)
    parser.add_argument("--wav", type=Path)
    args = parser.parse_args()
    try:
        levels = master_audio(args.vocal_path, args.inst_path, args.output_mp3_path, output_wav_path=args.wav)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    print(json.dumps({"integratedLufs": levels.integrated_lufs, "truePeakDbtp": levels.true_peak_dbtp}))


if __name__ == "__main__":
    main()
