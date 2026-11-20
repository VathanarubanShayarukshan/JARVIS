"""JARVIS server: API + built-in web UI.

End users need NO API key. The self-hoster configures a free-tier provider
(Gemini / Groq / OpenRouter) server-side; everyone else just logs in.
"""

from __future__ import annotations

import json
import re
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import commands as commands_mod
from . import database as db
from . import jobs as jobs_mod
from . import projects as projects_mod
from .config import settings
from .llm import LLMError, detect_free_providers, from_env_provider, probe, shared_client
from .mcp import manager as mcp_manager, presets as mcp_presets
from .presets import preset_hint
from .skills import (
    delete_skill,
    get_skill_content,
    list_skills,
    save_skill,
    slugify,
    valid_id,
)

WEBUI_DIR = Path(__file__).resolve().parent.parent / "webui"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    jobs_mod.manager.init()
    shared_client()
    token = db.get_setting("telegram_token")
    enabled = db.get_setting("telegram_enabled") == "1"
    if token and enabled:
        try:
            from .telegram import bot_status, start_bot

            await start_bot(token)
            me = bot_status().get("me") or {}
            print(f"[telegram] bot running as @{me.get('username', '?')}")
        except Exception as e:  # noqa: BLE001
            print(f"[telegram] failed to start: {e}")
    yield
    await jobs_mod.manager.shutdown()
    await mcp_manager.shutdown()


app = FastAPI(title=settings.app_name, docs_url=None, redoc_url=None, lifespan=lifespan)


# --------------------------------------------------------------------------
# auth
# --------------------------------------------------------------------------

def _web_token() -> str | None:
    return db.get_setting("web_token")


def _admin_password() -> str | None:
    stored = db.get_setting("admin_password")
    return stored or (settings.admin_token or None)


def setup_done() -> bool:
    return _admin_password() is not None


def _unauthorized() -> HTTPException:
    return HTTPException(status_code=401, detail="unauthorized: login first")


def require_web(authorization: str | None = Header(default=None)) -> None:
    if settings.open_access:
        return
    token = (authorization or "").removeprefix("Bearer ").strip()
    if not token or token != _web_token():
        raise _unauthorized()


def require_any(authorization: str | None = Header(default=None)) -> None:
    if settings.open_access:
        return
    if authorization is None:
        raise _unauthorized()
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise _unauthorized()
    if token == _web_token() or db.token_exists(token):
        return
    raise _unauthorized()


# --------------------------------------------------------------------------
# api routes: meta / auth
# --------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "app": settings.app_name,
        "setup_done": setup_done(),
        "workspace": str(settings.workspace),
    }


@app.post("/api/auth/setup")
def setup(body: dict[str, Any]) -> dict[str, str]:
    password = str(body.get("password") or "").strip()
    if len(password) < 4:
        raise HTTPException(status_code=400, detail="password must be at least 4 characters")
    if setup_done():
        raise HTTPException(status_code=403, detail="already configured")
    db.set_setting("admin_password", password)
    db.set_setting("web_token", secrets.token_urlsafe(32))
    return {"token": _web_token() or ""}


@app.post("/api/auth/login")
def login(body: dict[str, Any]) -> dict[str, str]:
    password = str(body.get("password") or "")
    if not setup_done():
        raise HTTPException(status_code=400, detail="no password configured yet: call /api/auth/setup")
    if password != _admin_password():
        raise HTTPException(status_code=401, detail="wrong password")
    token = _web_token()
    if not token:
        token = secrets.token_urlsafe(32)
        db.set_setting("web_token", token)
    return {"token": token}


@app.post("/api/auth/change-password", dependencies=[Depends(require_web)])
def change_password(body: dict[str, Any]) -> dict[str, str]:
    new = str(body.get("password") or "").strip()
    if len(new) < 4:
        raise HTTPException(status_code=400, detail="password too short")
    db.set_setting("admin_password", new)
    return {"ok": "changed"}


