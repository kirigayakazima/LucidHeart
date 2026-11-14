"""FullAwake MCP Gateway Server.

Implements standard Model Context Protocol (MCP) over SSE (Server-Sent Events)
and Streamable HTTP JSON-RPC for phone DSH MCP client.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Literal, Optional
from fastapi import Depends, FastAPI, HTTPException, Request, Response, Query, status
from starlette.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
from fullawake import __version__

from fullawake.capabilities.base import BaseCapability, ToolDefinition
from fullawake.capabilities.desktop_vision import DesktopVisionCapability
from fullawake.capabilities.desktop_vision.watch import WatchCapability, native_loopback
from fullawake.capabilities.safe_fs import SafeFSCapability
from fullawake.core.auth import verify_token
from fullawake.core.config import config
from fullawake.core.session import get_session_status
from fullawake.capabilities.voice import AUDIO_UNCLEAR, MAX_AUDIO_BYTES, MAX_SONG_BYTES, VoiceCompute
from fullawake.capabilities.voice_artifacts import DAY
from fullawake.capabilities.voice_sing_provider import (
    CUDA, ResidentSingProvider, SingJobQueue, SingQueueFull, SingQueueUnavailable,
)
from fullawake.gateway.interrupt_controller import InterruptController

logger = logging.getLogger("fullawake.gateway")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


class VoiceDownload(FileResponse):
    def __init__(self, file, release, **kwargs):
        super().__init__(file, **kwargs)
        self.release = release

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self.release()


class FullAwakeMCPGateway:
    """Gateway orchestrating FullAwake capabilities and exposing them via MCP."""

    def __init__(self) -> None:
        self.voice = VoiceCompute()
        self.sing_jobs = SingJobQueue(self._render_sing_job)
        self.watch = WatchCapability()
        self.interrupts = InterruptController(self.watch, self.voice)

        @asynccontextmanager
        async def lifespan(_app):
            if config.voice_enabled:
                self.voice.artifacts.sweep()
                if config.voice_provider == CUDA and config.voice_profile:
                    self.voice.sing_provider = ResidentSingProvider(config.voice_python, config.voice_profile)
                    self.voice.sing_provider.start()
                self.sing_jobs.start()
            expiry = asyncio.create_task(self.watch.expire_clocks()) if self.watch.enabled else None
            try:
                yield
            finally:
                if expiry:
                    expiry.cancel()
                    await asyncio.gather(expiry, return_exceptions=True)
                try:
                    await self.sing_jobs.close()
                finally:
                    if self.voice.sing_provider is not None:
                        await self.voice.sing_provider.close()
                        self.voice.sing_provider = None

        self.app = FastAPI(
            title="FullAwake Gateway",
            description="Sensory and embodiment bridge for Xiaoman (DSHA)",
            version=__version__,
            lifespan=lifespan,
        )
        self.capabilities: List[BaseCapability] = []
        self.tools: Dict[str, ToolDefinition] = {}
        self.sessions: Dict[str, asyncio.Queue] = {}

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

    async def _render_sing_job(self, job_id, audio, audio_format, pitch, *, progress):
        if self.voice.sing_provider is None:
            raise ValueError('VOICE_RVC_CUDA_UNAVAILABLE')
        return await self.voice.process_singing_pipeline(job_id, audio, audio_format, pitch,
                                                         progress=progress, queued=True)

    def register_capability(self, capability: BaseCapability) -> None:
        """Register a new capability module."""
        self.capabilities.append(capability)
        for tool_def in capability.get_tools():
            self.tools[tool_def.name] = tool_def
            logger.info("Registered MCP tool: %s (%s)", tool_def.name, capability.name)

    def _register_default_capabilities(self) -> None:
        """Register standard Phase 1 capabilities."""
        self.register_capability(DesktopVisionCapability())
        self.register_capability(self.watch)
        self.register_capability(SafeFSCapability())

    def _interrupt_desktop_playback(self):
        peer = self.interrupts.peer
        if peer:
            self.interrupts.on_speech_start(peer)
            self.interrupts.on_speech_end(peer)
        else:
            self.watch.interrupt_media()

    def _setup_routes(self) -> None:
        app = self.app
        self.watch.mount(app, self._interrupt_desktop_playback)
        self.interrupts.mount(app)

        @app.get("/health")
        async def health():
            """Unauthenticated health check."""
            return {"status": "ok", "service": "fullawake-pc-bridge", "version": __version__}

        @app.get("/status", dependencies=[Depends(verify_token)])
        async def pc_status_endpoint():
            """Authenticated PC status summary."""
            return {**get_session_status(), 'voice': {'enabled': config.voice_enabled, 'mode': 'pc_onnx_offload'}}

        @app.post('/v1/voice/asr', dependencies=[Depends(verify_token)])
        async def voice_asr_endpoint(request: Request):
            if not request.client or request.client.host not in config.voice_clients:
                raise HTTPException(status_code=403, detail='VOICE_CLIENT_NOT_ALLOWED')
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > MAX_AUDIO_BYTES:
                    return AUDIO_UNCLEAR
            if not body:
                return AUDIO_UNCLEAR
            try:
                return await asyncio.to_thread(self.voice.transcribe, bytes(body))
            except (ImportError, OSError, RuntimeError) as error:
                logger.warning('ASR runtime unavailable: %s', error)
                raise HTTPException(status_code=503, detail='ASR_UNAVAILABLE') from error

        @app.post('/v1/voice/rvc', dependencies=[Depends(verify_token)])
        async def voice_endpoint(request: Request):
            if not config.voice_enabled:
                raise HTTPException(status_code=503, detail='VOICE_DISABLED')
            if not config.auth_token.strip() or not request.client or request.client.host not in config.voice_clients:
                raise HTTPException(status_code=403, detail='VOICE_CLIENT_NOT_ALLOWED')
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 12 * 1024 * 1024:
                    raise HTTPException(status_code=413, detail='VOICE_REQUEST_TOO_LARGE')
            try:
                payload = json.loads(body)
                if not isinstance(payload, dict):
                    raise ValueError('VOICE_REQUEST_INVALID')
                return await self.voice.synthesize(payload, request.is_disconnected)
            except (ValueError, OSError, TimeoutError) as error:
                logger.exception("Voice synthesis exception: %s", error)
                code = str(error)
                if not code.startswith('VOICE_'):
                    code = 'VOICE_RUNTIME_UNAVAILABLE'
                raise HTTPException(status_code=409 if code == 'VOICE_BUSY' else 422, detail=code)

        @app.post('/v1/voice/separate', dependencies=[Depends(verify_token)])
        async def voice_separate_endpoint(request: Request, task: str = Query('song'), format: str = Query('m4a')):
            if not config.voice_enabled:
                raise HTTPException(status_code=503, detail='VOICE_DISABLED')
            if not config.auth_token.strip() or not request.client or request.client.host not in config.voice_clients:
                raise HTTPException(status_code=403, detail='VOICE_CLIENT_NOT_ALLOWED')
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 60 * 1024 * 1024:
                    raise HTTPException(status_code=413, detail='VOICE_REQUEST_TOO_LARGE')
            try:
                return await self.voice.separate(task, bytes(body), format)
            except (ValueError, OSError, TimeoutError) as error:
                logger.exception("Voice separation exception: %s", error)
                code = str(error)
                if not code.startswith('VOICE_'):
                    code = 'VOICE_SEPARATION_FAILED'
                raise HTTPException(status_code=422, detail=code)

        @app.get('/v1/voice/download/{task}/{stem}', dependencies=[Depends(verify_token)])
        async def voice_download_endpoint(task: str, stem: str):
            file_path = self.voice.get_separated_file(task, stem)
            release = self.voice.artifacts.pin(file_path, 3600) if file_path else None
            if not release:
                raise HTTPException(status_code=404, detail="FILE_NOT_FOUND")
            return VoiceDownload(str(file_path), release, media_type="audio/wav")

        @app.post('/v1/voice/sing', dependencies=[Depends(verify_token)])
        async def voice_sing_endpoint(request: Request, task: str = Query('song'), format: str = Query('m4a'),
                                      pitch: int = Query(0), heartbeat: bool = Query(False),
                                      progress: bool = Query(False)):
            if not config.voice_enabled:
                raise HTTPException(status_code=503, detail='VOICE_DISABLED')
            if not config.auth_token.strip() or not request.client or request.client.host not in config.voice_clients:
                raise HTTPException(status_code=403, detail='VOICE_CLIENT_NOT_ALLOWED')
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 60 * 1024 * 1024:
                    raise HTTPException(status_code=413, detail='VOICE_REQUEST_TOO_LARGE')
            stages = asyncio.Queue()

            async def generate_song():
                try:
                    callbacks = {'progress': stages.put_nowait} if progress else {}
                    return await self.voice.process_singing_pipeline(task, bytes(body), format, pitch, **callbacks)
                except (ValueError, OSError, TimeoutError) as error:
                    logger.exception("Voice singing pipeline exception: %s", error)
                    code = str(error)
                    if not code.startswith('VOICE_'):
                        code = 'VOICE_SINGING_FAILED'
                    raise HTTPException(status_code=422, detail=code) from error

            if not heartbeat and not progress:
                return await generate_song()

            async def stream_result():
                job = asyncio.create_task(generate_song())
                try:
                    stage = None
                    while not job.done():
                        if progress:
                            try:
                                stage = await asyncio.wait_for(stages.get(), timeout=1)
                            except asyncio.TimeoutError:
                                if job.done():
                                    break
                                yield (json.dumps({'type': 'heartbeat', 'stage': stage}) + '\n').encode()
                            else:
                                yield (json.dumps({'type': 'stage', 'stage': stage}) + '\n').encode()
                        else:
                            yield b'\n'
                            await asyncio.wait({job}, timeout=5)
                    try:
                        result = job.result()
                    except HTTPException as error:
                        result = {'ok': False, 'error': error.detail}
                    if progress:
                        while not stages.empty():
                            yield (json.dumps({'type': 'stage', 'stage': stages.get_nowait()}) + '\n').encode()
                        yield (json.dumps({'type': 'result', 'result': result}) + '\n').encode()
                    else:
                        yield json.dumps(result).encode()
                finally:
                    if not job.done():
                        job.cancel()
                    await asyncio.shield(asyncio.gather(job, return_exceptions=True))

            return StreamingResponse(stream_result(), media_type='application/x-ndjson' if progress else 'application/json')

        @app.get('/v1/voice/sing/download/{task}', dependencies=[Depends(verify_token)])
        async def voice_sing_download_endpoint(task: str, format: Literal['mp3', 'wav'] | None = None):
            file_path = self.voice.get_singing_song_file(task, format)
            release = self.voice.artifacts.pin(file_path, 7 * DAY) if file_path else None
            if not release:
                raise HTTPException(status_code=404, detail="FILE_NOT_FOUND")
            media_type = "audio/mpeg" if file_path.suffix.lower() == ".mp3" else "audio/wav"
            return VoiceDownload(str(file_path), release, media_type=media_type, filename=file_path.name)

        @app.post('/v1/voice/sing/play/{task}', dependencies=[Depends(verify_token)])
        async def play_song_endpoint(task: str, request: Request):
            if not config.voice_enabled or not config.auth_token.strip() or not request.client or request.client.host not in config.voice_clients:
                raise HTTPException(403, 'VOICE_CLIENT_NOT_ALLOWED')
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,60}', task) or not self.voice.get_singing_song_file(task, 'mp3'):
                raise HTTPException(404, 'FILE_NOT_FOUND')
            playback = self.watch.queue_song(task)
            if playback is None:
                raise HTTPException(503, 'RENDERER_DISCONNECTED')
            if playback == 'busy':
                raise HTTPException(409, 'PLAYBACK_QUEUE_FULL')
            return {'status': playback}

        @app.post('/v1/voice/playback/interrupt', dependencies=[Depends(verify_token)])
        async def interrupt_playback(request: Request):
            if not native_loopback(request):
                raise HTTPException(403, 'VOICE_CLIENT_NOT_ALLOWED')
            self._interrupt_desktop_playback()
            return {'status': 'revoked'}

        @app.post('/v1/pet/mood', dependencies=[Depends(verify_token)], status_code=204)
        async def update_pet_mood(request: Request, mood: Literal['calm', 'tired', 'excited', 'cheerful', 'engaged']):
            if not native_loopback(request):
                raise HTTPException(403, 'PET_MOOD_FORBIDDEN')
            self.watch.update_heart_mood(mood)

        async def verify_sing_client(request: Request):
            if not config.voice_enabled:
                raise HTTPException(status_code=503, detail='VOICE_DISABLED')
            if not config.auth_token.strip() or not request.client or request.client.host not in config.voice_clients:
                raise HTTPException(status_code=403, detail='VOICE_CLIENT_NOT_ALLOWED')

        sing_auth = [Depends(verify_token), Depends(verify_sing_client)]

        async def read_song(request):
            body = bytearray()
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_SONG_BYTES:
                    raise HTTPException(status_code=413, detail='VOICE_REQUEST_TOO_LARGE')
                body.extend(chunk)
            if len(body) < 100:
                raise HTTPException(status_code=422, detail='VOICE_AUDIO_EMPTY')
            return bytes(body)

        @app.post('/v1/voice/sing/jobs', status_code=202, dependencies=sing_auth)
        async def submit_sing_job(request: Request, format: Literal['m4a', 'mp3', 'wav', 'flac'] = 'm4a',
                                  pitch: int = Query(0)):
            if pitch not in (0, -4):
                raise HTTPException(status_code=422, detail='VOICE_PITCH_INVALID')
            try:
                with self.sing_jobs.upload_slot():
                    audio = await asyncio.wait_for(read_song(request), timeout=90)
                return self.sing_jobs.submit(audio, format, pitch)
            except SingQueueFull as error:
                raise HTTPException(status_code=429, detail='VOICE_SING_QUEUE_FULL') from error
            except SingQueueUnavailable as error:
                raise HTTPException(status_code=503, detail='VOICE_SING_QUEUE_UNAVAILABLE') from error
            except TimeoutError as error:
                raise HTTPException(status_code=408, detail='VOICE_UPLOAD_TIMEOUT') from error

        @app.get('/v1/voice/sing/jobs/{job_id}', dependencies=sing_auth)
        async def get_sing_job(job_id: str):
            try:
                return self.sing_jobs.get(job_id)
            except KeyError as error:
                raise HTTPException(status_code=404, detail='VOICE_SING_JOB_NOT_FOUND') from error

        @app.post('/v1/voice/sing/jobs/{job_id}/cancel', dependencies=sing_auth)
        async def cancel_sing_job(job_id: str):
            try:
                return await self.sing_jobs.cancel(job_id)
            except KeyError as error:
                raise HTTPException(status_code=404, detail='VOICE_SING_JOB_NOT_FOUND') from error

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
            response = await self.handle_jsonrpc(body, watch_allowed=native_loopback(request))
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
            response = await self.handle_jsonrpc(body, watch_allowed=native_loopback(request))
            return response if response is not None else {}

    async def handle_jsonrpc(self, msg: Dict[str, Any], *, watch_allowed=False) -> Optional[Dict[str, Any]]:
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
                        "version": __version__,
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

            watch_tool = tool_name in ('pc_watch_get_summary', 'pc_watch_control')
            if watch_tool and (not watch_allowed or not isinstance(arguments, dict)):
                code = 'WATCH_LOOPBACK_ONLY' if not watch_allowed else 'WATCH_INVALID_ARGUMENTS'
                return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32602, "message": code}}

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
                if tool_name == 'pc_watch_get_summary' and 'imageBase64' in result_data:
                    content = [
                        {'type': 'image', 'data': result_data['imageBase64'], 'mimeType': 'image/png'},
                        {'type': 'text', 'text': json.dumps({k: v for k, v in result_data.items() if k != 'imageBase64'},
                                                            ensure_ascii=False, allow_nan=False)},
                    ]
                elif isinstance(result_data, dict) and "base64_data" in result_data:
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
                            "text": json.dumps(result_data, ensure_ascii=False, indent=2, allow_nan=False),
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
                        "content": [{"type": "text", "text": '{"error":"WATCH_TOOL_FAILED"}' if watch_tool else f"Error: {e}"}],
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
    uvicorn.run(app, host=config.host, port=config.port, log_level="info",
                ws="wsproto" if gateway.watch.enabled else "auto")


if __name__ == "__main__":
    run_server()
