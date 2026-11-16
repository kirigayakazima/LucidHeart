"""Desktop Vision Tools for FullAwake."""

from __future__ import annotations

from typing import Any, Dict, List
from fullawake.capabilities.desktop_vision.game_storyboard import GameStoryboard
from fullawake.capabilities.base import BaseCapability, ToolDefinition
from fullawake.capabilities.desktop_vision.screen import capture_screenshot
from fullawake.capabilities.desktop_vision.uia_backend import list_top_level_windows
from fullawake.core.session import get_session_status


class DesktopVisionCapability(BaseCapability):
    """Vision and window perception capability for Windows desktop."""

    def __init__(self):
        self.storyboard = GameStoryboard()

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
                description=(
                    "List all visible, active top-level windows currently open on the Windows desktop. "
                    "Returns window titles, process names, dimensions, and window handle IDs for snapshot targeting."
                ),
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

        windows = list_top_level_windows()
        return {
            "total_windows": len(windows),
            "windows": windows,
        }

    async def handle_snapshot(self, arguments: Dict[str, Any]) -> Dict[str, Any]:
        hwnd = arguments.get("hwnd")
        mode = arguments.get('mode', 'single')
        if mode not in ('single', 'burst') or ('mode' in arguments and arguments.get('target') != 'auto_game'):
            return {'error': 'mode must be single or burst and requires auto_game.', 'code': 'invalid_mode'}
        if "target" in arguments:
            if arguments['target'] != 'auto_game' or hwnd is not None:
                return {'error': 'target must be auto_game and cannot be combined with hwnd.', 'code': 'invalid_target'}
            if mode == 'burst':
                return await self.storyboard.snapshot()
            return capture_screenshot(auto_game=True)
        if hwnd is not None:
            hwnd = int(hwnd)
        return capture_screenshot(hwnd=hwnd)