# --------------------------------------------------------------------------
# providers
# --------------------------------------------------------------------------

@app.get("/api/providers", dependencies=[Depends(require_web)])
async def list_providers() -> list[dict[str, Any]]:
    providers = db.list_providers()
    local = await detect_free_providers()
    for p in local:
        providers.append(
            {
                "id": p.id,
                "name": p.name,
                "base_url": p.base_url,
                "api_key": None,
                "api_key_set": False,
                "models": p.models,
                "hint": "Local LLM detected on the server (no key)",
                "is_custom": 0,
                "local": True,
            }
        )
    return providers


@app.post("/api/providers/probe")
async def probe_provider(body: dict[str, Any]) -> dict[str, Any]:
    base_url = str(body.get("base_url") or "").strip()
    key = str(body.get("api_key") or "").strip() or None
    if not base_url:
        raise HTTPException(status_code=400, detail="base_url required")
    models = await probe(base_url, key)
    if models is None:
        raise HTTPException(status_code=400, detail="cannot reach provider at that URL with the given key")
    return {"models": models}


@app.post("/api/providers", dependencies=[Depends(require_web)])
def add_provider(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name") or "").strip()
    base_url = str(body.get("base_url") or "").strip()
    if not name or not base_url:
        raise HTTPException(status_code=400, detail="name and base_url required")
    models = body.get("models") or []
    pid = db.add_provider(name, base_url, str(body.get("api_key") or ""), models)
    return {"id": pid}


@app.put("/api/providers/{provider_id}", dependencies=[Depends(require_web)])
def update_provider(provider_id: int, body: dict[str, Any]) -> dict[str, str]:
    p = db.get_provider(provider_id)
    if not p:
        raise HTTPException(status_code=404, detail="provider not found")
    name = str(body.get("name") or p["name"] or "").strip()
    base_url = str(body.get("base_url") or p["base_url"] or "").strip()
    models = body.get("models") or (json.loads(p["models"]) if p.get("models") else [])
    key = body.get("api_key")
    if key == "":  # explicit clear
        key = ""
    elif key is None:
        key = p.get("api_key") or ""
    db.update_provider(provider_id, name, base_url, key, models, p.get("hint") or preset_hint(name))
    return {"ok": "saved"}


@app.delete("/api/providers/{provider_id}", dependencies=[Depends(require_web)])
def delete_provider(provider_id: int) -> dict[str, str]:
    p = db.get_provider(provider_id)
    if not p:
        raise HTTPException(status_code=404, detail="provider not found")
    if not p["is_custom"]:
        raise HTTPException(status_code=403, detail="built-in provider: disable it by not setting a key")
    db.delete_provider(provider_id)
    return {"ok": "deleted"}


# --------------------------------------------------------------------------
# sessions + chat
# --------------------------------------------------------------------------

@app.get("/api/sessions", dependencies=[Depends(require_any)])
def sessions() -> list[dict[str, Any]]:
    return db.list_sessions()


@app.post("/api/sessions", dependencies=[Depends(require_any)])
def create_session(body: dict[str, Any] | None = None) -> dict[str, Any]:
    sid = uuid.uuid4().hex
    project_id = str((body or {}).get("project_id") or "").strip() or None
    if project_id and not db.get_project(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    db.create_session(sid, "New chat", project_id)
    return db.get_session(sid) or {}


@app.post("/api/sessions/{session_id}/project", dependencies=[Depends(require_any)])
def set_session_project(session_id: str, body: dict[str, Any]) -> dict[str, str]:
    if not db.get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    project_id = str(body.get("project_id") or "").strip() or None
    if project_id and not db.get_project(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    db.set_session_project(session_id, project_id)
    return {"ok": "saved"}


@app.get("/api/sessions/{session_id}/messages", dependencies=[Depends(require_any)])
def session_messages(session_id: str) -> list[dict[str, Any]]:
    if not db.get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    return db.list_messages(session_id)


@app.delete("/api/sessions/{session_id}", dependencies=[Depends(require_any)])
def delete_session(session_id: str) -> dict[str, str]:
    if not db.delete_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    return {"ok": "deleted"}


@app.post("/api/sessions/{session_id}/title", dependencies=[Depends(require_any)])
def set_title(session_id: str, body: dict[str, Any]) -> dict[str, str]:
    if not db.get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")
    title = str(body.get("title") or "New chat").strip()[:120]
    db.set_session_title(session_id, title)
    return {"ok": "saved"}


@app.post("/api/sessions/{session_id}/stop", dependencies=[Depends(require_any)])
async def stop_session(session_id: str) -> dict[str, Any]:
    """Cancel the agent task itself, not just the stream the client is reading."""
    job = jobs_mod.manager.running_for_session(session_id)
    if not job:
        return {"ok": False, "job_id": None}
    ok = await jobs_mod.manager.stop(job.id)
    return {"ok": ok, "job_id": job.id}


# --------------------------------------------------------------------------
# ui preferences — stored server-side so every device shares one setup
# --------------------------------------------------------------------------

@app.get("/api/preferences", dependencies=[Depends(require_any)])
def preferences_get() -> dict[str, Any]:
    return db.get_ui_prefs()


@app.put("/api/preferences", dependencies=[Depends(require_any)])
def preferences_put(body: dict[str, Any]) -> dict[str, Any]:
    return db.update_ui_prefs(body or {})


def _resolve_provider(provider_id: str | None) -> Any:
    """Resolve a Provider from the DB (raw keys), env config, or a local LLM."""
    from .llm import Provider

    db_providers: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for p in db.list_providers():
        raw = db.get_provider(p["id"]) or {}
        db_providers.append((p, raw))

    def make(meta: dict[str, Any], key: str | None, model_list: list[str]) -> Provider:
        return Provider(
            id=str(meta.get("id", "?")),
            name=meta.get("name", "?"),
            base_url=meta.get("base_url", ""),
            api_key=key or (settings.provider_api_key or None),
            models=model_list,
        )

    if provider_id:
        for meta, raw in db_providers:
            if str(meta["id"]) == str(provider_id):
                key = raw.get("api_key")
                if not key and meta.get("is_custom") == 0:
                    if str(meta.get("base_url", "")).startswith("builtin://"):
                        return make(meta, None, meta.get("models") or [])
                    raise LLMError(
                        f"Provider '{meta['name']}' has no API key yet. "
                        "A host/admin must add a (free) key in Settings | Models."
                    )
                return make(meta, key, meta.get("models") or [])
        env = next((p for p in from_env_provider() if str(p.id) == str(provider_id)), None)
        if env:
            return env
        raise LLMError("provider not found")

    for meta, raw in db_providers:
        key = raw.get("api_key")
        if key:
            return make(meta, key, meta.get("models") or [])

    local = detect_free_providers_sync()
    if local:
        p = local[0]
        return Provider(id=p.id, name=p.name, base_url=p.base_url, api_key=None, models=p.models)

    tiny = next(
        (meta for meta, _raw in db_providers if str(meta.get("base_url", "")).startswith("builtin://")),
        None,
    )
    if tiny:
        return make(tiny, None, tiny.get("models") or [])

    raise LLMError(
        "No model provider with an API key is configured (TinyAI built-in is also unset). "
        "Go to Settings | Models and add a free key (Gemini / Groq / OpenRouter) or pick TinyAI."
    )


def detect_free_providers_sync() -> list[Any]:
    """Detection helpers are async; run them on a throwaway loop for sync callers."""
    import asyncio

    try:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(detect_free_providers())
        finally:
            loop.close()
    except Exception:
        return []


@app.post("/api/chat")
async def chat(body: dict[str, Any], authorization: str | None = Header(default=None)):
    require_any(authorization)
    session_id = str(body.get("session_id") or "")
    message = str(body.get("message") or "").strip()
    if not session_id or not message:
        raise HTTPException(status_code=400, detail="session_id and message required")
    session = db.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    if jobs_mod.manager.running_for_session(session_id):
        return JSONResponse(status_code=409, content={"detail": "a task is already running in this chat — resume or stop it first"})

    if (session.get("title") or "").strip() in ("", "New chat"):
        db.set_session_title(session_id, commands_mod.title_from(message))

    try:
        provider = _resolve_provider(body.get("provider_id"))
    except LLMError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

    model = str(body.get("model") or settings.default_model or (provider.models[0] if provider.models else "")).strip()
    if not model:
        return JSONResponse(status_code=400, content={"detail": "no model selected"})

    parsed = commands_mod.parse(message)
    explicit_skill = str(body.get("skill") or "").strip()
    skill_ids = list(dict.fromkeys(([explicit_skill] if explicit_skill else []) + parsed["skills"]))
    skill_body = commands_mod.skill_block(skill_ids) or None

    attach = body.get("attachments") or []
    attach = [str(a).strip() for a in attach if str(a).strip()]
    if attach:
        message = ("The user attached these files (read them with the read_file tool as needed):\n"
                   + "\n".join(f"- {a}" for a in attach)
                   + "\n\n---\n\nTask:\n" + message)

    effective = message
    if skill_body:
        effective = f"{skill_body}\n\n---\n\nTask:\n{message}"
    extra_system = "\n\n".join(
        part for part in (
            projects_mod.build_context(session.get("project_id")),
            commands_mod.mcp_block(parsed["servers"]),
        ) if part
    ) or None

    job = jobs_mod.manager.start(session_id, provider, model, effective, extra_system)

    async def stream():
        try:
            async for ev in jobs_mod.manager.follow(job):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except Exception as e:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'message': f'{type(e).__name__}: {e}'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


# --------------------------------------------------------------------------
# background jobs: push / resume / stop
# --------------------------------------------------------------------------

@app.get("/api/jobs", dependencies=[Depends(require_any)])
def list_jobs() -> list[dict[str, Any]]:
    rows = db.list_jobs()
    for r in rows:
        live = jobs_mod.manager.get(r["id"])
        if live:
            r["status"] = live.status
    return rows


@app.get("/api/jobs/{job_id}/stream")
async def job_stream(job_id: str, after: int = 0, authorization: str | None = Header(default=None)):
    require_any(authorization)
    if not db.get_job(job_id):
        raise HTTPException(status_code=404, detail="job not found")

    async def stream():
        async for ev in jobs_mod.manager.replay(job_id, max(0, after)):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/jobs/{job_id}/stop", dependencies=[Depends(require_any)])
async def job_stop(job_id: str) -> dict[str, Any]:
    if not db.get_job(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    ok = await jobs_mod.manager.stop(job_id)
    return {"ok": ok}


@app.get("/api/models", dependencies=[Depends(require_any)])
def models() -> dict[str, Any]:
    default = settings.default_model
    return {"default_model": default}


@app.get("/api/skills", dependencies=[Depends(require_any)])
def skills() -> list[dict[str, Any]]:
    return list_skills()


@app.get("/api/skills/{skill_id}", dependencies=[Depends(require_any)])
def skill_content(skill_id: str) -> dict[str, Any]:
    content = get_skill_content(skill_id)
    if content is None:
        raise HTTPException(status_code=404, detail="skill not found")
    return {"id": skill_id, "content": content}


@app.post("/api/skills", dependencies=[Depends(require_web)])
def create_skill(body: dict[str, Any]) -> dict[str, str]:
    content = str(body.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content required")
    sid = str(body.get("id") or "").strip().lower() or slugify(str(body.get("title") or ""))
    if not valid_id(sid):
        raise HTTPException(status_code=400, detail="id must be lowercase letters, digits and dashes")
    if get_skill_content(sid) is not None:
        raise HTTPException(status_code=409, detail="a skill with that id already exists")
    save_skill(sid, content)
    return {"id": sid}


@app.put("/api/skills/{skill_id}", dependencies=[Depends(require_web)])
def update_skill(skill_id: str, body: dict[str, Any]) -> dict[str, str]:
    content = str(body.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content required")
    if get_skill_content(skill_id) is None:
        raise HTTPException(status_code=404, detail="skill not found")
    save_skill(skill_id, content)
    return {"ok": "saved"}


@app.delete("/api/skills/{skill_id}", dependencies=[Depends(require_web)])
def remove_skill(skill_id: str) -> dict[str, str]:
    if not delete_skill(skill_id):
        raise HTTPException(status_code=404, detail="skill not found")
    return {"ok": "deleted"}


# --------------------------------------------------------------------------
# MCP servers (custom + ready-made npx presets)
# --------------------------------------------------------------------------

def _mcp_fields(body: dict[str, Any]) -> tuple[str, str, list[str], dict[str, str], str]:
    name = str(body.get("name") or "").strip()[:60]
    command = str(body.get("command") or "").strip()
    url = str(body.get("url") or "").strip()
    args = [str(a) for a in (body.get("args") or []) if str(a).strip()]
    env_raw = body.get("env") or {}
    if not isinstance(env_raw, dict):
        raise HTTPException(status_code=400, detail="env must be an object of KEY: value")
    env = {str(k): str(v) for k, v in env_raw.items()}
    if url and not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="url must start with http:// or https://")
    if not name or (not command and not url):
        raise HTTPException(status_code=400, detail="name and command (or url) required")
    return name, command, args, env, url


@app.get("/api/mcp", dependencies=[Depends(require_any)])
def mcp_list() -> dict[str, Any]:
    return {"servers": db.list_mcp_servers(), "presets": mcp_presets()}


@app.get("/api/mcp/tools", dependencies=[Depends(require_any)])
async def mcp_tools(connect: int = 0) -> dict[str, Any]:
    return {"servers": await mcp_manager.catalog(connect=bool(connect))}


@app.post("/api/mcp", dependencies=[Depends(require_web)])
def mcp_add(body: dict[str, Any]) -> dict[str, Any]:
    name, command, args, env, url = _mcp_fields(body)
    sid = db.add_mcp_server(name, command, args, env, url)
    return {"id": sid}


@app.put("/api/mcp/{server_id}", dependencies=[Depends(require_web)])
async def mcp_update(server_id: int, body: dict[str, Any]) -> dict[str, str]:
    cur = db.get_mcp_server(server_id)
    if not cur:
        raise HTTPException(status_code=404, detail="MCP server not found")
    name = str(body.get("name") or cur["name"]).strip()[:60]
    command = str(body.get("command") or cur["command"]).strip()
    url = str(body["url"] if "url" in body else cur.get("url") or "").strip()
    args = [str(a) for a in body["args"]] if "args" in body else cur["args"]
    env = None
    if "env" in body and isinstance(body["env"], dict):
        env = {str(k): str(v) for k, v in body["env"].items()}
    enabled = bool(body.get("enabled", cur["enabled"]))
    if url and not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="url must start with http:// or https://")
    if not command and not url:
        raise HTTPException(status_code=400, detail="command or url required")
    db.update_mcp_server(server_id, name, command, args, env, enabled, url)
    await mcp_manager.invalidate(server_id)
    return {"ok": "saved"}


@app.delete("/api/mcp/{server_id}", dependencies=[Depends(require_web)])
async def mcp_delete(server_id: int) -> dict[str, str]:
    await mcp_manager.invalidate(server_id)
    if not db.delete_mcp_server(server_id):
        raise HTTPException(status_code=404, detail="MCP server not found")
    return {"ok": "deleted"}


@app.post("/api/mcp/test", dependencies=[Depends(require_web)])
async def mcp_test(body: dict[str, Any]) -> dict[str, Any]:
    name, command, args, env, url = _mcp_fields(body)
    try:
        tools = await mcp_manager.test(command, args, env, url)
        return {"ok": True, "tools": tools}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.post("/api/mcp/{server_id}/test", dependencies=[Depends(require_web)])
async def mcp_test_saved(server_id: int) -> dict[str, Any]:
    cur = db.get_mcp_server(server_id)
    if not cur:
        raise HTTPException(status_code=404, detail="MCP server not found")
    try:
        tools = await mcp_manager.test(cur["command"], cur["args"], cur["env"], cur.get("url") or "")
        return {"ok": True, "tools": tools}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# --------------------------------------------------------------------------
# projects + knowledge context
# --------------------------------------------------------------------------

@app.get("/api/projects", dependencies=[Depends(require_any)])
def projects_list() -> list[dict[str, Any]]:
    return db.list_projects()


def _project_style(body: dict[str, Any], cur: dict[str, Any] | None = None) -> tuple[str, str]:
    cur = cur or {}
    icon = str(body["icon"] if "icon" in body else cur.get("icon") or "").strip()[:8]
    color = str(body["color"] if "color" in body else cur.get("color") or "").strip()
    if any(c in icon for c in "<>&\"'"):
        raise HTTPException(status_code=400, detail="icon must be a plain emoji or character")
    if color and not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        raise HTTPException(status_code=400, detail="color must be a hex value like #4f8cff")
    return icon, color.lower()


@app.post("/api/projects", dependencies=[Depends(require_any)])
def projects_create(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name") or "").strip()[:80]
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    icon, color = _project_style(body)
    pid = projects_mod.new_id()
    db.create_project(pid, name, str(body.get("instructions") or ""), icon, color)
    return db.get_project(pid) or {}


@app.get("/api/projects/{project_id}", dependencies=[Depends(require_any)])
def projects_get(project_id: str) -> dict[str, Any]:
    p = db.get_project(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="project not found")
    p["files"] = db.list_project_files(project_id)
    return p


@app.put("/api/projects/{project_id}", dependencies=[Depends(require_any)])
def projects_update(project_id: str, body: dict[str, Any]) -> dict[str, str]:
    p = db.get_project(project_id)
    if not p:
        raise HTTPException(status_code=404, detail="project not found")
    name = str(body.get("name") or p["name"]).strip()[:80]
    instructions = str(body.get("instructions") if "instructions" in body else p["instructions"] or "")
    icon, color = _project_style(body, p)
    db.update_project(project_id, name, instructions, icon, color)
    return {"ok": "saved"}


@app.delete("/api/projects/{project_id}", dependencies=[Depends(require_any)])
def projects_delete(project_id: str) -> dict[str, str]:
    if not db.delete_project(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    return {"ok": "deleted"}


@app.post("/api/projects/{project_id}/files", dependencies=[Depends(require_any)])
def projects_add_file(project_id: str, body: dict[str, Any]) -> dict[str, Any]:
    if not db.get_project(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    name = str(body.get("name") or "").strip()[:120]
    content = str(body.get("content") or "")
    if not name or not content.strip():
        raise HTTPException(status_code=400, detail="name and content required")
    if len(content) > 200_000:
        raise HTTPException(status_code=400, detail="knowledge file too large (max 200 KB of text)")
    fid = db.add_project_file(project_id, name, content)
    return {"id": fid}


@app.get("/api/projects/{project_id}/files/{file_id}", dependencies=[Depends(require_any)])
def projects_file_content(project_id: str, file_id: int) -> dict[str, Any]:
    f = db.get_project_file(file_id)
    if not f or f["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="file not found")
    return f


@app.delete("/api/projects/{project_id}/files/{file_id}", dependencies=[Depends(require_any)])
def projects_delete_file(project_id: str, file_id: int) -> dict[str, str]:
    f = db.get_project_file(file_id)
    if not f or f["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="file not found")
    db.delete_project_file(file_id)
    return {"ok": "deleted"}


# --------------------------------------------------------------------------
# api tokens (for external tools / web apps using this agent's API)
# --------------------------------------------------------------------------

@app.get("/api/tokens", dependencies=[Depends(require_web)])
def tokens() -> list[dict[str, Any]]:
    return db.list_tokens()


@app.post("/api/tokens", dependencies=[Depends(require_web)])
def create_token(body: dict[str, Any]) -> dict[str, str]:
    name = str(body.get("name") or "api-token").strip()[:60] or "api-token"
    token = secrets.token_urlsafe(32)
    db.create_token(name, token)
    return {"name": name, "token": token}


@app.delete("/api/tokens/{token_id}", dependencies=[Depends(require_web)])
def delete_token(token_id: int) -> dict[str, str]:
    if not db.delete_token(token_id):
        raise HTTPException(status_code=404, detail="token not found")
    return {"ok": "deleted"}


# --------------------------------------------------------------------------
# integrations (Telegram via BotFather + WhatsApp)
# --------------------------------------------------------------------------

def _integrations_status() -> dict[str, Any]:
    from .telegram import bot_status

    tg = {"configured": bool(db.get_setting("telegram_token")),
          "enabled": db.get_setting("telegram_enabled") == "1"}
    tg.update(bot_status())
    wa = {
        "readme": (Path(__file__).resolve().parent.parent / "whatsapp" / "README.md").exists(),
        "bridge_up": False,
        "state": "offline",
        "connected": False,
        "user": None,
        "qr": None,
        "pairCode": None,
        "pairNumber": None,
        "events": [],
    }
    try:
        import httpx

        r = httpx.get("http://127.0.0.1:9511/status", timeout=2.0)
        if r.status_code == 200:
            j = r.json()
            wa["bridge_up"] = True
            wa.update({k: j.get(k) for k in ("state", "connected", "user", "qr", "pairCode", "pairNumber", "events")})
    except Exception:
        pass
    return {"telegram": tg, "whatsapp": wa}


@app.get("/api/integrations", dependencies=[Depends(require_web)])
def integrations() -> dict[str, Any]:
    return _integrations_status()


@app.post("/api/integrations/telegram", dependencies=[Depends(require_web)])
async def set_telegram(body: dict[str, Any]) -> dict[str, Any]:
    token = str(body.get("token") or "").strip()
    enabled = bool(body.get("enabled"))
    if token:
        db.set_setting("telegram_token", token)
    db.set_setting("telegram_enabled", "1" if enabled else "0")
    token = token or db.get_setting("telegram_token") or ""
    from .telegram import start_bot, stop_bot

    if enabled and token:
        try:
            await start_bot(token)
            return _integrations_status()
        except Exception as e:  # noqa: BLE001
            return {"error": f"{type(e).__name__}: {e}", **_integrations_status()}
    await stop_bot()
    return _integrations_status()


@app.post("/api/integrations/whatsapp/logout", dependencies=[Depends(require_web)])
def whatsapp_logout() -> dict[str, Any]:
    try:
        import httpx

        r = httpx.post("http://127.0.0.1:9511/logout", timeout=5.0)
        return {"ok": r.status_code == 200}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


@app.post("/api/integrations/whatsapp/pair", dependencies=[Depends(require_web)])
def whatsapp_pair(body: dict[str, Any]) -> dict[str, Any]:
    number = str(body.get("number") or "").strip()
    if not number.isdigit():
        raise HTTPException(status_code=400, detail="number with country code required, digits only")
    try:
        import httpx

        r = httpx.post("http://127.0.0.1:9511/pair", json={"number": number}, timeout=25.0)
        return r.json()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


# --------------------------------------------------------------------------
# workspace files (web UI file browser)
# --------------------------------------------------------------------------

def _fs_resolve(path: str) -> Path:
    p = (settings.workspace / path.lstrip("/\\")).resolve()
    if not p.is_relative_to(settings.workspace):
        raise HTTPException(status_code=400, detail="path escapes workspace")
    return p


@app.get("/api/files", dependencies=[Depends(require_any)])
def list_files(path: str = "") -> dict[str, Any]:
    p = _fs_resolve(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="not found")
    entries = []
    try:
        children = sorted(p.iterdir(), key=lambda c: (c.is_file(), c.name.lower()))
    except OSError:
        children = []
    for c in children:
        rel = str(c.relative_to(settings.workspace)).replace("\\", "/")
        entries.append(
            {
                "name": c.name,
                "path": rel,
                "type": "dir" if c.is_dir() else "file",
                "size": c.stat().st_size if c.is_file() else None,
            }
        )
    return {"path": str(path), "entries": entries}


@app.get("/api/files/content", dependencies=[Depends(require_any)])
def file_content(path: str) -> dict[str, Any]:
    p = _fs_resolve(path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    if p.stat().st_size > 500_000:
        return {"error": "file too large to view", "path": str(path)}
    return {"path": str(path), "content": p.read_text(encoding="utf-8", errors="replace")}


@app.post("/api/files/write", dependencies=[Depends(require_any)])
def file_write(body: dict[str, Any]) -> dict[str, str]:
    path = str(body.get("path") or "")
    content = body.get("content") or ""
    p = _fs_resolve(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(content), encoding="utf-8")
    return {"ok": "saved", "path": str(path)}


@app.post("/api/files/mkdir", dependencies=[Depends(require_any)])
def file_mkdir(body: dict[str, Any]) -> dict[str, str]:
    p = _fs_resolve(str(body.get("path") or ""))
    p.mkdir(parents=True, exist_ok=True)
    return {"ok": "created", "path": str(p)}


@app.post("/api/files/upload", dependencies=[Depends(require_any)])
async def file_upload(request: Request) -> dict[str, Any]:
    form = await request.form()
    target = _fs_resolve(str(form.get("path") or ""))
    target.mkdir(parents=True, exist_ok=True)
    saved: list[str] = []
    for part in form.getlist("file"):
        name = Path(getattr(part, "filename", None) or "file").name
        dest = (target / name).resolve()
        if not dest.is_relative_to(settings.workspace):
            raise HTTPException(status_code=400, detail="file name escapes workspace")
        with dest.open("wb") as out:
            while chunk := await part.read(1_048_576):
                out.write(chunk)
        saved.append(str(dest.relative_to(settings.workspace)).replace("\\", "/"))
    return {"ok": f"saved {len(saved)} file(s)", "files": saved}


@app.get("/api/files/download", dependencies=[Depends(require_any)])
def file_download(path: str) -> FileResponse:
    p = _fs_resolve(path)
    if not p.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    return FileResponse(p, filename=p.name)


# --------------------------------------------------------------------------
# static web ui
# --------------------------------------------------------------------------

@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEBUI_DIR / "index.html")


@app.get("/voice")
def voice_page() -> FileResponse:
    return FileResponse(WEBUI_DIR / "voice.html")


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/assets", "/")):
        response.headers["Cache-Control"] = "no-store"
    return response


def mount_static() -> None:
    if (WEBUI_DIR / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=WEBUI_DIR / "assets"), name="assets")


mount_static()


def main() -> None:
    import uvicorn

    db.init_db()
    have_password = bool(db.get_setting("admin_password")) or bool(settings.admin_token)
    if not have_password:
        print("=" * 60)
        print(" JARVIS is starting. No password is configured.")
        print(" Open the web UI and set an admin password (first-time setup).")
        print("=" * 60)
    print(f" JARVIS web UI + API:  http://127.0.0.1:{settings.port}")
    print(f" Workspace folder:        {settings.workspace}")
    uvicorn.run(app, host="0.0.0.0", port=settings.port, log_level="info")


if __name__ == "__main__":
    main()