#!/bin/bash
# 一首歌全流程：分离 → RVC 换音色 → 混音
# 用法: sing-chain.sh <输入音频> <任务名> [pitch=0]
set -u
IN="${1:?输入音频}"
NAME="${2:?任务名}"
PITCH="${3:-0}"

OUTDIR="/sdcard/rvc/out/sing_${NAME}"
LOG="/root/.dsh/voice/sing/${NAME}.log"
mkdir -p "$OUTDIR" "$(dirname "$LOG")"

PY=/root/.dsh/bili-duty/.venv/bin/python
export PYTHONPATH=/root/.dsh/voice/lib:/root/.dsh/voice/onnx-lib

exec >> "$LOG" 2>&1
echo "=== $(TZ=UTC-8 date '+%F %T') 开始 $NAME (pitch=$PITCH)"

# 1) 分离人声/伴奏
if [ ! -f "$OUTDIR/vocals.wav" ] || [ ! -f "$OUTDIR/accompaniment.wav" ]; then
  echo "--- 1/3 分离"
  $PY /root/.dsh/voice/separate.py "$IN" "$OUTDIR" --threads 4 || { echo "分离失败"; exit 1; }
else
  echo "--- 1/3 分离：已有，跳过"
fi

# 2) RVC 换音色（只对人声）
echo "--- 2/3 RVC"
cd /sdcard/rvc || exit 1
if ! PYTHONPATH=/root/.dsh/voice/onnx-lib python3 -u /sdcard/rvc/rvc_onnx.py "$OUTDIR/vocals.wav" \
  --models_dir models/Dv5 \
  --output "$OUTDIR/voc_dv5.wav" \
  --work_dir "$OUTDIR/.work_rvc" \
  --segment_seconds 15 --threads 4 --pitch "$PITCH"; then
  echo "RVC 失败"; exit 1
fi

# 3) 混回伴奏
echo "--- 3/3 混音"
$PY /root/.dsh/voice/mix.py "$OUTDIR/voc_dv5.wav" "$OUTDIR/accompaniment.wav" \
  "$OUTDIR/song_${NAME}.mp3" || { echo "混音失败"; exit 1; }

cp -f "$OUTDIR/song_${NAME}.mp3" /root/.dsh/voice/sing/ 2>/dev/null
echo "=== $(TZ=UTC-8 date '+%F %T') 完成 $NAME → $OUTDIR/song_${NAME}.mp3"
