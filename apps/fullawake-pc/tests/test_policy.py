"""Tests for FullAwake Security Policy & Boundary Enforcement."""

import pytest
from pathlib import Path
from fullawake.core.policy import validate_path, filter_windows, SecurityViolationError


def test_validate_path_allowed_file():
    readme_path = Path(__file__).parent.parent / "README.md"
    resolved = validate_path(str(readme_path))
    assert resolved.exists()
    assert resolved.name == "README.md"


def test_validate_path_denied_heart_data():
    # Attempt to read sister Axing's Heart data
    fake_heart_path = r"d:\CodePackage\DSHA\projects\heart-plugin\lib\index.js"
    with pytest.raises(SecurityViolationError, match="protected keyword 'heart'"):
        validate_path(fake_heart_path)


def test_validate_path_denied_dsh_secrets():
    fake_dsh_path = r"d:\CodePackage\DSHA\some_folder\.dsh\config.json"
    with pytest.raises(SecurityViolationError, match="protected keyword '.dsh'"):
        validate_path(fake_dsh_path)


def test_validate_path_outside_allowed_roots():
    windows_path = r"C:\Windows\System32\drivers\etc\hosts"
    with pytest.raises(SecurityViolationError, match="outside allowed workspace roots"):
        validate_path(windows_path)


def test_filter_windows():
    test_windows = [
        {"hwnd": 101, "title": "Visual Studio Code - DSHA", "process_name": "Code.exe"},
        {"hwnd": 102, "title": "1Password - Locked", "process_name": "1password.exe"},
        {"hwnd": 103, "title": "Calculator", "process_name": "CalculatorApp.exe"},
        {"hwnd": 104, "title": "Axing_Private_Diary", "process_name": "notepad.exe"},
    ]

    filtered = filter_windows(test_windows)
    assert len(filtered) == 4

    assert filtered[0]["is_sensitive"] is False
    assert filtered[0]["title"] == "Visual Studio Code - DSHA"

    assert filtered[1]["is_sensitive"] is True
    assert filtered[1]["title"] == "[PROTECTED SENSITIVE WINDOW]"

    assert filtered[2]["is_sensitive"] is False

    assert filtered[3]["is_sensitive"] is True
    assert filtered[3]["title"] == "[PROTECTED SENSITIVE WINDOW]"
