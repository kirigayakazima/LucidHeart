#!/usr/bin/env python3
"""Proxy to workspace runtime_fingerprint.py"""
from pathlib import Path
import sys

target = Path(__file__).resolve().parents[2] / "scripts" / "runtime_fingerprint.py"
if target.is_file():
    exec(target.read_text(encoding="utf-8"))
else:
    sys.exit(1)
