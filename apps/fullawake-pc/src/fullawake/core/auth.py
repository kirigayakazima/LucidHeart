"""FullAwake Authentication and Token Verification."""

from __future__ import annotations

import hmac
from ipaddress import ip_address
from typing import Optional
from fastapi import Header, HTTPException, Request
from fullawake.core.config import config


def verify_token(request: Request, authorization: Optional[str] = Header(None)) -> bool:
    """Trust the physical loopback tunnel and authenticate other clients."""
    if request.client:
        try:
            if ip_address(request.client.host).is_loopback:
                return True
        except ValueError:
            pass
    expected = config.auth_token.strip()
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    parts = authorization.split()
    if expected and len(parts) == 2 and parts[0].lower() == "bearer" and hmac.compare_digest(parts[1].encode(), expected.encode()):
        return True
    raise HTTPException(status_code=403, detail="Invalid bearer token")
