"""Desktop and Window Screenshot Capture Engine (Pure ctypes + MSS + Pillow)."""

from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import io
from typing import Any, Dict, Optional
import mss
from PIL import Image
from fullawake.capabilities.desktop_vision.uia_backend import get_process_name, is_window_cloaked
from fullawake.core.config import config
from fullawake.core.policy import is_window_sensitive
from fullawake.core.session import is_desktop_locked


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


def foreground_game(user32):
    """Resolve only the foreground client of an explicitly allowed game executable."""
    user32.GetForegroundWindow.restype = wintypes.HWND
    hwnd = user32.GetForegroundWindow()
    if not hwnd or not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd) or is_window_cloaked(hwnd):
        return None
    pid = wintypes.DWORD()
    if not user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid)):
        return None
    process = get_process_name(pid.value)
    if not process or process.casefold() not in config.game_processes:
        return None
    title = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, title, len(title))
    if is_window_sensitive(title.value, process):
        return None
    rect, origin = RECT(), wintypes.POINT()
    if not user32.GetClientRect(hwnd, ctypes.byref(rect)) or not user32.ClientToScreen(hwnd, ctypes.byref(origin)):
        return None
    width, height = rect.right - rect.left, rect.bottom - rect.top
    if width < 64 or height < 64:
        return None
    return hwnd, pid.value, process, {'left': origin.x, 'top': origin.y, 'width': width, 'height': height}


def _covered(user32, hwnd, area):
    """MSS reads visible pixels. Reject overlap from windows above the game."""
    user32.GetWindow.restype = wintypes.HWND
    above = hwnd
    rect = RECT()
    for _ in range(256):
        above = user32.GetWindow(above, 3)  # GW_HWNDPREV
        if not above:
            return False
        if not user32.IsWindowVisible(above) or user32.IsIconic(above) or is_window_cloaked(above):
            continue
        if not user32.GetWindowRect(above, ctypes.byref(rect)):
            return True
        if (rect.left < area['left'] + area['width'] and area['left'] < rect.right
                and rect.top < area['top'] + area['height'] and area['top'] < rect.bottom):
            return True
    return True


def capture_screenshot(hwnd: Optional[int] = None, *, auto_game: bool = False) -> Dict[str, Any]:
    """Capture a screenshot of the entire desktop or a specific window by HWND.

    Returns a dict with dimensions and base64-encoded JPEG data.
    """
    if (is_desktop_locked(strict=True) if auto_game else is_desktop_locked()):
        return {
            "error": "PC session is locked. Screen capture is disabled for security and privacy.",
            "locked": True,
        }

    user32 = ctypes.windll.user32

    mss_cls = getattr(mss, "MSS", getattr(mss, "mss", None))
    with mss_cls() as sct:
        game = foreground_game(user32) if auto_game else None
        if auto_game:
            if game is None:
                return {'error': '未找到可共享的前台游戏，请将已配置的游戏切到前台。', 'code': 'no_foreground_game'}
            game_hwnd, _, _, monitor = game
            if not any(m['left'] <= monitor['left'] and m['top'] <= monitor['top']
                       and monitor['left'] + monitor['width'] <= m['left'] + m['width']
                       and monitor['top'] + monitor['height'] <= m['top'] + m['height']
                       for m in sct.monitors[1:]):
                return {'error': '游戏窗口未完整显示在同一台显示器内。', 'code': 'game_outside_display'}
            if _covered(user32, game_hwnd, monitor):
                return {'error': '游戏窗口被覆盖，请关闭浮层后再看。', 'code': 'game_occluded'}
        elif hwnd is not None and hwnd > 0:
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
        if game is not None:
            if is_desktop_locked(strict=True) or game != foreground_game(user32) or _covered(user32, game[0], monitor):
                return {'error': '截图时前台游戏已变化，请切回游戏后再试。', 'code': 'game_changed'}
            if all(high <= 4 for _, high in img.resize((32, 18), Image.Resampling.BOX).getextrema()):
                return {'error': '游戏画面是黑屏，无法判断当前战况。', 'code': 'game_blank'}

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
        **({'target': 'auto_game', 'game_process': game[2]} if game is not None else {}),
    }
