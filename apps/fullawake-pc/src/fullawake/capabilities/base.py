"""Base Capability Interface for FullAwake extensions."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Callable, Dict, List
from pydantic import BaseModel


class ToolDefinition(BaseModel):
    """Specification of an MCP tool exposed by FullAwake."""
    name: str
    description: str
    parameters: Dict[str, Any]
    handler: Any  # Callable handler


class BaseCapability(ABC):
    """Abstract Base Class for all FullAwake capabilities."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Name of the capability module."""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """Description of what this capability provides."""
        pass

    @abstractmethod
    def get_tools(self) -> List[ToolDefinition]:
        """Return list of ToolDefinitions to register into MCP Server."""
        pass
