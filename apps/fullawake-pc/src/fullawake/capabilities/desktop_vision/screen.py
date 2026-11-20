"""Desktop and Window Screenshot Capture Engine (Pure ctypes + MSS + Pillow)."""

from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import io
from threading import Lock
from typing import Any, Dict, Optional
import mss
from PIL import Image, ImageDraw
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


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", RECT),
        ("rcWork", RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def _select_monitor(sct, user32) -> Dict[str, Any]:
    """Select the monitor of the foreground window, falling back to the true primary display."""
    displays = sct.monitors[1:] if len(sct.monitors) > 1 else sct.monitors
    if not displays:
        return sct.monitors[0]
    if len(displays) == 1:
        return displays[0]

    try:
        hwnd = user32.GetForegroundWindow()
        if hwnd and hasattr(user32, "MonitorFromWindow") and hasattr(user32, "GetMonitorInfoW"):
            hmon = user32.MonitorFromWindow(wintypes.HWND(hwnd), 2)  # MONITOR_DEFAULTTONEAREST
            if hmon:
                info = MONITORINFO()
                info.cbSize = ctypes.sizeof(MONITORINFO)
                if user32.GetMonitorInfoW(wintypes.HANDLE(hmon), ctypes.byref(info)):
                    rect = info.rcMonitor
                    w, h = rect.right - rect.left, rect.bottom - rect.top
                    for m in displays:
                        if m["left"] == rect.left and m["top"] == rect.top and m["width"] == w and m["height"] == h:
                            return m
                    is_primary = bool(info.dwFlags & 1)
                    for m in displays:
                        if m.get("is_primary") is is_primary:
                            return m
    except Exception:
        pass

    for m in displays:
        if m.get("is_primary") is True:
            return m
    for m in displays:
        if m.get("left") == 0 and m.get("top") == 0:
            return m
    return displays[0]


PET_OVERLAY_PROPERTY = 'LucidHeart.GameWatch.PetOverlay.v1'
REGION_BOXES = {
    'full': (0, 0, 1, 1),
    'left': (0, 0, .5, 1), 'right': (.5, 0, 1, 1),
    'top': (0, 0, 1, .5), 'bottom': (0, .5, 1, 1),
    'center': (.25, .25, .75, .75),
    'top_left': (0, 0, .55, .55), 'top_right': (.45, 0, 1, .55),
    'bottom_left': (0, .45, .55, 1), 'bottom_right': (.45, .45, 1, 1),
    'minimap': (.45, .45, 1, 1),
}

BLANK_WARNING = '检测到画面全黑。请尝试关闭浏览器硬件加速，或使用本地播放器及非 DRM 播放源。'
_dxgi_lock = Lock()


def _contains(display, area):
    return (display['left'] <= area['left'] and display['top'] <= area['top'] and
            display['left'] + display['width'] >= area['left'] + area['width'] and
            display['top'] + display['height'] >= area['top'] + area['height'])


def _grab_dxgi(area):
    # DXcam 0.3 has no public output geometry API. Match the native DXGI
    # coordinates, never infer adapter/output IDs from MSS enumeration order.
    import dxcam
    with _dxgi_lock:
        for device_idx, outputs in enumerate(dxcam.__factory.outputs):
            for output_idx, output in enumerate(outputs):
                output.update_desc()
                rect = output.desc.DesktopCoordinates
                display = dict(left=rect.left, top=rect.top, width=rect.right - rect.left, height=rect.bottom - rect.top)
                if not output.attached_to_desktop or not _contains(display, area):
                    continue
                left, top = area['left'] - rect.left, area['top'] - rect.top
                with dxcam.create(device_idx=device_idx, output_idx=output_idx, output_color='RGB',
                                  processor_backend='numpy') as camera:
                    frame = camera.grab(region=(left, top, left + area['width'], top + area['height']))
                    return Image.fromarray(frame) if frame is not None else None
    return None


def is_blank(image):
    return all(high <= 4 for _, high in image.resize((32, 18), Image.Resampling.BOX).getextrema())


def grab_area(sct, area, *, dxgi=True):
    blank = None
    if dxgi:
        try:
            image = _grab_dxgi(area)
            if image is not None:
                if not is_blank(image):
                    return image, 'dxcam', False
                blank = image
        except Exception:
            # Optional backend may fail on a driver, session or topology change.
            pass
    try:
        pixels = sct.grab(area)
        image = Image.frombytes('RGB', pixels.size, pixels.bgra, 'raw', 'BGRX')
        return image, 'mss', is_blank(image)
    except Exception:
        if blank is not None:
            return blank, 'dxcam', True
        raise


def crop_region(image, region):
    x0, y0, x1, y1 = REGION_BOXES[region]
    box = (int(image.width * x0), int(image.height * y0), int(image.width * x1), int(image.height * y1))
    left, top, right, bottom = box
    return image.crop(box), {'left': left, 'top': top, 'width': right - left, 'height': bottom - top}


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


def _covered(user32, hwnd, area, masks=None):
    """Reject other visible windows, returning masks for recognized overlays."""
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
            overlay = _friendly_overlay(user32, above)
            if overlay:
                if overlay == 'pet' and masks is not None:
                    masks.append((max(0, rect.left - area['left']), max(0, rect.top - area['top']),
                                  min(area['width'], rect.right - area['left']) - 1,
                                  min(area['height'], rect.bottom - area['top']) - 1))
                continue
            return True
    return True


def _friendly_overlay(user32, hwnd):
    if not hasattr(user32, 'GetPropW'):
        return None
    handle = wintypes.HWND(hwnd)
    if user32.GetPropW(handle, PET_OVERLAY_PROPERTY):
        return 'pet'
    style = user32.GetWindowLongW(handle, -20)  # GWL_EXSTYLE
    if style & 0x80020 != 0x80020:  # WS_EX_LAYERED | WS_EX_TRANSPARENT
        return None
    alpha, flags = ctypes.c_ubyte(), wintypes.DWORD()
    if (user32.GetLayeredWindowAttributes(handle, None, ctypes.byref(alpha), ctypes.byref(flags))
            and flags.value & 2 and alpha.value == 0):
        return 'transparent'


def probe_game():
    """Return the shareable foreground identity or a text-only error."""
    if is_desktop_locked(strict=True):
        return None, {'error': 'PC session is locked. Screen capture is disabled.', 'locked': True}
    user32 = ctypes.windll.user32
    game = foreground_game(user32)
    if game is None:
        return None, {'error': '未找到可共享的前台游戏，请将已配置的游戏切到前台。', 'code': 'no_foreground_game'}
    if _covered(user32, game[0], game[3]):
        return None, {'error': '游戏窗口被覆盖，请关闭浮层后再看。', 'code': 'game_occluded'}
    return game, None


def active_game_window():
    """Check focus for audio playback, including while the pet itself is visible."""
    if not is_desktop_locked(strict=True):
        return foreground_game(ctypes.windll.user32)


def capture_screenshot(hwnd: Optional[int] = None, *, auto_game: bool = False, sample: bool = False,
                       region: Optional[str] = None, monitor_id: int | None = None,
                       console_target: bool = False) -> Dict[str, Any]:
    """Capture a screenshot of the entire desktop or a specific window by HWND.

    Returns a dict with dimensions and base64-encoded JPEG data.
    """
    if region is not None and (not isinstance(region, str) or region not in REGION_BOXES or sample):
        return {'error': 'Unsupported screenshot region.', 'code': 'invalid_region'}
    if (is_desktop_locked(strict=True) if auto_game else is_desktop_locked()):
        return {
            "error": "PC session is locked. Screen capture is disabled for security and privacy.",
            "locked": True,
        }

    user32 = ctypes.windll.user32

    mss_cls = getattr(mss, "MSS", getattr(mss, "mss", None))
    with mss_cls() as sct:
        game = foreground_game(user32) if auto_game else None
        masks = []
        if auto_game:
            if game is None:
                return {'error': '未找到可共享的前台游戏，请将已配置的游戏切到前台。', 'code': 'no_foreground_game'}
            game_hwnd, _, _, monitor = game
            if not any(m['left'] <= monitor['left'] and m['top'] <= monitor['top']
                       and monitor['left'] + monitor['width'] <= m['left'] + m['width']
                       and monitor['top'] + monitor['height'] <= m['top'] + m['height']
                       for m in sct.monitors[1:]):
                return {'error': '游戏窗口未完整显示在同一台显示器内。', 'code': 'game_outside_display'}
            if _covered(user32, game_hwnd, monitor, masks):
                return {'error': '游戏窗口被覆盖，请关闭浮层后再看。', 'code': 'game_occluded'}
        elif monitor_id is not None:
            if type(monitor_id) is not int or not 1 <= monitor_id < len(sct.monitors):
                return {'error': '显示器已断开或不存在。', 'code': 'invalid_monitor'}
            monitor = sct.monitors[monitor_id]
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
            if console_target:
                title = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(hwnd, title, len(title))
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if (not pid.value or is_window_sensitive(title.value, get_process_name(pid.value))
                        or _covered(user32, hwnd, monitor, masks)):
                    return {'error': '窗口被覆盖或不可共享。', 'code': 'window_unavailable'}
        else:
            monitor = _select_monitor(sct, user32)

        try:
            img, backend, blank = grab_area(sct, monitor)
        except Exception as e:
            return {"error": f"Failed to grab screen: {e}"}
        if is_desktop_locked():
            return {'error': 'Screen capture is disabled while locked.', 'locked': True}
        if console_target and hwnd and monitor_id is None:
            current = RECT()
            if (not user32.IsWindow(hwnd) or user32.IsIconic(hwnd) or not user32.GetWindowRect(hwnd, ctypes.byref(current))
                    or (current.left, current.top, current.right, current.bottom) != (left, top, right, bottom)
                    or _covered(user32, hwnd, monitor, masks)):
                return {'error': '窗口在截图时移动或被覆盖。', 'code': 'window_changed'}
        if game is not None:
            if is_desktop_locked(strict=True) or game != foreground_game(user32) or _covered(user32, game[0], monitor, masks):
                return {'error': '截图时前台游戏已变化，请切回游戏后再试。', 'code': 'game_changed'}
            if blank:
                return {'error': '游戏画面是黑屏，无法判断当前战况。', 'code': 'game_blank'}
        if masks:
            draw = ImageDraw.Draw(img)
            for mask in masks:
                draw.rectangle(mask, fill=(20, 20, 24))

    if sample:
        img.thumbnail((384, 384), Image.Resampling.LANCZOS)
        return {'game': game, 'image': img}

    orig_w, orig_h = img.size
    metadata = {'capture_backend': backend, 'is_blank': blank, 'blank_warning': blank,
                **({'warning': BLANK_WARNING} if blank else {})}
    if region is not None:
        img, bounds = crop_region(img, region)
        metadata.update(region=region, crop_rect=bounds, estimated_visual_tokens=384)

    # Scale down if exceeds max bounds while preserving aspect ratio
    max_w = config.max_snapshot_width
    max_h = config.max_snapshot_height
    if region is not None:
        max_w, max_h = min(768, max_w), min(768, max_h)
    img.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    return encode_snapshot(img, original=(orig_w, orig_h),
                           **metadata,
                           **({'target': 'auto_game', 'game_process': game[2]} if game is not None else {}))


def encode_snapshot(img, *, original=None, **metadata):
    orig_w, orig_h = original or img.size
    final_w, final_h = img.size
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
        **metadata,
    }
