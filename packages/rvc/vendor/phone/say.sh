#!/usr/bin/env bash
# say.sh: Dual-engine robust TTS wrapper (Edge-TTS preferred, MeloTTS fallback)
# Interface: /root/dsh-bin/say.sh "文本" [音色] [输出路径] [--engine edge|melo|auto] [--format auto|wav|mp3]
#
# 格式说明：
#   Edge-TTS 原生输出 .mp3，MeloTTS 原生输出 .wav。
#   在默认 --format auto 模式下，返回值可能是 .mp3 或 .wav，下游调用方（如 rvc_onnx.py）
#   已内置多格式解码能力，请勿硬编码假设单一扩展名。
#   如需强制统一格式，请指定 --format wav 或 --format mp3。
#
# 连通性与超时策略：
#   在 auto 模式下，优先执行 2.5 秒 TCP/HTTP 快速连通性探测。
#   - 探测成功：进入 Edge-TTS 在线合成，超时放宽至 10 秒；
#   - 探测失败/断网：回落本地离线 MeloTTS（手机端冷启动加载模型约 7 秒出声，属正常兜底）。
#   2.5 秒（而非 1 秒）是实测定的：手机正常探活约 0.5 秒，1 秒预算会把抖动误判成离线，
#   静默换成 MeloTTS，听感上就是"声音突然变了"。

set -o pipefail

# Choose python binary (prefer container environment if available)
if [ -x "/root/.dsh/bili-duty/.venv/bin/python" ]; then
  PYTHON_BIN="/root/.dsh/bili-duty/.venv/bin/python"
elif [ -f "/c/Users/xuaner/AppData/Roaming/uv/python/cpython-3.10-windows-x86_64-none/python.exe" ]; then
  PYTHON_BIN="/c/Users/xuaner/AppData/Roaming/uv/python/cpython-3.10-windows-x86_64-none/python.exe"
elif command -v python3 >/dev/null 2>&1 && [ ! -d "/c/Users" ]; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  PYTHON_BIN="python3"
fi

if mkdir -p "/root/.dsh/voice" 2>/dev/null; then
  DEFAULT_DIR="/root/.dsh/voice"
else
  DEFAULT_DIR="${TMPDIR:-/tmp}/dsh_voice"
  mkdir -p "$DEFAULT_DIR" 2>/dev/null || true
fi

LOG_FILE="${DEFAULT_DIR}/say.log"

# Parse flags & positional args
ENGINE="auto"
FORMAT="auto"
RATE=""
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine)
      ENGINE="$2"
      shift 2
      ;;
    --engine=*)
      ENGINE="${1#*=}"
      shift
      ;;
    --format)
      FORMAT="$2"
      shift 2
      ;;
    --format=*)
      FORMAT="${1#*=}"
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
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

set -- "${POSITIONAL[@]}"

TEXT="${1:-}"
VOICE_ARG="${2:-zh-CN-XiaoxiaoNeural}"
OUT_FILE="${3:-}"

if [ -z "$TEXT" ]; then
  echo "Usage: say.sh \"文本\" [音色] [输出路径] [--engine edge|melo|auto] [--format auto|wav|mp3]" >&2
  exit 1
fi

RUN_ID="$(date +%Y%m%d_%H%M%S 2>/dev/null || date +%s)_$$"
T0=$(date +%s%N 2>/dev/null || date +%s)

log_entry() {
  local eng="$1"
  local el="$2"
  local reason="$3"
  local p="$4"
  local now
  now="$(date '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date)"
  echo "$now | engine=$eng | elapsed=${el}s | reason=${reason} | out=$p | text=\"$TEXT\"" >> "$LOG_FILE" 2>/dev/null || true
}

