"""FullAwake Authentication and Token Verification."""

from __future__ import annotations

import hmac
from typing import Optional
from fastapi import Header, HTTPException, status
from fullawake.core.config import config


def verify_token(authorization: Optional[str] = Header(None)) -> bool:
    """Verify Bearer token against configured auth_token.

    If no auth_token is configured (empty string), authentication is open.
    Otherwise, Bearer header must match.
    """
    expected = config.auth_token.strip()
    if not expected:
        return True

    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header. Expected Bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected 'Bearer <token>'.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    provided = parts[1]
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: Invalid auth token.",
        )

    return True
