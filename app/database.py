import json
import sqlite3
import threading
from pathlib import Path
from typing import Any

from .config import settings

_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(settings.db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with _lock, _conn() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions(
                id TEXT PRIMARY KEY,
                title TEXT,
                created_at REAL,
                updated_at REAL
            );
            CREATE TABLE IF NOT EXISTS messages(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                role TEXT,
                content TEXT,
                created_at REAL
            );
            CREATE TABLE IF NOT EXISTS tokens(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                token TEXT UNIQUE,
                created_at REAL
            );
            CREATE TABLE IF NOT EXISTS providers(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                base_url TEXT,
                api_key TEXT,
                models TEXT,
                hint TEXT,
                is_custom INTEGER DEFAULT 1,
                created_at REAL
            );
            CREATE TABLE IF NOT EXISTS settings(
                key TEXT PRIMARY KEY,
                value TEXT
            );
            """
        )
    _seed_presets()


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


# ---------------- sessions ----------------

def list_sessions() -> list[dict[str, Any]]:
    with _lock, _conn() as db:
        rows = db.execute("SELECT * FROM sessions ORDER BY updated_at DESC").fetchall()
        return [dict(r) for r in rows]


def get_session(session_id: str) -> dict[str, Any] | None:
    with _lock, _conn() as db:
        return _row_to_dict(db.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone())


def create_session(session_id: str, title: str) -> None:
    import time
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)",
            (session_id, title, time.time(), time.time()),
        )


def delete_session(session_id: str) -> bool:
    with _lock, _conn() as db:
        db.execute("DELETE FROM messages WHERE session_id=?", (session_id,))
        cur = db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        return cur.rowcount > 0


def touch_session(session_id: str) -> None:
    import time
    with _lock, _conn() as db:
        db.execute("UPDATE sessions SET updated_at=? WHERE id=?", (time.time(), session_id))


def set_session_title(session_id: str, title: str) -> None:
    with _lock, _conn() as db:
        db.execute("UPDATE sessions SET title=? WHERE id=?", (title, session_id))


# ---------------- messages ----------------

def list_messages(session_id: str, limit: int | None = None) -> list[dict[str, Any]]:
    with _lock, _conn() as db:
        sql = "SELECT * FROM messages WHERE session_id=? ORDER BY id"
        params: tuple[Any, ...] = (session_id,)
        if limit:
            sql = (
                "SELECT * FROM (SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ?)"
                " ORDER BY id"
            )
            params = (session_id, limit)
        rows = db.execute(sql, params).fetchall()
        return [dict(r) for r in rows]


def append_message(session_id: str, role: str, content: str) -> None:
    import time
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO messages(session_id,role,content,created_at) VALUES(?,?,?,?)",
            (session_id, role, content, time.time()),
        )
        db.execute("UPDATE sessions SET updated_at=? WHERE id=?", (time.time(), session_id))


# ---------------- tokens ----------------

def list_tokens() -> list[dict[str, Any]]:
    with _lock, _conn() as db:
        rows = db.execute("SELECT id,name,created_at FROM tokens ORDER BY id").fetchall()
        return [dict(r) for r in rows]


def create_token(name: str, token: str) -> None:
    import time
    with _lock, _conn() as db:
        db.execute("INSERT INTO tokens(name,token,created_at) VALUES(?,?,?)", (name, token, time.time()))


def delete_token(token_id: int) -> bool:
    with _lock, _conn() as db:
        return db.execute("DELETE FROM tokens WHERE id=?", (token_id,)).rowcount > 0


def token_exists(token: str) -> bool:
    with _lock, _conn() as db:
        return db.execute("SELECT 1 FROM tokens WHERE token=?", (token,)).fetchone() is not None


# ---------------- providers ----------------

def _seed_presets() -> None:
    """Insert missing presets and refresh model lists / hints on presets that
    already exist (never touches the user's stored API key)."""
    from .presets import default_presets

    with _lock, _conn() as db:
        for p in default_presets():
            row = db.execute("SELECT id,api_key FROM providers WHERE name=?", (p["name"],)).fetchone()
            if row is None:
                db.execute(
                    "INSERT INTO providers(name,base_url,api_key,models,hint,is_custom,created_at)"
                    " VALUES(?,?,NULL,?,?,0,?)",
                    (p["name"], p["base_url"], json.dumps(p["models"]), p["hint"], __import__("time").time()),
                )
            else:
                db.execute(
                    "UPDATE providers SET base_url=?,models=?,hint=? WHERE id=?",
                    (p["base_url"], json.dumps(p["models"]), p["hint"], row["id"]),
                )


def list_providers() -> list[dict[str, Any]]:
    with _lock, _conn() as db:
        rows = db.execute("SELECT * FROM providers ORDER BY id").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["api_key_set"] = bool(d.get("api_key"))
            d["api_key"] = None
            if d.get("models"):
                d["models"] = json.loads(d["models"])
            out.append(d)
        return out


def add_provider(name: str, base_url: str, api_key: str, models: list[str], hint: str = "") -> int:
    import time
    with _lock, _conn() as db:
        cur = db.execute(
            "INSERT INTO providers(name,base_url,api_key,models,hint,is_custom,created_at)"
            " VALUES(?,?,?,?,?,1,?)",
            (name, base_url, api_key or None, json.dumps(models), hint or None, time.time()),
        )
        return cur.lastrowid


def get_provider(provider_id: int) -> dict[str, Any] | None:
    with _lock, _conn() as db:
        return _row_to_dict(db.execute("SELECT * FROM providers WHERE id=?", (provider_id,)).fetchone())


def update_provider(provider_id: int, name: str, base_url: str, api_key: str, models: list[str], hint: str = "") -> None:
    with _lock, _conn() as db:
        db.execute(
            "UPDATE providers SET name=?,base_url=?,api_key=?,models=?,hint=? WHERE id=?",
            (name, base_url, api_key or None, json.dumps(models), hint or None, provider_id),
        )


def delete_provider(provider_id: int) -> bool:
    with _lock, _conn() as db:
        return db.execute("DELETE FROM providers WHERE id=?", (provider_id,)).rowcount > 0


# ---------------- settings ----------------

def get_setting(key: str, default: str | None = None) -> str | None:
    with _lock, _conn() as db:
        row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )