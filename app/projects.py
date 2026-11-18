"""Projects: named instruction + knowledge packs attached to chat sessions."""

from __future__ import annotations

import uuid

from . import database as db

MAX_CONTEXT_CHARS = 30000


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def build_context(project_id: str | None) -> str:
    if not project_id:
        return ""
    p = db.get_project(project_id)
    if not p:
        return ""
    parts = [f"# Project: {p['name']}"]
    if (p.get("instructions") or "").strip():
        parts.append("Project instructions (follow them for every task in this chat):\n" + p["instructions"].strip())
    for f in db.list_project_files(project_id):
        full = db.get_project_file(f["id"])
        if not full:
            continue
        parts.append(f"## Knowledge file: {full['name']}\n{full['content']}")
    ctx = "\n\n".join(parts)
    if len(ctx) > MAX_CONTEXT_CHARS:
        ctx = ctx[:MAX_CONTEXT_CHARS] + "\n...[knowledge truncated — ask the user for specific files if needed]"
    return "\n\n---\n\n" + ctx