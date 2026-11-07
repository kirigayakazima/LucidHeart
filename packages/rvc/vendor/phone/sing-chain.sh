#!/bin/bash
# 一键唱歌全流程：PC GPU 端到端极速管线（全曲分离+变声+混音，约40-60秒）与优雅分步回退
# 用法: sing-chain.sh <音频路径> <歌名> [pitch=0] [模型目录]
# 默认音色：feiyu-rvc-v1（2026-11-01 用户指定默认少女音）
set -u
IN="${1:?缺少音频输入}"
NAME="${2:?缺少歌名}"
PITCH="${3:-0}"
MODELS="${4:-/sdcard/rvc/models/feiyu-rvc-v1}"

OUTDIR="${RVC_OUTPUT_DIR:-/sdcard/rvc/out/sing_${NAME}}"
LOG="/root/.dsh/voice/sing/${NAME}.log"
OUTLOG="$OUTDIR/sing.log"
mkdir -p "$OUTDIR" "$(dirname "$LOG")" 2>/dev/null || true

# 双写日志：Proot 内部路径 + /sdcard 产物目录（便于随时排查与外显）
exec >> "$OUTLOG" 2>&1
echo "=== $(TZ=UTC-8 date '+%F %T') 开始处理 $NAME (pitch=$PITCH)"

# 自动推断 Python 解释器（兼容 Build190 原生 python3 与旧虚拟环境）
PY=python3
if [ -x "/root/.dsh/bili-duty/.venv/bin/python" ]; then
  PY="/root/.dsh/bili-duty/.venv/bin/python"
fi
export PYTHONPATH="/root/.dsh/voice/lib:/root/.dsh/voice/onnx-lib:${PYTHONPATH:-}"

# The plugin supplies a profile for fallback. Require its exact model assets
# before the legacy ONNX CLI can select a model by filename.
BUNDLED="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${RVC_VOICE_PROFILE:-}" ]; then
  PYTHONPATH="$BUNDLED/../../scripts:$PYTHONPATH" "$PY" - "$RVC_VOICE_PROFILE" "$MODELS" "$PITCH" <<'PY' || exit 1
import json
import sys
from pathlib import Path
from voice_profile_speak import verify_assets

filename, models = (Path(value).resolve(strict=True) for value in sys.argv[1:3])
profile = json.loads(filename.read_text(encoding='utf-8-sig'))
required = {'model.onnx', 'hubert.onnx', 'rmvpe.onnx', 'voice.mobile.index'}
if (profile.get('id') != 'feiyu-rvc-v1' or profile.get('engine') != 'rvc-onnx'
        or profile.get('index') != 'voice.mobile.index' or sys.argv[3] not in ('0', '-4')
        or (filename.parent / profile['modelsDir']).resolve() != models
        or not required.issubset(profile['assets'])):
    raise ValueError('Invalid Feiyu singing fallback contract')
verify_assets(profile, models)
PY
fi

AUTH_TOKEN="xiaoman-pc-bridge-secret-2026"

