"""FullAwake MCP Gateway Server.

Implements standard Model Context Protocol (MCP) over SSE (Server-Sent Events)
and Streamable HTTP JSON-RPC for phone DSH MCP client.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, Dict, List, Optional
from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse

from fullawake.capabilities.base import BaseCapability, ToolDefinition
from fullawake.capabilities.desktop_vision import DesktopVisionCapability
from fullawake.capabilities.safe_fs import SafeFSCapability
from fullawake.core.auth import verify_token
from fullawake.core.config import config
from fullawake.core.session import get_session_status
from fullawake.capabilities.voice import VoiceCompute

logger = logging.getLogger("fullawake.gateway")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


class FullAwakeMCPGateway:
    """Gateway orchestrating FullAwake capabilities and exposing them via MCP."""

    def __init__(self) -> None:
        self.app = FastAPI(
            title="FullAwake Gateway",
            description="Sensory and embodiment bridge for Xiaoman (DSHA)",
            version="0.2.0",
        )
        self.capabilities: List[BaseCapability] = []
        self.tools: Dict[str, ToolDefinition] = {}
        self.sessions: Dict[str, asyncio.Queue] = {}
        self.voice = VoiceCompute()

        # Configure CORS for LAN access
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

        self._register_default_capabilities()
        self._setup_routes()

    def register_capability(self, capability: BaseCapability) -> None:
        """Register a new capability module."""
        self.capabilities.append(capability)
        for tool_def in capability.get_tools():
            self.tools[tool_def.name] = tool_def
            logger.info("Registered MCP tool: %s (%s)", tool_def.name, capability.name)

    def _register_default_capabilities(self) -> None:
        """Register standard Phase 1 capabilities."""
        self.register_capability(DesktopVisionCapability())
        self.register_capability(SafeFSCapability())

    def _setup_routes(self) -> None:
        app = self.app

        @app.get("/health")
        async def health():
            """Unauthenticated health check."""
            return {"status": "ok", "service": "fullawake-pc-bridge", "version": "0.2.0"}

        @app.get("/status", dependencies=[Depends(verify_token)])
        async def pc_status_endpoint():
            """Authenticated PC status summary."""
            return {**get_session_status(), 'voice': {'enabled': config.voice_enabled, 'mode': 'pc_onnx_offload'}}

        @app.post('/v1/voice/rvc', dependencies=[Depends(verify_token)])
        async def voice_endpoint(request: Request):
            if not config.voice_enabled:
                raise HTTPException(status_code=503, detail='VOICE_DISABLED')
            if not config.auth_token.strip() or not request.client or request.client.host not in config.voice_clients:
                raise HTTPException(status_code=403, detail='VOICE_CLIENT_NOT_ALLOWED')
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 16384:
                    raise HTTPException(status_code=413, detail='VOICE_REQUEST_TOO_LARGE')
            try:
                payload = json.loads(body)
                if not isinstance(payload, dict):
                    raise ValueError('VOICE_REQUEST_INVALID')
                return await self.voice.synthesize(payload, request.is_disconnected)
            except (ValueError, OSError, TimeoutError) as error:
                code = str(error)
                if not code.startswith('VOICE_'):
                    code = 'VOICE_RUNTIME_UNAVAILABLE'
                raise HTTPException(status_code=409 if code == 'VOICE_BUSY' else 422, detail=code)

        # ==========================================
        # MCP SSE Transport (Standard for DSH)
        # ==========================================

        @app.get("/sse", dependencies=[Depends(verify_token)])
        async def sse_endpoint(request: Request):
            """SSE connection endpoint for MCP client."""
            session_id = str(uuid.uuid4())
            queue: asyncio.Queue = asyncio.Queue()
            self.sessions[session_id] = queue

            async def event_generator():
                try:
                    # Initial endpoint event per MCP SSE spec
                    endpoint_url = f"/messages?session_id={session_id}"
                    yield {
                        "event": "endpoint",
                        "data": endpoint_url,
                    }

                    while True:
                        if await request.is_disconnected():
                            break
                        try:
                            # Wait for queued responses
                            data = await asyncio.wait_for(queue.get(), timeout=20.0)
                            yield {
                                "event": "message",
                                "data": json.dumps(data, ensure_ascii=False),
                            }
                        except asyncio.TimeoutError:
                            # Keepalive ping
                            yield {"event": "ping", "data": ""}
                finally:
                    self.sessions.pop(session_id, None)

            return EventSourceResponse(event_generator())

        @app.post("/messages", dependencies=[Depends(verify_token)])
        async def messages_endpoint(request: Request, session_id: Optional[str] = None):
            """Receive incoming JSON-RPC messages from MCP client over SSE."""
            if not session_id or session_id not in self.sessions:
                raise HTTPException(status_code=400, detail="Invalid or missing session_id")

            body = await request.json()
            response = await self.handle_jsonrpc(body)
            if response is not None:
                await self.sessions[session_id].put(response)
            return Response(status_code=status.HTTP_202_ACCEPTED)

        # ==========================================
        # Streamable HTTP MCP Endpoint
        # ==========================================

        @app.post("/mcp", dependencies=[Depends(verify_token)])
        async def mcp_direct_endpoint(request: Request):
            """Direct HTTP JSON-RPC endpoint for MCP calls."""
            body = await request.json()
            response = await self.handle_jsonrpc(body)
            return response if response is not None else {}

    async def handle_jsonrpc(self, msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Process incoming JSON-RPC 2.0 message."""
        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params", {})

        # Handle notifications (no response needed)
        if method == "notifications/initialized":
            logger.info("Client connected and initialized.")
            return None

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": {
                            "listChanged": False,
                        }
                    },
                    "serverInfo": {
                        "name": "fullawake-pc-bridge",
                        "version": "0.2.0",
                    },
                },
            }

        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

        if method == "tools/list":
            tools_manifest = []
            for tool in self.tools.values():
                tools_manifest.append({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.parameters,
                })
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {"tools": tools_manifest},
            }

        if method == "tools/call":
            tool_name = params.get("name")
            arguments = params.get("arguments", {})

            if tool_name not in self.tools:
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32601,
                        "message": f"Tool '{tool_name}' not found in FullAwake registry",
                    },
                }

            tool_def = self.tools[tool_name]
            try:
                result_data = await tool_def.handler(arguments)
                # Format as MCP content
                if isinstance(result_data, dict) and "base64_data" in result_data:
                    # Image content if snapshot
                    content = [
                        {
                            "type": "image",
                            "data": result_data["base64_data"],
                            "mimeType": f"image/{result_data.get('format', 'jpeg')}",
                        },
                        {
                            "type": "text",
                            "text": json.dumps(
                                {
                                    "success": True,
                                    "original_size": result_data.get("original_size"),
                                    "snapshot_size": result_data.get("snapshot_size"),
                                },
                                ensure_ascii=False,
                            ),
                        },
                    ]
                else:
                    content = [
                        {
                            "type": "text",
                            "text": json.dumps(result_data, ensure_ascii=False, indent=2),
                        }
                    ]

                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": content,
                        "isError": "error" in result_data if isinstance(result_data, dict) else False,
                    },
                }
            except Exception as e:
                logger.exception("Error executing tool %s: %s", tool_name, e)
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "content": [{"type": "text", "text": f"Error: {e}"}],
                        "isError": True,
                    },
                }

        # Unknown method
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method '{method}' not supported"},
        }


gateway = FullAwakeMCPGateway()
app = gateway.app


def run_server():
    """Entry point for running FullAwake Gateway."""
    import uvicorn
    print(f"[*] Starting FullAwake Gateway on {config.host}:{config.port}...")
    print("[*] Bearer authentication enabled (token hidden)")
    print(f"[*] Allowed Workspace Roots: {config.allowed_roots}")
    uvicorn.run(app, host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    run_server()
