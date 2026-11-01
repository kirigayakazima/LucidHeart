"""Safe File System Path Guard."""

from __future__ import annotations

from pathlib import Path
from fullawake.core.policy import validate_path


def read_safe_file(path_str: str, start_line: int = 1, end_line: int | None = None) -> dict:
    """Read contents of an authorized file with line range bounds."""
    resolved_path = validate_path(path_str)

    try:
        content = resolved_path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return {
            "error": f"Failed to read file: {e}",
            "path": str(resolved_path),
        }

    lines = content.splitlines(keepends=True)
    total_lines = len(lines)

    start_idx = max(0, start_line - 1)
    if end_line is not None and end_line > 0:
        end_idx = min(total_lines, end_line)
    else:
        end_idx = total_lines

    selected_lines = lines[start_idx:end_idx]
    text_slice = "".join(selected_lines)

    return {
        "path": str(resolved_path),
        "total_lines": total_lines,
        "start_line": start_idx + 1,
        "end_line": end_idx,
        "content": text_slice,
    }
