#!/usr/bin/env python3
"""把人声和伴奏叠回一首歌，输出 wav + mp3。

用法: python mix.py 人声.wav 伴奏.wav 输出.mp3 [--vocal-gain 1.0] [--inst-gain 0.9]
"""
import argparse
import os

import numpy as np
import soundfile as sf


def load(path):
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    if x.shape[1] == 1:
        x = np.concatenate([x, x], axis=1)
    return x[:, :2], sr


def rms(x):
    return float(np.sqrt(np.mean(x ** 2) + 1e-12))


def resample_to(x, sr, target):
    if sr == target:
        return x
    from fractions import Fraction
    from scipy.signal import resample_poly
    f = Fraction(target, sr)
    return resample_poly(x, f.numerator, f.denominator, axis=0).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("vocal")
    ap.add_argument("inst")
    ap.add_argument("output")
    ap.add_argument("--vocal-gain", type=float, default=1.0)
    ap.add_argument("--inst-gain", type=float, default=0.9)
    ap.add_argument("--vocal-limit", type=float, default=0.75)
    args = ap.parse_args()

    v, sr1 = load(args.vocal)
    a, sr2 = load(args.inst)
    sr = max(sr1, sr2)
    v = resample_to(v, sr1, sr)
    a = resample_to(a, sr2, sr)
    n = min(len(v), len(a))
    v, a = v[:n], a[:n]

    vg = args.vocal_gain
    ag = args.inst_gain
    # 人声按原曲 RMS 补齐：RVC 产物常常偏小
    if rms(v) > 1e-4 and rms(a) > 1e-4:
        v = v / rms(v) * rms(a) * 0.85
    v = v * vg
    # 人声先限幅：峰值高但能量低，整体缩放会把歌压得很小声
    v = np.clip(v, -args.vocal_limit, args.vocal_limit)
    mix = v + a * ag

    # 先压伴奏峰值，再限幅：整首按峰值缩放会把响度压太低
    amax = float(np.max(np.abs(a * ag)))
    if amax > 0.8:
        a = a / amax * 0.8
        mix = v * vg + a * ag
    mix = np.clip(mix, -0.98, 0.98)
    peak = float(np.max(np.abs(mix)))

    out = args.output
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    wav = os.path.splitext(out)[0] + ".wav"
    sf.write(wav, mix, sr, subtype="PCM_16")
    fmt = "MP3" if out.lower().endswith(".mp3") else None
    sf.write(out, mix, sr, format=fmt)
    print(f"混音完成: {wav} / {out}  ({n / sr:.1f}s, peak {peak:.2f})")


if __name__ == "__main__":
    main()
