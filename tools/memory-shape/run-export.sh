#!/bin/sh
# Run in Xiaoman's own Proot, never Scene Root or the stopped build170.
set -eu
cd "$(dirname "$0")"
sha256sum -c checksums.txt
if [ "$#" -ne 1 ]; then
  echo 'Usage: sh run-export.sh ACTUAL_MEMORY_DATA_DIR (check the loaded @dsh/memory config first)' >&2
  exit 1
fi
if [ "$(id -u)" != 0 ] || [ "${HOME:-}" != /root ]; then
  echo 'Run in the DSHA Proot terminal.' >&2
  exit 1
fi
# PRoot virtual uid=0 is expected; actual Android UID must be the new App.
native_uid=$(awk '/^Uid:/{print $2; exit}' /proc/self/status)
if [ "$native_uid" != 10368 ]; then
  echo 'Expected build190 Android UID 10368; no export performed.' >&2
  exit 1
fi
current=$(realpath "$1")
other=/root/.dsh/memory
if [ "$current" = "$(realpath "$other" 2>/dev/null || printf missing)" ]; then
  other=/root/.dsh/profiles/memory
fi
out="/sdcard/dshproject/memory-shape-$(date +%Y%m%d-%H%M%S)-$$.json"
if [ -d "$other" ] && [ "$(realpath "$other")" != "$current" ]; then
  node export.mjs --heart-dir /root/.dsh/heart --memory-dir "$current" --archive-memory-dir "$other" --scope xiaoman_private --out "$out"
else
  node export.mjs --heart-dir /root/.dsh/heart --memory-dir "$current" --scope xiaoman_private --out "$out"
fi
