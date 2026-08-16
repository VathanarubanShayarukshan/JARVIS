from __future__ import annotations

import json
from typing import Any, Callable

from . import files, shell, web


class Registry:
    """In-process tool registry. Tool configs and result records flow through child executors."""

    def __init__(self) -> None:
        self._tools: dict[str, dict[str, Any]] = {}
        self._register_group(files)
        self._register_group(shell)
        self._register_group(web)

    def _register_group(self, group) -> None:
        for name in dir(group):
            obj = getattr(group, name)
            if getattr(obj, "_tool", False):
                self._tools[name] = {"config": obj._tool, "fn": obj}

    def tool_configs(self) -> list[dict[str, Any]]:
        return [t["config"] for t in self._tools.values()]

    def extra_configs(self, extras: list[dict[str, Any]]) -> list[dict[str, Any]]:
        cfg = self.tool_configs()
        cfg.extend(extras)
        return cfg

    def call(self, name: str, arguments: dict[str, Any]) -> str:
        if name not in self._tools:
            return f"Error: unknown tool '{name}'"
        fn: Callable[..., str] = self._tools[name]["fn"]
        try:
            result = fn(**arguments)
            if isinstance(result, dict):
                return json.dumps(result, ensure_ascii=False)
            return str(result)
        except Exception as e:  # noqa: BLE001 - surface tool errors to the model
            return f"Error: {type(e).__name__}: {e}"


registry = Registry()