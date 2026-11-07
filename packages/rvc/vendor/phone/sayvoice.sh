#!/usr/bin/env bash
# sayvoice.sh: End-to-end Text-to-Voice Command with Concurrency Protection
# Usage: /root/dsh-bin/sayvoice.sh "文本" [--pitch 0|-4] [--brightness 2.5] [--out /path/to/output.wav]
#
# 耗时预期说明：
#   总执行耗时实测约 50 秒（TTS 干声生成 6~7s，手机 4 线程 CPU ONNX 推理约 31s，
#   其余是每次冷启动加载三个 onnx 模型的开销）。
#   执行时会输出步骤阶段进度，请耐心等待，切勿反复中断重试。
#
# 并发保护：
#   中间干声路径与 RVC 工作目录全部绑定独立的 RUN_ID（包含时间戳与进程 PID $$），
#   彻底杜绝多条并发消息互相踩踏 manifest.json 或覆盖干声文件的问题。

set -eo pipefail

RUN_ID="$(date +%Y%m%d_%H%M%S 2>/dev/null || date +%s)_$$"

TEXT=""
PITCH="0"           # 默认音高（候选：0 为元气少女感 255.7Hz；-4 为沉稳日常 210.1Hz）
BRIGHTNESS="2.5"     # 默认高频补偿 2.5 dB
RATE=""             # 语速调节（如 +0%, +10%, -5%）
OUT_WAV=""
ENGINE="auto"
MODELS_DIR="${RVC_MODELS_DIR:-/sdcard/rvc/models/feiyu-rvc-v1}"

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pitch)
      PITCH="$2"
      shift 2
      ;;
    --pitch=*)
      PITCH="${1#*=}"
      shift
      ;;
    --brightness)
      BRIGHTNESS="$2"
      shift 2
      ;;
    --brightness=*)
      BRIGHTNESS="${1#*=}"
      shift
      ;;
    --rate)
      RATE="$2"
      shift 2
      ;;
    --rate=*)
      RATE="${1#*=}"
      shift
      ;;
    --models-dir|--models_dir)
      MODELS_DIR="$2"
      shift 2
      ;;
    --models-dir=*|--models_dir=*)
      MODELS_DIR="${1#*=}"
      shift
      ;;
    --out)
      OUT_WAV="$2"
      shift 2
      ;;
    --out=*)
      OUT_WAV="${1#*=}"
      shift
      ;;
    --engine)
      ENGINE="$2"
      shift 2
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

set -- "${POSITIONAL[@]}"
TEXT="${1:-}"

if [ -z "$TEXT" ]; then
  echo "Usage: sayvoice.sh \"文本\" [--pitch 0|-4] [--brightness 2.5] [--out out.wav]" >&2
  exit 1
fi

SAY_BIN="/root/dsh-bin/say.sh"
if [ ! -x "$SAY_BIN" ]; then
  SAY_BIN="/sdcard/rvc/say.sh"
fi

RVC_SCRIPT="/sdcard/rvc/rvc_onnx.py"
MODELS_DIR="${MODELS_DIR:-/sdcard/rvc/models/feiyu-rvc-v1}"
INDEX_PATH="$MODELS_DIR/voice.mobile.index"
if [ ! -f "$INDEX_PATH" ]; then
  INDEX_PATH="$MODELS_DIR/Dv5.mobile.index"
fi
if [ ! -f "$INDEX_PATH" ]; then
  # 尝试查找同目录下的任意 .index
  FALLBACK_IDX=$(ls "$MODELS_DIR"/*.index 2>/dev/null | head -n 1 || true)
  if [ -n "$FALLBACK_IDX" ]; then
    INDEX_PATH="$FALLBACK_IDX"
  fi
fi

# 独立并发工作区与干声路径
TMP_DRY="/root/.dsh/voice/say_dry_${RUN_ID}.mp3"
WORK_DIR="/sdcard/rvc/out/.work_sayvoice_${RUN_ID}"

if [ -z "$OUT_WAV" ]; then
  OUT_WAV="/sdcard/rvc/out/sayvoice_${RUN_ID}.wav"
fi

mkdir -p "$(dirname "$OUT_WAV")" 2>/dev/null || true
mkdir -p "$WORK_DIR" 2>/dev/null || true

# 步骤 1: TTS 生成 (预期约 7s)
echo "[sayvoice] 步骤 1/2: 生成干声 (预期约 7s)..." >&2
RATE_ARGS=()
if [ -n "$RATE" ]; then
  RATE_ARGS=(--rate "$RATE")
fi
TTS_VOICE="zh-CN-XiaoyiNeural"
if [ -f "$MODELS_DIR/voice-profile.json" ]; then
  PROFILE_VOICE=$(grep -o '"ttsVoice"[[:space:]]*:[[:space:]]*"[^"]*"' "$MODELS_DIR/voice-profile.json" | cut -d'"' -f4 || true)
  if [ -n "$PROFILE_VOICE" ]; then
    TTS_VOICE="$PROFILE_VOICE"
  fi
fi
DRY_AUDIO=$(bash "$SAY_BIN" "$TEXT" "$TTS_VOICE" "$TMP_DRY" --engine "$ENGINE" "${RATE_ARGS[@]}")

if [ ! -f "$DRY_AUDIO" ] || [ ! -s "$DRY_AUDIO" ]; then
  echo "Error: Dry audio generation failed" >&2
  exit 1
fi

INDEX_RATIO="0.3"
if [ -f "$MODELS_DIR/voice-profile.json" ]; then
  PROFILE_RATIO=$(grep -o '"indexRatio"[[:space:]]*:[[:space:]]*[0-9.]*' "$MODELS_DIR/voice-profile.json" | tr -d ' "indexRatio:' || true)
  if [ -n "$PROFILE_RATIO" ]; then
    INDEX_RATIO="$PROFILE_RATIO"
  fi
fi

# 步骤 2: RVC ONNX 音色转换 (预期 25~28s)
echo "[sayvoice] 步骤 2/2: RVC 音色转换 (模型: $(basename "$MODELS_DIR"), 语调: $TTS_VOICE, 预期约 25~28s, 独立工作区: ${WORK_DIR})..." >&2

cd /sdcard/rvc
if PYTHONPATH=/root/.dsh/voice/onnx-lib python3 -u "$RVC_SCRIPT" "$DRY_AUDIO" \
  --models_dir "$MODELS_DIR" \
  --output "$OUT_WAV" \
  --work_dir "$WORK_DIR" \
  --index-path "$INDEX_PATH" \
  --index-ratio "$INDEX_RATIO" \
  --protect 0.33 \
  --pitch "$PITCH" \
  --brightness "$BRIGHTNESS" \
  --clean >&2; then
  
  # 成功后清理临时干声与临时工作区
  rm -f "$DRY_AUDIO" 2>/dev/null || true
  find -P "$WORK_DIR" -type f \( -name 'chunk_*.wav' -o -name manifest.json \) -delete 2>/dev/null || true
  find -P "$WORK_DIR" -depth -type d -empty -delete 2>/dev/null || true
  echo "[sayvoice] 转换完成！整条链路约 50 秒。" >&2
  echo "$OUT_WAV"
else
  # 失败保留工作区与干声便于排查
  echo "Error: RVC conversion failed. Intermediate files preserved at $WORK_DIR and $DRY_AUDIO" >&2
  exit 1
fi
