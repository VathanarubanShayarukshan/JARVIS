"""AgenticAI server: API + built-in web UI.

End users need NO API key. The self-hoster configures a free-tier provider
(Gemini / Groq / OpenRouter) server-side; everyone else just logs in.
"""

from __future__ import annotations

import json
import secrets
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import database as db
from .agent import run_agent
from .config import settings
from .llm import LLMError, detect_free_providers, from_env_provider, probe
from .presets import preset_hint
from .skills import list_skills, load_skill

WEBUI_DIR = Path(__file__).resolve().parent.parent / "webui"

app = FastAPI(title=settings.app_name, docs_url=None, redoc_url=None)


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
def create_session() -> dict[str, Any]:
    sid = uuid.uuid4().hex
    db.create_session(sid, "New chat")
    return db.get_session(sid) or {}


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

    raise LLMError(
        "No model provider with an API key is configured. "
        "Go to Settings | Models and add a free key (Gemini / Groq / OpenRouter)."
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
    if not db.get_session(session_id):
        raise HTTPException(status_code=404, detail="session not found")

    try:
        provider = _resolve_provider(body.get("provider_id"))
    except LLMError as e:
        return JSONResponse(status_code=400, content={"detail": str(e)})

    model = str(body.get("model") or settings.default_model or (provider.models[0] if provider.models else "")).strip()
    if not model:
        return JSONResponse(status_code=400, content={"detail": "no model selected"})

    skill_id = str(body.get("skill") or "").strip()
    skill_body = load_skill(skill_id) if skill_id else None

    async def stream():
        try:
            effective = message
            if skill_body:
                effective = f"{skill_body}\n\n---\n\nTask:\n{message}"
            async for ev in run_agent(provider, model, session_id, effective):
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except Exception as e:  # noqa: BLE001
            yield f"data: {json.dumps({'type': 'error', 'message': f'{type(e).__name__}: {e}'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/api/models", dependencies=[Depends(require_any)])
def models() -> dict[str, Any]:
    default = settings.default_model
    return {"default_model": default}


@app.get("/api/skills", dependencies=[Depends(require_any)])
def skills() -> list[dict[str, Any]]:
    return list_skills()


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
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="upload path is not a directory")
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
        print(" AgenticAI is starting. No password is configured.")
        print(" Open the web UI and set an admin password (first-time setup).")
        print("=" * 60)
    print(f" AgenticAI web UI + API:  http://127.0.0.1:{settings.port}")
    print(f" Workspace folder:        {settings.workspace}")
    uvicorn.run(app, host="0.0.0.0", port=settings.port, log_level="info")


if __name__ == "__main__":
    main()