"""UI Automation and Window Enumeration Backend for Windows (Pure ctypes)."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
from typing import Any, Dict, List
from fullawake.core.policy import filter_windows


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def attach_to_default_desktop() -> None:
    """Ensure the current thread is attached to the interactive 'default' desktop."""
    try:
        user32 = ctypes.windll.user32
        h_default = user32.OpenDesktopW("default", 0, False, 0x01FF)  # MAXIMUM_ALLOWED
        if h_default:
            user32.SetThreadDesktop(h_default)
    except Exception:
        pass


def get_process_name(pid: int) -> str:
    """Retrieve process executable name by PID using Windows kernel32."""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h_proc = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h_proc:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if ctypes.windll.kernel32.QueryFullProcessImageNameW(h_proc, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return ""
    finally:
        ctypes.windll.kernel32.CloseHandle(h_proc)


def is_window_cloaked(hwnd: int) -> bool:
    """Check if window is cloaked (e.g. suspended UWP or virtual desktop hidden)."""
    DWMWA_CLOAKED = 14
    cloaked = wintypes.DWORD(0)
    res = ctypes.windll.dwmapi.DwmGetWindowAttribute(
        hwnd, DWMWA_CLOAKED, ctypes.byref(cloaked), ctypes.sizeof(cloaked)
    )
    if res == 0:
        return cloaked.value != 0
    return False


def list_top_level_windows() -> List[Dict[str, Any]]:
    """Enumerate all visible and interactive top-level desktop windows.

    Filters out hidden, zero-sized, and cloaked windows, and applies security policy.
    """
    attach_to_default_desktop()
    user32 = ctypes.windll.user32
    raw_windows: List[Dict[str, Any]] = []

    def enum_callback(hwnd: int, extra: Any) -> int:
        if not user32.IsWindowVisible(hwnd):
            return 1

        if is_window_cloaked(hwnd):
            return 1

        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return 1

        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value.strip()
        if not title:
            return 1

        rect = RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return 1

        width = rect.right - rect.left
        height = rect.bottom - rect.top

        if width <= 10 or height <= 10:
            return 1

        pid = wintypes.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        proc_name = get_process_name(pid.value)

        is_minimized = bool(user32.IsIconic(hwnd))

        raw_windows.append({
            "hwnd": int(hwnd),
            "title": title,
            "process_name": proc_name,
            "pid": int(pid.value),
            "is_minimized": is_minimized,
            "bounds": {
                "left": rect.left,
                "top": rect.top,
                "right": rect.right,
                "bottom": rect.bottom,
                "width": width,
                "height": height,
            },
        })
        return 1

    cb = WNDENUMPROC(enum_callback)
    user32.EnumWindows(cb, 0)

    # Apply security policy
    return filter_windows(raw_windows)
