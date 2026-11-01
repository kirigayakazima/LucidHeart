"""FullAwake Windows Session & State Monitor.

Inspects Windows interactive desktop state (lock status, resolution, foreground app).
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
from typing import Any, Dict


def attach_to_default_desktop() -> None:
    """Ensure current thread is attached to interactive 'default' desktop."""
    try:
        user32 = ctypes.windll.user32
        h_default = user32.OpenDesktopW("default", 0, False, 0x01FF)
        if h_default:
            user32.SetThreadDesktop(h_default)
    except Exception:
        pass


def is_desktop_locked() -> bool:
    """Check if the current Windows session is locked."""
    try:
        user32 = ctypes.windll.user32
        h_desk = user32.OpenInputDesktop(0, False, 0x0001)  # DESKTOP_READOBJECTS
        if not h_desk:
            err = ctypes.GetLastError()
            if err == 5:  # ERROR_ACCESS_DENIED
                return True
        else:
            user32.CloseDesktop(h_desk)
            return False
    except Exception:
        pass
    return False


def get_screen_resolution() -> tuple[int, int]:
    """Get the primary screen resolution (width, height)."""
    try:
        user32 = ctypes.windll.user32
        w = user32.GetSystemMetrics(0)  # SM_CXSCREEN
        h = user32.GetSystemMetrics(1)  # SM_CYSCREEN
        return int(w), int(h)
    except Exception:
        return 1920, 1080


def get_foreground_window_info() -> Dict[str, Any]:
    """Get information about the currently focused top-level window."""
    attach_to_default_desktop()
    try:
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return {"hwnd": 0, "title": ""}

        length = user32.GetWindowTextLengthW(hwnd)
        buff = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buff, length + 1)
        return {"hwnd": int(hwnd), "title": buff.value}
    except Exception:
        return {"hwnd": 0, "title": ""}


def get_session_status() -> Dict[str, Any]:
    """Retrieve complete Windows desktop session status."""
    locked = is_desktop_locked()
    w, h = get_screen_resolution()
    fg = get_foreground_window_info()

    return {
        "online": True,
        "interactive": True,
        "locked": locked,
        "screen_resolution": {"width": w, "height": h},
        "foreground_window": fg["title"] if not locked else "[LOCKED]",
        "username": os.environ.get("USERNAME", "unknown"),
    }
