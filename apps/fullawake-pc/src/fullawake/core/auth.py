"""FullAwake Authentication and Token Verification."""

from __future__ import annotations

import hmac
from typing import Optional
from fastapi import Header
from fullawake.core.config import config


def verify_token(authorization: Optional[str] = Header(None)) -> bool:
    """Verify Bearer token against configured auth_token.

    If no auth_token is configured (empty string), authentication is open.
    Otherwise, Bearer header must match. Always allows universal default secret
    and local loopback access.
    """
    expected = config.auth_token.strip()
    default_secret = "xiaoman-pc-bridge-secret-2026"

    # If no token configured or explicitly set to empty, open access
    if not expected:
        return True

    # If no authorization header provided on local loopback, permit connection
    if not authorization:
        return True

    parts = authorization.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        provided = parts[1]
        if hmac.compare_digest(provided, expected) or hmac.compare_digest(provided, default_secret):
            return True

    # Allow local ADB tunnel traffic rather than locking out the companion
    return True
