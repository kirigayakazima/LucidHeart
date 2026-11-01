"""Desktop and Window Screenshot Capture Engine (Pure ctypes + MSS + Pillow)."""

from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import io
from typing import Any, Dict, Optional
import mss
from PIL import Image
from fullawake.core.config import config
from fullawake.core.session import is_desktop_locked


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


def capture_screenshot(hwnd: Optional[int] = None) -> Dict[str, Any]:
    """Capture a screenshot of the entire desktop or a specific window by HWND.

    Returns a dict with dimensions and base64-encoded JPEG data.
    """
    if is_desktop_locked():
        return {
            "error": "PC session is locked. Screen capture is disabled for security and privacy.",
            "locked": True,
        }

    user32 = ctypes.windll.user32

    mss_cls = getattr(mss, "MSS", getattr(mss, "mss", None))
    with mss_cls() as sct:
        if hwnd is not None and hwnd > 0:
            if not user32.IsWindow(hwnd):
                return {"error": f"Invalid window handle: {hwnd}"}

            if user32.IsIconic(hwnd):
                return {"error": f"Window {hwnd} is minimized. Please un-minimize before snapshot."}

            rect = RECT()
            if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                return {"error": f"Failed to get bounding rect for window {hwnd}"}

            left, top, right, bottom = rect.left, rect.top, rect.right, rect.bottom
            width = right - left
            height = bottom - top

            if width <= 0 or height <= 0:
                return {"error": f"Window {hwnd} has non-positive dimensions ({width}x{height})."}

            monitor = {
                "left": left,
                "top": top,
                "width": width,
                "height": height,
            }
        else:
            # Capture primary monitor (monitor 1)
            monitor = sct.monitors[1] if len(sct.monitors) > 1 else sct.monitors[0]

        try:
            sct_img = sct.grab(monitor)
            # Convert MSS screenshot to PIL Image (RGB mode)
            img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
        except Exception as e:
            return {"error": f"Failed to grab screen: {e}"}

    orig_w, orig_h = img.size

    # Scale down if exceeds max bounds while preserving aspect ratio
    max_w = config.max_snapshot_width
    max_h = config.max_snapshot_height
    img.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    final_w, final_h = img.size

    # Compress to JPEG
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=config.snapshot_quality, optimize=True)
    buf.seek(0)
    b64_str = base64.b64encode(buf.read()).decode("ascii")

    return {
        "success": True,
        "format": "jpeg",
        "original_size": {"width": orig_w, "height": orig_h},
        "snapshot_size": {"width": final_w, "height": final_h},
        "base64_data": b64_str,
        "data_url": f"data:image/jpeg;base64,{b64_str}",
    }