# 0) 优先尝试 PC 端全曲 GPU 极速管线 (分离 + 变声 + 混音，整首约 40~60 秒)
PC_STATUS=""
if [ "${RVC_LOCAL_ONLY:-0}" != 1 ]; then
  PC_STATUS=$(curl -s -m 3 -H "Authorization: Bearer $AUTH_TOKEN" http://127.0.0.1:28765/status 2>/dev/null || true)
fi
if echo "$PC_STATUS" | grep -q '"online":true'; then
  echo "--- 检测到 PC FullAwake 在线，启动全链路 PC GPU 极速唱歌管线 (分离+变声+混音)..."
  EXT="${IN##*.}"
  SING_RESP=$(curl -s -X POST -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$IN" \
    "http://127.0.0.1:28765/v1/voice/sing?task=${NAME}&format=${EXT}&pitch=${PITCH}" 2>/dev/null || true)
  if echo "$SING_RESP" | grep -q '"ok":true'; then
    echo "--- PC 端全链路生成完成 ($SING_RESP)，正在拉取成曲 MP3..."
    curl -s -H "Authorization: Bearer $AUTH_TOKEN" \
      "http://127.0.0.1:28765/v1/voice/sing/download/${NAME}" \
      -o "$OUTDIR/song_${NAME}.mp3"
    if [ -s "$OUTDIR/song_${NAME}.mp3" ]; then
      cp -f "$OUTLOG" "$LOG" 2>/dev/null || true
      echo "=== $(TZ=UTC-8 date '+%F %T') 完成 $NAME → $OUTDIR/song_${NAME}.mp3"
      exit 0
    fi
  fi
  echo "--- PC 全链路生成未就绪，回退到分步执行..."
fi

# 1) 分离/伴奏
if [ ! -f "$OUTDIR/vocals.wav" ] || [ ! -f "$OUTDIR/accompaniment.wav" ]; then
  echo "--- 1/3 人声/伴奏分离"
  SEPARATED_VIA_PC=0
  if echo "$PC_STATUS" | grep -q '"online":true'; then
    echo "--- 检测到 PC FullAwake 在线，尝试 PC 端 Demucs GPU 极速分离..."
    EXT="${IN##*.}"
    SEP_RESP=$(curl -s -X POST -H "Authorization: Bearer $AUTH_TOKEN" \
      -H "Content-Type: application/octet-stream" \
      --data-binary @"$IN" \
      "http://127.0.0.1:28765/v1/voice/separate?task=${NAME}&format=${EXT}" 2>/dev/null || true)
    if echo "$SEP_RESP" | grep -q '"ok":true'; then
      echo "--- PC 分离已完成，正在回传音频..."
      curl -s -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:28765/v1/voice/download/${NAME}/vocals" -o "$OUTDIR/vocals.wav"
      curl -s -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:28765/v1/voice/download/${NAME}/accompaniment" -o "$OUTDIR/accompaniment.wav"
      if [ -s "$OUTDIR/vocals.wav" ] && [ -s "$OUTDIR/accompaniment.wav" ]; then
        echo "--- PC 端极速分离回传成功！"
        SEPARATED_VIA_PC=1
      fi
    fi
  fi

  if [ "$SEPARATED_VIA_PC" -ne 1 ]; then
    SEP_SCRIPT=""
    for cand in /sdcard/rvc/separate.py /root/.dsh/voice/separate.py; do
      if [ -f "$cand" ]; then SEP_SCRIPT="$cand"; break; fi
    done
    if [ -n "$SEP_SCRIPT" ]; then
      echo "--- 使用手机本地分离: $SEP_SCRIPT"
      $PY "$SEP_SCRIPT" "$IN" "$OUTDIR" --threads 4 || { echo "本地分离失败"; exit 1; }
    else
      echo "错误: 未找到人声/伴奏，且 PC 分离与本地分离环境均不可用"
      exit 1
    fi
  fi
else
  echo "--- 1/3 分离跳过（已有 vocals.wav 和 accompaniment.wav）"
fi

# 2) RVC 变声（优先 PC FullAwake 逐块分流，失败自动回退本地 ONNX）
echo "--- 2/3 RVC 变声"
cd /sdcard/rvc || exit 1
RVC_PC_SCRIPT=""
for cand in /sdcard/rvc/pc_offload.py /root/.dsh/voice/pc_offload.py; do
  if [ -f "$cand" ]; then RVC_PC_SCRIPT="$cand"; break; fi
done

if [ "${RVC_LOCAL_ONLY:-0}" != 1 ] && [ -n "$RVC_PC_SCRIPT" ] && PYTHONPATH=/root/.dsh/voice/onnx-lib $PY -u "$RVC_PC_SCRIPT" "$OUTDIR/vocals.wav" "$OUTDIR/voc_new.wav" \
  --models_dir "$MODELS" \
  --pitch "$PITCH" \
  --segment_seconds 15 \
  --overlap_seconds 0.5 \
  --gateway_url "http://127.0.0.1:28765"; then
  echo "--- PC Offload 变声转换完成"
else
  echo "--- PC Offload 未完全接通，启动本地 rvc_onnx.py 后备..."
  RVC_LOCAL=""
  for cand in /sdcard/rvc/rvc_onnx.py /root/.dsh/voice/rvc_onnx.py; do
    if [ -f "$cand" ]; then RVC_LOCAL="$cand"; break; fi
  done
  INDEX_ARGS=()
  if [ -n "${RVC_VOICE_PROFILE:-}" ]; then
    RVC_LOCAL="$BUNDLED/rvc_onnx.py"
    INDEX_ARGS=(--index-path "$MODELS/voice.mobile.index" --index-ratio 0.3)
  fi
  if [ -n "$RVC_LOCAL" ]; then
    if ! PYTHONPATH=/root/.dsh/voice/onnx-lib $PY -u "$RVC_LOCAL" "$OUTDIR/vocals.wav" \
      --models_dir "$MODELS" \
      --output "$OUTDIR/voc_new.wav" \
      --work_dir "$OUTDIR/.work_rvc" \
      --segment_seconds 15 --threads 4 --pitch "$PITCH" "${INDEX_ARGS[@]}"; then
      echo "RVC 转换失败"; exit 1
    fi
  else
    echo "错误: 未找到 rvc_onnx.py 且 PC 转换失败"
    exit 1
  fi
fi

# 3) 混音出伴奏（人声限幅 + 40k/44.1k重采样保持在手机）
echo "--- 3/3 混音"
MIX_SCRIPT=""
for cand in /sdcard/rvc/mix.py /root/.dsh/voice/mix.py; do
  if [ -f "$cand" ]; then MIX_SCRIPT="$cand"; break; fi
done

if [ -n "$MIX_SCRIPT" ]; then
  MIX_OUTPUT="$OUTDIR/song_${NAME}.mp3"
  if [ -n "${RVC_VOICE_PROFILE:-}" ]; then MIX_OUTPUT="$OUTDIR/mix.mp3"; fi
  $PY "$MIX_SCRIPT" "$OUTDIR/voc_new.wav" "$OUTDIR/accompaniment.wav" \
    "$MIX_OUTPUT" || { echo "混音失败"; exit 1; }
  if [ -n "${RVC_VOICE_PROFILE:-}" ]; then mv -- "$MIX_OUTPUT" "$OUTDIR/song_${NAME}.mp3" || exit 1; fi
else
  echo "错误: 未找到 mix.py 混音脚本"
  exit 1
fi

cp -f "$OUTLOG" "$LOG" 2>/dev/null || true
echo "=== $(TZ=UTC-8 date '+%F %T') 完成 $NAME → $OUTDIR/song_${NAME}.mp3"
