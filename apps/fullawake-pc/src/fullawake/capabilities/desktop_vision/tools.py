"""Desktop Vision Tools for FullAwake."""

from __future__ import annotations

import json
from typing import Any, Dict, List
from fullawake.capabilities.desktop_vision.game_storyboard import GameStoryboard
from fullawake.capabilities.base import BaseCapability, ToolDefinition
from fullawake.capabilities.desktop_vision.screen import REGION_BOXES, capture_screenshot
from fullawake.capabilities.desktop_vision.uia_backend import list_top_level_windows
from fullawake.core.session import get_session_status


def compact_windows(windows: list[dict]) -> dict:
    """Fit eligible windows into the MCP text payload, in foreground/Z order."""
    result = {"total_windows": len(windows), "windows": []}
    visible = sorted((w for w in windows if not w.get("is_minimized")),
                     key=lambda w: not w.get("is_foreground"))
    for window in visible[:12]:
        result["windows"].append({
            "hwnd": window["hwnd"],
            "title": window["title"][:48],
            "process": window.get("process_name", "")[:48],
            "monitor_id": window.get("monitor_id"),
        })
        serialized = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        if len(serialized.encode("utf-16-le")) // 2 > 800:
            result["windows"].pop()
            break
    return result


class DesktopVisionCapability(BaseCapability):
    """Vision and window perception capability for Windows desktop."""

    def __init__(self):
        self.storyboard = GameStoryboard()
        self.capture_target = lambda: {}

    @property
    def name(self) -> str:
        return "desktop_vision"

    @property
    def description(self) -> str:
        return "Perceive Windows desktop state, list active windows, and capture snapshots."

    def get_tools(self) -> List[ToolDefinition]:
        return [
            ToolDefinition(
                name="pc_status",
                description=(
                    "Check whether the Windows PC is online, check lock screen status, "
                    "screen resolution, currently active foreground window, and available FullAwake capabilities."
                ),
                parameters={
                    "type": "object",
                    "properties": {},
                },
                handler=self.handle_pc_status,
            ),
            ToolDefinition(
                name="pc_list_windows",
                description="List up to 12 visible Windows windows, foreground first, with handles for screenshots.",
                parameters={
                    "type": "object",
                    "properties": {},
                },
                handler=self.handle_list_windows,
            ),
            ToolDefinition(
                name="pc_snapshot",
                description=(
                    "Capture a screenshot of the PC desktop or a specific window by its hwnd ID. "
                    "The image is automatically compressed and optimized for visual understanding."
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "hwnd": {
                            "type": "integer",
                            "description": "Optional window handle ID (from pc_list_windows). If omitted, captures primary desktop screen.",
                        },
                        "target": {"type": "string", "enum": ["auto_game"],
                                   "description": "Capture the foreground allowlisted game client only. Mutually exclusive with hwnd."},
                        "mode": {"type": "string", "enum": ["single", "burst"], "default": "single",
                                 "description": "For auto_game only. Burst returns one chronological contact sheet."},
                        "region": {"type": "string", "enum": list(REGION_BOXES),
                                   "description": "Zoom into a direction or minimap to verify small text. One JPEG up to 768x768; single mode only."},
                    },
                },
                handler=self.handle_snapshot,
            ),
        ]

    async def handle_pc_status(self, arguments: Dict[str, Any]) -> Dict[str, Any]:
        status = get_session_status()
        status["capabilities"] = ["pc_status", "pc_list_windows", "pc_snapshot", "pc_read_file"]
        return status

    async def handle_list_windows(self, arguments: Dict[str, Any]) -> Dict[str, Any]:
        status = get_session_status()
        if status.get("locked"):
            return {
                "error": "PC session is locked. Windows are not visible.",
                "locked": True,
                "windows": [],
            }

        return compact_windows(list_top_level_windows())

    async def handle_snapshot(self, arguments: Dict[str, Any]) -> Dict[str, Any]:
        hwnd = arguments.get("hwnd")
        mode = arguments.get('mode', 'single')
        region = arguments.get('region')
        if 'region' in arguments and (not isinstance(region, str) or region not in REGION_BOXES or mode == 'burst'):
            return {'error': 'region requires single mode and a supported region name.', 'code': 'invalid_region'}
        if mode not in ('single', 'burst') or ('mode' in arguments and arguments.get('target') != 'auto_game'):
            return {'error': 'mode must be single or burst and requires auto_game.', 'code': 'invalid_mode'}
        if "target" in arguments:
            if arguments['target'] != 'auto_game' or hwnd is not None:
                return {'error': 'target must be auto_game and cannot be combined with hwnd.', 'code': 'invalid_target'}
            if mode == 'burst':
                return await self.storyboard.snapshot()
            return capture_screenshot(auto_game=True, **({'region': region} if region is not None else {}))
        if hwnd is not None:
            hwnd = int(hwnd)
        target = self.capture_target() if hwnd is None else {'hwnd': hwnd}
        return capture_screenshot(**target, **({'region': region} if region is not None else {}))
