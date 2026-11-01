"""FullAwake Configuration and Global Settings.

Defines network bindings, security boundaries, and runtime configurations.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import List
from pydantic import BaseModel, Field


class FullAwakeConfig(BaseModel):
    """FullAwake gateway and security configuration."""

    # Server settings
    host: str = Field(default="0.0.0.0", description="Bind IP (default 0.0.0.0 for LAN access)")
    port: int = Field(default=8765, description="Port for MCP SSE and HTTP gateway")
    auth_token: str = Field(
        default_factory=lambda: os.environ.get("FULLAWAKE_AUTH_TOKEN", "xiaoman-pc-bridge-secret-2026"),
        description="Bearer token required for phone DSH MCP client authentication",
    )

    # Allowed workspace roots for file reading (pc_read_file)
    allowed_roots: List[str] = Field(
        default_factory=lambda: [
            str(Path(r"d:\CodePackage\DSHA").resolve()),
        ],
        description="Directories that pc_read_file is permitted to read",
    )

    # Prohibited keywords in path segments (Strict Isolation)
    denied_path_keywords: List[str] = Field(
        default_factory=lambda: [
            "heart",            # Protect sister Axing's Heart & emotional state
            ".dsh",             # Protect private DSH session & credentials
            "appdata",          # Protect Windows system & browser secrets
            ".ssh",             # Protect SSH keys
            "vault",            # Protect XiaomanVault per workspace rules
            "credentials",
            "password",
            ".env",
        ],
        description="Forbidden keywords in paths. Any matching path will be strictly blocked.",
    )

    # File reading constraints
    max_file_size_bytes: int = Field(
        default=512 * 1024, # 512 KB
        description="Maximum file size in bytes that can be read by pc_read_file",
    )

    # Screenshot constraints (prevent prompt token explosion)
    max_snapshot_width: int = Field(default=1280, description="Max snapshot width in pixels")
    max_snapshot_height: int = Field(default=720, description="Max snapshot height in pixels")
    snapshot_quality: int = Field(default=75, description="JPEG compression quality (1-100)")


# Default global config instance
config = FullAwakeConfig()
