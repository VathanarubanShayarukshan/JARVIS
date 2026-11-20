"""Prompt commands typed in the chat box: /skill and @mcp-server.

The web composer offers both as autocomplete palettes, but resolution happens
here so the same syntax works from Telegram, WhatsApp and the raw API.
"""

from __future__ import annotations

import re
from typing import Any

from . import database as db
from .mcp import _slug
from .skills import load_skill

SKILL_RE = re.compile(r"(?<![\w/])/([a-z0-9][a-z0-9-]{0,60})", re.IGNORECASE)
MENTION_RE = re.compile(r"(?<![\w@])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,40})")


def parse(message: str) -> dict[str, Any]:
    text = str(message or "")
    skills: list[str] = []
    for m in SKILL_RE.finditer(text):
        sid = m.group(1).lower()
        if sid not in skills and load_skill(sid) is not None:
            skills.append(sid)

    servers: list[dict[str, Any]] = []
    known = {_slug(s["name"]).lower(): s for s in db.list_mcp_servers() if s["enabled"]}
    for m in MENTION_RE.finditer(text):
        slug = _slug(m.group(1)).lower()
        hit = known.get(slug)
        if hit and all(hit["id"] != s["id"] for s in servers):
            servers.append(hit)
    return {"skills": skills, "servers": servers}


def skill_block(skill_ids: list[str]) -> str:
    parts = []
    for sid in skill_ids:
        body = load_skill(sid)
        if body:
            parts.append(f"# Skill: {sid}\n{body}")
    return "\n\n".join(parts)


def mcp_block(servers: list[dict[str, Any]]) -> str:
    if not servers:
        return ""
    lines = [
        "The user explicitly asked for these MCP servers in this task — prefer their "
        "tools (named mcp__<server>__<tool>) over the built-in ones when they fit:"
    ]
    for s in servers:
        lines.append(f"- @{s['name']} (tool prefix mcp__{_slug(s['name'])}__)")
    return "\n".join(lines)


def title_from(message: str) -> str:
    text = SKILL_RE.sub(" ", str(message or ""))
    text = MENTION_RE.sub(" ", text)
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" -•\t")
    if not text:
        return "New chat"
    if len(text) <= 48:
        return text
    cut = text[:48]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,.;:") + "…"