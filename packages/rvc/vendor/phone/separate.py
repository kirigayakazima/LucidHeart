#!/usr/bin/env python3
"""人声/伴奏分离（sherpa-onnx UVR MDX-Net，纯 onnx，无 torch）

用法:
  PYTHONPATH=/root/.dsh/voice/lib /root/.dsh/bili-duty/.venv/bin/python \
      /root/.dsh/voice/separate.py 输入.mp3 输出目录 [--threads 4] [--model 模型路径]

输出: <输出目录>/vocals.wav  <输出目录>/accompaniment.wav
"""
import argparse
import os
import sys
import time

import numpy as np
import soundfile as sf
import sherpa_onnx

DEFAULT_MODEL = "/root/.dsh/voice/models/uvr/voc_ft.onnx"
SR = 44100


def load_audio(path):
    """读成 (2, n) float32 44.1k。mp3/m4a 走 librosa 兜底。"""
    try:
        data, sr = sf.read(path, dtype="float32", always_2d=True)
    except Exception:
        import librosa
        y, sr = librosa.load(path, sr=SR, mono=False)
        data = y.T if y.ndim > 1 else y.reshape(-1, 1)
    # 声道
    if data.shape[1] == 1:
        data = np.concatenate([data, data], axis=1)
    elif data.shape[1] > 2:
        data = data[:, :2]
    # 重采样到 44.1k
    if sr != SR:
        import librosa
        out = np.stack([librosa.resample(data[:, c], orig_sr=sr, target_sr=SR) for c in range(2)])
        data = out.T
        sr = SR
    return np.ascontiguousarray(data.T, dtype=np.float32)  # (2, n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("outdir")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    args = ap.parse_args()

    if not os.path.isfile(args.model):
        sys.exit(f"模型不存在: {args.model}")
    os.makedirs(args.outdir, exist_ok=True)

    t0 = time.time()
    samples = load_audio(args.input)
    dur = samples.shape[1] / SR
    print(f"输入 {args.input}: {dur:.1f}s, shape={samples.shape}", flush=True)

    cfg = sherpa_onnx.OfflineSourceSeparationConfig(
        model=sherpa_onnx.OfflineSourceSeparationModelConfig(
            uvr=sherpa_onnx.OfflineSourceSeparationUvrModelConfig(model=args.model),
            num_threads=args.threads,
            debug=False,
            provider="cpu",
        )
    )
    if not cfg.validate():
        sys.exit("配置校验失败")
    sp = sherpa_onnx.OfflineSourceSeparation(cfg)
    print(f"模型加载 {time.time() - t0:.1f}s，开始分离", flush=True)

    out = sp.process(SR, samples)
    print(f"分离完成，耗时 {time.time() - t0:.1f}s (RTF {(time.time() - t0) / dur:.2f})", flush=True)

    vpath = os.path.join(args.outdir, "vocals.wav")
    apath = os.path.join(args.outdir, "accompaniment.wav")
    stems = list(out.stems)  # [人声, 伴奏]，元素是 MultiChannelSamples，取 .data 得 (2, n)
    v = np.asarray(stems[0].data, dtype=np.float32)
    a = np.asarray(stems[1].data, dtype=np.float32)
    if v.ndim == 1:
        v = np.stack([v, v])
    if a.ndim == 1:
        a = np.stack([a, a])
    print(f"stems: vocals{v.shape} accompaniment{a.shape}", flush=True)
    sf.write(vpath, v.T, SR, subtype="PCM_16")
    sf.write(apath, a.T, SR, subtype="PCM_16")
    print(f"人声 {vpath}\n伴奏 {apath}", flush=True)


if __name__ == "__main__":
    main()
