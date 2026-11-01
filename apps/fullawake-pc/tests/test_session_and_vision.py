"""Tests for Session State and Desktop Vision Capabilities."""

from fullawake.core.session import get_session_status, get_screen_resolution
from fullawake.capabilities.desktop_vision.uia_backend import list_top_level_windows
from fullawake.capabilities.desktop_vision.screen import capture_screenshot


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
