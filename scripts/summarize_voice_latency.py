"""Summarize end-to-end voice call & BreezeBlue latency P50/P95 from gateway.log."""

import json
import math
import re
import sys
from pathlib import Path

DEFAULT_LOG = Path(__file__).resolve().parent.parent / "local/fullawake/gateway.log"
RE_STAGE = re.compile(r"LATENCY turnId=(?P<turn>\w+) stage=(?P<stage>\w+)(?P<kv>(?:\s+\w+=[\w.\-]+)+)")
RE_KV = re.compile(r"(\w+)=([\d.]+)")
RE_BREEZE = re.compile(
    r"BreezeBlue audio ready in (?P<breeze_total_ms>[\d.]+) ms "
    r"\(tts_download_ms=(?P<tts_download_ms>[\d.]+) transcode_ms=(?P<transcode_ms>[\d.]+) chars=(?P<chars>\d+)\)"
)


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, math.ceil((p / 100.0) * len(ordered)) - 1))
    return round(ordered[idx], 1)


def summarize(log_path: Path = DEFAULT_LOG) -> dict:
    metrics: dict[str, list[float]] = {
        "asr_ms": [],
        "phone_llm_ms": [],
        "tts_download_ms": [],
        "transcode_ms": [],
        "render_ms": [],
        "total_ms": [],
    }
    if not log_path.exists():
        return {"log_path": str(log_path), "exists": False, "samples": 0, "stages": {}}
    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        m = RE_STAGE.search(line)
        if m:
            kvs = {k: float(v) for k, v in RE_KV.findall(m.group("kv"))}
            for key in ("asr_ms", "phone_llm_ms", "render_ms", "total_ms"):
                if key in kvs:
                    metrics[key].append(kvs[key])
        b = RE_BREEZE.search(line)
        if b:
            metrics["tts_download_ms"].append(float(b.group("tts_download_ms")))
            metrics["transcode_ms"].append(float(b.group("transcode_ms")))
    stages = {
        name: {
            "count": len(vals),
            "p50_ms": percentile(vals, 50),
            "p95_ms": percentile(vals, 95),
            "min_ms": round(min(vals), 1) if vals else None,
            "max_ms": round(max(vals), 1) if vals else None,
        }
        for name, vals in metrics.items()
    }
    return {"log_path": str(log_path), "exists": True, "samples": len(metrics["total_ms"]), "stages": stages}


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_LOG
    print(json.dumps(summarize(target), ensure_ascii=False, indent=2))
