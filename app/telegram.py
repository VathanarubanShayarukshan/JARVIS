"""Telegram bot (via BotFather).

Mirrors the WhatsApp `.agent` flow: walks a task through the same
`run_agent` loop, so the bot and the web app share one session DB.

The token is created with BotFather (https://t.me/BotFather), stored in the
DB settings, and the polling loop is started/stopped from the web app's
Integrations tab (or automatically on server start when enabled).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import httpx

from .config import settings

API = "https://api.telegram.org/bot{token}/{method}"
MAX_CHUNK = 3900


class TelegramBot:
    def __init__(self, token: str):
        self.token = token
        self._client: httpx.AsyncClient | None = None
        self._task: asyncio.Task | None = None
        self._offset = 0
        self._running = False
        self._me: dict[str, Any] = {}
        self._stops: set[int] = set()
        self._sessions: dict[int, str] = {}
        self._busy: set[int] = set()

    @property
    def running(self) -> bool:
        return self._running

    async def start(self) -> None:
        self._client = httpx.AsyncClient(timeout=30.0)
        try:
            data = await self._call("getMe")
            self._me = data.get("result") or {}
        except Exception:
            self._me = {}
        self._running = True
        self._task = asyncio.create_task(self._poll())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self._client:
            try:
                await self._client.aclose()
            except Exception:
                pass
            self._client = None

    async def _call(self, method: str, **params: Any) -> dict[str, Any]:
        url = API.format(token=self.token, method=method)
        assert self._client is not None
        r = await self._client.post(url, json=params)
        return r.json()

    async def _poll(self) -> None:
        while self._running:
            try:
                data = await self._call(
                    "getUpdates",
                    offset=self._offset,
                    timeout=25,
                    allowed_updates=["message"],
                )
                for up in data.get("result", []):
                    self._offset = int(up["update_id"]) + 1
                    asyncio.create_task(self._handle(up.get("message") or {}))
            except asyncio.CancelledError:
                break
            except Exception:
                if not self._running:
                    break
                await asyncio.sleep(3)

    async def _handle(self, msg: dict[str, Any]) -> None:
        chat_id = int(msg.get("chat", {}).get("id", 0))
        if not chat_id:
            return
        text = (msg.get("text") or "").strip()
        if not text:
            return
        if text.startswith("/"):
            parts = text.split(maxsplit=1)
            cmd = parts[0].lower()
            arg = (parts[1] if len(parts) > 1 else "").strip()
            if cmd in ("/start", "/help"):
                await self._send(chat_id, self.help_text())
            elif cmd == "/new":
                self._sessions.pop(chat_id, None)
                await self._send(chat_id, "New session. Send /agent <task> or just type your task.")
            elif cmd == "/stop":
                self._stops.add(chat_id)
                await self._send(chat_id, "⏹ stopping current task…")
            elif cmd == "/agent":
                if not arg:
                    await self._send(chat_id, "Usage: /agent <task>\nExample: /agent list the files and summarize")
                    return
                if chat_id in self._busy:
                    await self._send(chat_id, "still busy — use /stop first")
                    return
                self._stops.discard(chat_id)
                asyncio.create_task(self._run_agent(chat_id, arg))
            elif cmd == "/providers":
                await self._send(chat_id, self._providers_text())
            else:
                await self._send(chat_id, self.help_text())
            return

        if chat_id in self._busy:
            await self._send(chat_id, "still busy — use /stop or wait")
            return
        self._stops.discard(chat_id)
        asyncio.create_task(self._run_agent(chat_id, text))

    async def _run_agent(self, chat_id: int, task_text: str) -> None:
        self._busy.add(chat_id)
        try:
            from . import database as db
            from .agent import run_agent
            from .llm import Provider

            provider = self._default_provider()
            model = settings.default_model or (provider.models[0] if provider.models else "tiny-answer-bot")

            session_id = self._sessions.get(chat_id)
            if not session_id or not db.get_session(session_id):
                session_id = uuid.uuid4().hex
                db.create_session(session_id, task_text[:48])
                self._sessions[chat_id] = session_id

            await self._send(chat_id, "🤖 Thinking…")
            accrued = ""
            last_status = ""
            async for ev in run_agent(provider, model, session_id, task_text):
                if chat_id in self._stops:
                    break
                t = ev.get("type")
                if t == "status" and ev.get("message") and ev["message"] != last_status:
                    last_status = ev["message"]
                    await self._send(chat_id, f"🧠 {ev['message']}")
                elif t == "text":
                    accrued += ev.get("text", "")
                elif t == "tool_call":
                    name = ev.get("name", "tool")
                    args = ev.get("arguments") or {}
                    try:
                        argstr = json.dumps(args, ensure_ascii=False)
                    except Exception:
                        argstr = str(args)
                    if len(argstr) > 280:
                        argstr = argstr[:280] + "…"
                    await self._send(chat_id, f"⚙ Running {name} … {argstr}")
            if chat_id in self._stops:
                self._stops.discard(chat_id)
                await self._send(chat_id, "⏹ stopped.")
                return
            if not accrued.strip():
                accrued = "(no text output)"
            await self._send(chat_id, accrued)
        except Exception as e:  # noqa: BLE001
            await self._send(chat_id, f"⚠ Error: {type(e).__name__}: {e}")
        finally:
            self._busy.discard(chat_id)

    def _default_provider(self) -> Any:
        from . import database as db
        from .llm import Provider

        for p in db.list_providers():
            raw = db.get_provider(p["id"]) or {}
            key = raw.get("api_key")
            if key:
                return Provider(
                    id=str(p["id"]),
                    name=p["name"],
                    base_url=p["base_url"],
                    api_key=key,
                    models=p["models"] or [],
                )
        for p in db.list_providers():
            if str(p.get("base_url", "")).startswith("builtin://"):
                return Provider(
                    id=str(p["id"]),
                    name=p["name"],
                    base_url=p["base_url"],
                    api_key=None,
                    models=p["models"] or [],
                )
        raise RuntimeError(
            "No provider is configured. Add a free API key in the web app "
            "(Settings → Models) or pick TinyAI."
        )

    def _providers_text(self) -> str:
        from . import database as db

        lines = ["Model providers:"]
        for p in db.list_providers():
            raw = db.get_provider(p["id"]) or {}
            models = ", ".join((p["models"] or [])[:5]) or "-"
            lines.append(f"• {p['name']} — {'✓ key' if raw.get('api_key') else 'no key'} — {models}")
        return "\n".join(lines)

    async def _send(self, chat_id: int, text: str) -> None:
        text = (text or "").strip()
        for chunk in [text[i:i + MAX_CHUNK] for i in range(0, len(text), MAX_CHUNK)]:
            try:
                await self._call("sendMessage", chat_id=chat_id, text=chunk)
            except Exception:
                break

    def help_text(self) -> str:
        return (
            "🤖 *AgenticAI Telegram bot*\n\n"
            "• /agent <task> — run a task with the agent\n"
            "• or just type your task\n"
            "• /providers — list configured models\n"
            "• /new — start a fresh session\n"
            "• /stop — stop the current task\n"
            "• /help — this message\n\n"
            "The same agent that powers the web app runs here (shared sessions,"
            " files, skills)."
        )


_bot: TelegramBot | None = None


async def start_bot(token: str) -> None:
    global _bot
    if _bot and _bot.running:
        await _bot.stop()
    _bot = TelegramBot(token)
    await _bot.start()


async def stop_bot() -> None:
    global _bot
    if _bot:
        await _bot.stop()
        _bot = None


def bot_status() -> dict[str, Any]:
    if _bot is None:
        return {"running": False, "me": None}
    return {"running": _bot.running, "me": _bot._me or None}


def sync_start_bot(token: str) -> None:
    asyncio.run(start_bot(token))


def sync_stop_bot() -> None:
    asyncio.run(stop_bot())