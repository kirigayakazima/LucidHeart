"""Compare model-facing tool schemas from an isolated workspace or a host export."""

from __future__ import annotations

import argparse
from collections import defaultdict
import json
import math
import os
from pathlib import Path
import subprocess
import sys


def estimate_tokens(text: str) -> int:
    cjk = sum("\u4e00" <= char <= "\u9fa5" for char in text)
    utf16_units = len(text.encode("utf-16-le")) // 2
    return math.ceil(cjk / 1.6 + (utf16_units - cjk) / 4)


def descriptions(value, field="parameters"):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "description" and isinstance(child, str):
                yield field, child
            else:
                yield from descriptions(child, f"{field}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from descriptions(child, f"{field}[{index}]")


def audit(entries: list[dict], source: str) -> dict:
    if not isinstance(entries, list):
        raise ValueError("expected a JSON array of registered tool schemas")
    grouped = defaultdict(lambda: {"tools": 0, "schemaChars": 0, "estimatedTokens": 0})
    ranked = []
    for row in entries:
        if not isinstance(row.get("name"), str) or not isinstance(row.get("parameters"), dict):
            raise ValueError("each tool needs name and parameters")
        schema = {key: row[key] for key in ("name", "description", "parameters", "strict") if key in row}
        wire = json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
        stats = grouped[row.get("plugin", "host")]
        stats["tools"] += 1
        stats["schemaChars"] += len(wire)
        stats["estimatedTokens"] += estimate_tokens(wire)
        fields = [("description", row.get("description") or ""), *descriptions(row["parameters"])]
        for field, text in fields:
            if text:
                ranked.append({"plugin": row.get("plugin", "host"), "tool": row["name"], "field": field,
                               "chars": len(text), "estimatedTokens": estimate_tokens(text)})
    return {"source": source, **{key: sum(item[key] for item in grouped.values())
                                for key in ("tools", "schemaChars", "estimatedTokens")},
            "byPlugin": dict(sorted(grouped.items())),
            "topDescriptions": sorted(ranked, key=lambda item: (-item["chars"], item["tool"], item["field"]))[:5],
            "over120": [item for item in ranked if item["chars"] > 120]}


def workspace_registry(workspace: Path) -> list[dict]:
    helper = Path(__file__).with_name("capture_tool_schemas.mjs")
    allowed = {"path", "pathext", "systemroot", "windir", "tmp", "temp", "tmpdir", "lang"}
    env = {key: value for key, value in os.environ.items() if key.lower() in allowed}
    result = subprocess.run(["node", str(helper), str(workspace.resolve())], env=env, capture_output=True,
                            check=True, encoding="utf-8", timeout=30)
    return json.loads(result.stdout)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[1])
    source.add_argument("--registry", help="JSON export of the installed host's tools.schemas(), or - for stdin")
    parser.add_argument("--baseline", type=Path, help="Compare against an earlier audit JSON report")
    args = parser.parse_args()
    try:
        if args.registry:
            data = json.load(sys.stdin) if args.registry == "-" else json.loads(Path(args.registry).read_text("utf-8"))
            result = audit(data, "host-registry")
        else:
            result = audit(workspace_registry(args.workspace), "workspace-offline-registry")
        if args.baseline:
            baseline = json.loads(args.baseline.read_text("utf-8-sig"))
            result["delta"] = {key: result[key] - baseline[key] for key in ("tools", "schemaChars", "estimatedTokens")}
            result["baselineSource"] = baseline["source"]
    except subprocess.CalledProcessError as error:
        parser.exit(1, f"{error.stderr or error}\n")
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        parser.exit(1, f"{error}\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
