"""Production song mastering for desktop and QQ delivery."""

import argparse
import json
from pathlib import Path

from fullawake.capabilities.audio_mastering import MP3_RATE, master_audio as master_stems


def tanh_limiter(ceiling_dbtp):
    threshold = 10 ** (ceiling_dbtp / 20)
    channels = '|'.join(f'{threshold:.9f}*tanh(val({channel})/{threshold:.9f})' for channel in (0, 1))
    return f"aresample={4 * MP3_RATE},aeval='{channels}':c=stereo,aresample={MP3_RATE}"


def master_audio(vocals, accompaniment, mp3, *, output_wav_path=None):
    return master_stems(vocals, accompaniment, mp3, output_wav_path=output_wav_path,
                        limiter=tanh_limiter, bitrate='128k', stereo_wav=True, max_lra=8)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('vocals', 'accompaniment', 'mp3'):
        parser.add_argument(name, type=Path)
    parser.add_argument('--wav', type=Path)
    args = parser.parse_args()
    levels = master_audio(args.vocals, args.accompaniment, args.mp3, output_wav_path=args.wav)
    print(json.dumps({'integratedLufs': levels.integrated_lufs, 'truePeakDbtp': levels.true_peak_dbtp,
                      'loudnessRangeLu': levels.loudness_range_lu}))


if __name__ == '__main__':
    main()
