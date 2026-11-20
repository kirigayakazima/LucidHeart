"""Tests for Session State and Desktop Vision Capabilities."""

from fullawake.core.session import get_session_status, get_screen_resolution
from fullawake.capabilities.desktop_vision.uia_backend import list_top_level_windows
from fullawake.capabilities.desktop_vision.screen import capture_screenshot, _select_monitor
from types import SimpleNamespace


def test_get_session_status():
    status = get_session_status()
    assert "online" in status
    assert status["online"] is True
    assert "screen_resolution" in status
    assert status["screen_resolution"]["width"] > 0
    assert status["screen_resolution"]["height"] > 0


def test_list_top_level_windows():
    windows = list_top_level_windows()
    assert isinstance(windows, list)
    # On an active Windows desktop, there should be at least one window
    assert len(windows) > 0
    first = windows[0]
    assert "hwnd" in first
    assert "title" in first
    assert "bounds" in first


def test_capture_screenshot():
    result = capture_screenshot()
    assert "success" in result or "error" in result
    if result.get("success"):
        assert result["format"] == "jpeg"
        assert len(result["base64_data"]) > 100
        assert result["snapshot_size"]["width"] <= 1280
        assert result["snapshot_size"]["height"] <= 720


def test_select_monitor_prefers_true_primary_over_index_1():
    sct = SimpleNamespace(monitors=[
        {"left": 0, "top": -154, "width": 5120, "height": 1600},
        {"left": 2560, "top": -154, "width": 2560, "height": 1600, "is_primary": False},
        {"left": 0, "top": 0, "width": 2560, "height": 1440, "is_primary": True},
    ])
    user32 = SimpleNamespace(GetForegroundWindow=lambda: 0)
    chosen = _select_monitor(sct, user32)
    assert chosen == sct.monitors[2]


def test_select_monitor_prefers_foreground_window_display():
    sct = SimpleNamespace(monitors=[
        {"left": 0, "top": -154, "width": 5120, "height": 1600},
        {"left": 2560, "top": -154, "width": 2560, "height": 1600, "is_primary": False},
        {"left": 0, "top": 0, "width": 2560, "height": 1440, "is_primary": True},
    ])

    def fake_get_monitor_info(_hmon, info_ptr):
        info = info_ptr._obj
        info.rcMonitor.left = 2560
        info.rcMonitor.top = -154
        info.rcMonitor.right = 5120
        info.rcMonitor.bottom = 1446
        info.dwFlags = 0
        return 1

    user32 = SimpleNamespace(
        GetForegroundWindow=lambda: 12345,
        MonitorFromWindow=lambda hwnd, flags: 99,
        GetMonitorInfoW=fake_get_monitor_info,
    )
    chosen = _select_monitor(sct, user32)
    assert chosen == sct.monitors[1]
