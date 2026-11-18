"""Custom MCP servers over stdio (npx / uvx / any command).

Enabled servers are spawned lazily on the first chat that needs them and kept
alive for subsequent calls. Their tools are exposed to the model as
`mcp__<server>__<tool>` functions alongside the built-in tools.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
from typing import Any

from . import database as db
from .config import settings

CONNECT_TIMEOUT = 120.0
CALL_TIMEOUT = 180.0


def _resolve_command(command: str) -> str:
    found = shutil.which(command)
    if found:
        return found
    if os.name == "nt":
        for ext in (".cmd", ".exe", ".bat"):
            found = shutil.which(command + ext)
            if found:
                return found
    return command


def _slug(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "-", name.strip())[:24] or "server"


def _attr(obj: Any, *names: str, default: Any = None) -> Any:
    for n in names:
        v = getattr(obj, n, None)
        if v is not None:
            return v
    return default


def presets() -> list[dict[str, Any]]:
    ws = str(settings.workspace)
    return [
        {
            "name": "GitHub",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": ""},
            "needs_env": ["GITHUB_PERSONAL_ACCESS_TOKEN"],
            "description": "Repos, issues, PRs and code search on GitHub. Paste a GitHub personal access token (github.com → Settings → Developer settings → Tokens).",
        },
        {
            "name": "Filesystem",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", ws],
            "env": {},
            "needs_env": [],
            "description": "Read / write / search files in the allowed folders (defaults to the JARVIS workspace).",
        },
        {
            "name": "Memory",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-memory"],
            "env": {},
            "needs_env": [],
            "description": "Persistent knowledge-graph memory across chats.",
        },
        {
            "name": "Sequential Thinking",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
            "env": {},
            "needs_env": [],
            "description": "Step-by-step structured reasoning tool for hard problems.",
        },
        {
            "name": "Playwright (browser)",
            "command": "npx",
            "args": ["-y", "@playwright/mcp@latest"],
            "env": {},
            "needs_env": [],
            "description": "Drive a real browser: navigate, click, fill forms, screenshot (by Microsoft).",
        },
        {
            "name": "Fetch (web pages)",
            "command": "uvx",
            "args": ["mcp-server-fetch"],
            "env": {},
            "needs_env": [],
            "description": "Fetch web pages and read them as markdown. Requires uv on the server (pip install uv).",
        },
    ]


class _Connection:
    def __init__(self, server: dict[str, Any]):
        self.server = server
        self.session: Any = None
        self.tools: list[Any] = []
        self.ready = asyncio.Event()
        self.close = asyncio.Event()
        self.error: str | None = None
        self.task: asyncio.Task | None = None


class MCPManager:
    def __init__(self) -> None:
        self._conns: dict[int, _Connection] = {}
        self._lock = asyncio.Lock()

    async def _serve(self, conn: _Connection) -> None:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        s = conn.server
        log_dir = settings.data_dir / "mcp-logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        errlog = open(log_dir / f"{_slug(s['name'])}.log", "a", encoding="utf-8", errors="replace")
        params = StdioServerParameters(
            command=_resolve_command(s["command"]),
            args=s.get("args") or [],
            env={**os.environ, **(s.get("env") or {})},
        )
        try:
            async with stdio_client(params, errlog=errlog) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    tools: list[Any] = []
                    cursor = None
                    while True:
                        if cursor:
                            from mcp import types

                            res = await session.list_tools(params=types.PaginatedRequestParams(cursor=cursor))
                        else:
                            res = await session.list_tools()
                        tools.extend(res.tools)
                        cursor = _attr(res, "next_cursor", "nextCursor")
                        if not cursor:
                            break
                    conn.tools = tools
                    conn.session = session
                    conn.ready.set()
                    await conn.close.wait()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            conn.error = f"{type(e).__name__}: {e}"
            conn.ready.set()
        finally:
            conn.session = None
            try:
                errlog.close()
            except OSError:
                pass

    async def _ensure(self, server: dict[str, Any]) -> _Connection:
        async with self._lock:
            conn = self._conns.get(server["id"])
            if conn and conn.session is not None:
                return conn
            if conn:
                await self._drop(conn)
            conn = _Connection(server)
            self._conns[server["id"]] = conn
            conn.task = asyncio.create_task(self._serve(conn))
        try:
            await asyncio.wait_for(conn.ready.wait(), CONNECT_TIMEOUT)
        except asyncio.TimeoutError:
            conn.error = f"timed out after {int(CONNECT_TIMEOUT)}s (is '{server['command']}' installed? first npx run downloads the package)"
            await self._drop(conn)
        return conn

    async def _drop(self, conn: _Connection) -> None:
        conn.close.set()
        if conn.task:
            try:
                await asyncio.wait_for(asyncio.shield(conn.task), 5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                conn.task.cancel()
        self._conns.pop(conn.server["id"], None)

    async def tool_configs(self) -> tuple[list[dict[str, Any]], list[str]]:
        configs: list[dict[str, Any]] = []
        warnings: list[str] = []
        for meta in db.list_mcp_servers():
            if not meta["enabled"]:
                continue
            server = db.get_mcp_server(meta["id"])
            if not server:
                continue
            conn = await self._ensure(server)
            if conn.error or conn.session is None:
                warnings.append(f"MCP '{server['name']}' unavailable: {conn.error or 'not connected'}")
                continue
            for t in conn.tools:
                fname = f"mcp__{_slug(server['name'])}__{t.name}"[:64]
                configs.append(
                    {
                        "type": "function",
                        "function": {
                            "name": fname,
                            "description": (_attr(t, "description") or f"{server['name']}: {t.name}")[:1024],
                            "parameters": _attr(t, "input_schema", "inputSchema") or {"type": "object", "properties": {}},
                        },
                    }
                )
        return configs, warnings

    async def call_tool(self, prefixed_name: str, arguments: dict[str, Any]) -> str:
        parts = prefixed_name.split("__", 2)
        if len(parts) != 3:
            return f"Error: bad MCP tool name '{prefixed_name}'"
        slug, tool_name = parts[1], parts[2]
        server = None
        for meta in db.list_mcp_servers():
            if meta["enabled"] and _slug(meta["name"]) == slug:
                server = db.get_mcp_server(meta["id"])
                break
        if not server:
            return f"Error: MCP server '{slug}' is not configured or disabled"

        for attempt in (1, 2):
            conn = await self._ensure(server)
            if conn.error or conn.session is None:
                if attempt == 1:
                    await self._drop(conn)
                    continue
                return f"Error: MCP server '{server['name']}' unavailable: {conn.error or 'not connected'}"
            try:
                res = await conn.session.call_tool(tool_name, arguments, read_timeout_seconds=CALL_TIMEOUT)
                chunks: list[str] = []
                for item in _attr(res, "content", default=[]) or []:
                    text = _attr(item, "text")
                    if text is not None:
                        chunks.append(str(text))
                    elif _attr(item, "type") == "image":
                        chunks.append("[image content omitted]")
                    else:
                        data = _attr(item, "resource")
                        if data is not None:
                            chunks.append(str(_attr(data, "text", default=data)))
                out = "\n".join(chunks) or "(empty result)"
                if _attr(res, "is_error", "isError", default=False):
                    return f"Error: {out}"
                return out
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                await self._drop(conn)
                if attempt == 1:
                    continue
                return f"Error: MCP call failed: {type(e).__name__}: {e}"
        return "Error: MCP call failed"

    async def test(self, command: str, args: list[str], env: dict[str, str]) -> list[dict[str, Any]]:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        params = StdioServerParameters(
            command=_resolve_command(command), args=args, env={**os.environ, **(env or {})}
        )

        async def _probe() -> list[dict[str, Any]]:
            async with stdio_client(params, errlog=open(os.devnull, "w")) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    res = await session.list_tools()
                    return [
                        {"name": t.name, "description": (_attr(t, "description") or "")[:200]}
                        for t in res.tools
                    ]

        return await asyncio.wait_for(_probe(), CONNECT_TIMEOUT)

    async def invalidate(self, server_id: int) -> None:
        conn = self._conns.get(server_id)
        if conn:
            await self._drop(conn)

    async def shutdown(self) -> None:
        for conn in list(self._conns.values()):
            conn.close.set()
        for conn in list(self._conns.values()):
            if conn.task:
                try:
                    await asyncio.wait_for(conn.task, 5.0)
                except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    conn.task.cancel()
        self._conns.clear()


manager = MCPManager()