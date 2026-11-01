"""FullAwake Security Policy & Boundary Enforcement.

Strictly protects private data (e.g., sister Axing's Heart/DSH data)
and restricts file and window access to authorized areas only.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional
from fullawake.core.config import config


class SecurityViolationError(PermissionError):
    """Raised when an operation violates security boundaries."""


def validate_path(target_path_str: str) -> Path:
    """Validate that a target path is allowed for reading.

    Rules:
    1. Must resolve to an absolute normalized path.
    2. Must be located under one of the allowed_roots.
    3. Must not contain any denied keywords (e.g. Heart, .dsh, credentials, vault).
    4. Must not exceed maximum allowed file size.

    Returns:
        Resolved Path object.

    Raises:
        SecurityViolationError: If boundary check fails.
        FileNotFoundError: If target file does not exist.
    """
    if not target_path_str or not target_path_str.strip():
        raise SecurityViolationError("Empty path is not allowed.")

    candidate = Path(target_path_str.strip())
    # If candidate is relative, attempt resolution relative to primary workspace root first
    if not candidate.is_absolute() and config.allowed_roots:
        root_candidate = (Path(config.allowed_roots[0]) / candidate).resolve()
        if root_candidate.exists():
            resolved = root_candidate
        else:
            resolved = candidate.resolve()
    else:
        resolved = candidate.resolve()

    resolved_str = str(resolved).lower()

    # 1. Denied keyword check (Defense-in-depth against sensitive directories)
    for kw in config.denied_path_keywords:
        kw_lower = kw.lower()
        # Check against path parts and whole string
        if kw_lower in resolved_str:
            raise SecurityViolationError(
                f"Access denied: Path contains protected keyword '{kw}'."
            )

    # 2. Allowed roots check
    is_allowed = False
    for root in config.allowed_roots:
        try:
            root_resolved = Path(root).resolve()
            # If resolved starts with root_resolved
            resolved.relative_to(root_resolved)
            is_allowed = True
            break
        except ValueError:
            continue

    if not is_allowed:
        raise SecurityViolationError(
            f"Access denied: Target path '{resolved}' is outside allowed workspace roots."
        )

    if not resolved.exists():
        raise FileNotFoundError(f"File not found: {resolved}")

    if not resolved.is_file():
        raise SecurityViolationError(f"Target is not a regular file: {resolved}")

    # 3. File size check
    file_size = resolved.stat().st_size
    if file_size > config.max_file_size_bytes:
        raise SecurityViolationError(
            f"File too large ({file_size} bytes). Limit is {config.max_file_size_bytes} bytes."
        )

    return resolved


# Sensitive window title keywords to mask or filter
SENSITIVE_WINDOW_KEYWORDS = [
    "1password",
    "keepass",
    "bitwarden",
    "lastpass",
    "credential",
    "privacy",
    "password",
    "axing_private",
]


def is_window_sensitive(title: str, process_name: str) -> bool:
    """Check if a window title or process indicates a sensitive or protected application."""
    combined = f"{title} {process_name}".lower()
    return any(kw in combined for kw in SENSITIVE_WINDOW_KEYWORDS)


def filter_windows(windows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Filter out or mask sensitive windows from model inspection."""
    safe_list = []
    for win in windows:
        title = win.get("title", "")
        proc = win.get("process_name", "")
        if is_window_sensitive(title, proc):
            # Mask title or exclude
            masked = dict(win)
            masked["title"] = "[PROTECTED SENSITIVE WINDOW]"
            masked["is_sensitive"] = True
            safe_list.append(masked)
        else:
            win["is_sensitive"] = False
            safe_list.append(win)
    return safe_list