calc_elapsed() {
  local t1
  t1=$(date +%s%N 2>/dev/null || date +%s)
  if [ ${#T0} -gt 10 ] && [ ${#t1} -gt 10 ]; then
    awk -v s="$T0" -v e="$t1" 'BEGIN { printf "%.2f", (e - s) / 1000000000 }'
  else
    awk -v s="$T0" -v e="$t1" 'BEGIN { printf "%.2f", e - s }'
  fi
}

probe_network() {
  # Connection probe to edge-tts endpoint (respects HTTPS_PROXY/http_proxy).
  # Timeout is 2.5s, not 1s: on the phone the probe normally answers in ~0.5s, but a
  # 1s budget misjudged a jittery link as "offline" and silently fell back to MeloTTS,
  # which the listener hears as the voice suddenly changing. 2.5s leaves margin for
  # jitter while still failing fast when the network is genuinely down.
  if command -v curl >/dev/null 2>&1; then
    curl -s -m 2.5 -o /dev/null -I https://speech.platform.bing.com >/dev/null 2>&1
    return $?
  fi
  local py_cmd="
import urllib.request, urllib.error
try:
    urllib.request.urlopen('https://speech.platform.bing.com', timeout=2.5)
    exit(0)
except urllib.error.HTTPError:
    exit(0)  # 收到 HTTP 响应即说明网络可达（根路径返回 404 属正常）
except Exception:
    exit(1)
"
  if [ -d "/root/.dsh/voice/lib" ]; then
    PYTHONPATH=/root/.dsh/voice/lib "$PYTHON_BIN" -c "$py_cmd" >/dev/null 2>&1
  else
    "$PYTHON_BIN" -c "$py_cmd" >/dev/null 2>&1
  fi
  return $?
}

run_edge() {
  local target="$1"
  local tmp_target="${target%.*}.mp3"
  
  # Ensure clean starting state
  [ -f "$tmp_target" ] && rm -f "$tmp_target"
  
  # Run edge_tts with 10.0s timeout (real phone proot edge synthesis took ~6.03s, 6s was dangerously tight)
  local timeout_cmd=""
  if command -v timeout >/dev/null 2>&1; then
    timeout_cmd="timeout 10"
  fi

  local ok=0
  local rate_opt=()
  [ -n "$RATE" ] && rate_opt=(--rate "$RATE")
  if [ -d "/root/.dsh/voice/lib" ]; then
    if PYTHONPATH=/root/.dsh/voice/lib $timeout_cmd "$PYTHON_BIN" -m edge_tts --text "$TEXT" --voice "$VOICE_ARG" "${rate_opt[@]}" --write-media "$tmp_target" >/dev/null 2>&1; then
      ok=1
    fi
  else
    if $timeout_cmd "$PYTHON_BIN" -m edge_tts --text "$TEXT" --voice "$VOICE_ARG" "${rate_opt[@]}" --write-media "$tmp_target" >/dev/null 2>&1; then
      ok=1
    fi
  fi

  if [ $ok -eq 1 ]; then
    if [ -s "$tmp_target" ] && [ "$(wc -c < "$tmp_target" 2>/dev/null || stat -c%s "$tmp_target" 2>/dev/null || echo 0)" -gt 1000 ]; then
      echo "$tmp_target"
      return 0
    fi
  fi
  # Cleanup on failure to prevent 0-byte corrupt files
  [ -f "$tmp_target" ] && rm -f "$tmp_target"
  return 1
}

run_melo() {
  local target="$1"
  local melo_target="${target%.*}.wav"
  
  [ -f "$melo_target" ] && rm -f "$melo_target"
  
  local local_tts_py="/root/.dsh/voice/local_tts.py"
  if [ ! -f "$local_tts_py" ]; then
    local_tts_py="local_tts.py"
  fi
  
  local ok=0
  if [ -d "/root/.dsh/voice/lib" ]; then
    if PYTHONPATH=/root/.dsh/voice/lib "$PYTHON_BIN" "$local_tts_py" "$TEXT" "$melo_target" >/dev/null 2>&1; then
      ok=1
    fi
  else
    if "$PYTHON_BIN" "$local_tts_py" "$TEXT" "$melo_target" >/dev/null 2>&1; then
      ok=1
    fi
  fi

  if [ $ok -eq 1 ]; then
    if [ -s "$melo_target" ]; then
      echo "$melo_target"
      return 0
    fi
  fi
  [ -f "$melo_target" ] && rm -f "$melo_target"
  return 1
}

FINAL_PATH=""
CHOSEN_ENGINE=""
FALLBACK_REASON="none"

# Determine target template path with unique ID if not explicitly specified
if [ -n "$OUT_FILE" ]; then
  BASE_TARGET="$OUT_FILE"
else
  BASE_TARGET="${DEFAULT_DIR}/say_${RUN_ID}.out"
fi

if [ "$ENGINE" = "melo" ]; then
  # Explicit melo override
  if FINAL_PATH=$(run_melo "$BASE_TARGET"); then
    CHOSEN_ENGINE="melo"
  else
    echo "Error: MeloTTS synthesis failed" >&2
    exit 1
  fi
elif [ "$ENGINE" = "edge" ]; then
  # Explicit edge override (without probe)
  if FINAL_PATH=$(run_edge "$BASE_TARGET"); then
    CHOSEN_ENGINE="edge"
  else
    echo "Error: Edge-TTS synthesis failed (timeout or offline)" >&2
    exit 1
  fi
else
  # Auto: Probe network for 1.0s first
  if probe_network; then
    if FINAL_PATH=$(run_edge "$BASE_TARGET"); then
      CHOSEN_ENGINE="edge"
    else
      FALLBACK_REASON="edge_failed_after_probe"
    fi
  else
    FALLBACK_REASON="probe_offline_instant_fallback"
  fi

  # Fallback to MeloTTS if edge not chosen or failed
  if [ -z "$FINAL_PATH" ]; then
    if FINAL_PATH=$(run_melo "$BASE_TARGET"); then
      CHOSEN_ENGINE="melo_fallback"
    else
      echo "Error: Both Edge-TTS and MeloTTS failed (probe: $FALLBACK_REASON)" >&2
      exit 1
    fi
  fi
fi

# Format conversion if requested
if [ "$FORMAT" = "wav" ] && [[ "$FINAL_PATH" == *.mp3 ]]; then
  CONV_TARGET="${FINAL_PATH%.mp3}.wav"
  if command -v ffmpeg >/dev/null 2>&1; then
    if ffmpeg -y -i "$FINAL_PATH" -ar 16000 -ac 1 "$CONV_TARGET" >/dev/null 2>&1; then
      rm -f "$FINAL_PATH"
      FINAL_PATH="$CONV_TARGET"
    fi
  fi
elif [ "$FORMAT" = "mp3" ] && [[ "$FINAL_PATH" == *.wav ]]; then
  CONV_TARGET="${FINAL_PATH%.wav}.mp3"
  if command -v ffmpeg >/dev/null 2>&1; then
    if ffmpeg -y -i "$FINAL_PATH" "$CONV_TARGET" >/dev/null 2>&1; then
      rm -f "$FINAL_PATH"
      FINAL_PATH="$CONV_TARGET"
    fi
  fi
fi

ELAPSED=$(calc_elapsed)
log_entry "$CHOSEN_ENGINE" "$ELAPSED" "$FALLBACK_REASON" "$FINAL_PATH"

# Print absolute path to stdout
echo "$FINAL_PATH"
