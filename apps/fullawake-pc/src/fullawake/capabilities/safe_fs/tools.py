"""Safe File System Tools for FullAwake."""

from __future__ import annotations

from typing import Any, Dict, List
from fullawake.capabilities.base import BaseCapability, ToolDefinition
from fullawake.capabilities.safe_fs.path_guard import read_safe_file


class SafeFSCapability(BaseCapability):
    """File inspection capability constrained by strict workspace security boundaries."""

    @property
    def name(self) -> str:
        return "safe_fs"

    @property
    def description(self) -> str:
        return "Safe workspace file reading with boundary checks and line range pagination."

    def get_tools(self) -> List[ToolDefinition]:
        return [
            ToolDefinition(
                name="pc_read_file",
                description=(
                    "Read content from an authorized PC file inside the workspace. "
                    "Access is restricted to authorized directories, and protected folders "
                    "(e.g. sister Axing's Heart/DSH data, system credentials) are strictly blocked."
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute or relative file path to read on PC",
                        },
                        "start_line": {
                            "type": "integer",
                            "description": "Optional 1-based start line (inclusive)",
                            "default": 1,
                        },
                        "end_line": {
                            "type": "integer",
                            "description": "Optional 1-based end line (inclusive)",
                        },
                    },
                    "required": ["path"],
                },
                handler=self.handle_read_file,
            )
        ]

    async def handle_read_file(self, arguments: Dict[str, Any]) -> Dict[str, Any]:
        path = arguments.get("path", "")
        start_line = int(arguments.get("start_line", 1))
        end_line = arguments.get("end_line")
        if end_line is not None:
            end_line = int(end_line)

        try:
            return read_safe_file(path, start_line=start_line, end_line=end_line)
        except Exception as e:
            return {"error": str(e), "path": path}
