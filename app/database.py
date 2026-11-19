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
            CREATE TABLE IF NOT EXISTS jobs(
                id TEXT PRIMARY KEY,
                session_id TEXT,
                status TEXT,
                created_at REAL,
                updated_at REAL
            );
            CREATE TABLE IF NOT EXISTS job_events(
                job_id TEXT,
                idx INTEGER,
                event TEXT,
                PRIMARY KEY(job_id, idx)
            );
            CREATE TABLE IF NOT EXISTS mcp_servers(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                command TEXT,
                args TEXT,
                env TEXT,
                url TEXT DEFAULT '',
                enabled INTEGER DEFAULT 1,
                created_at REAL
            );
            CREATE TABLE IF NOT EXISTS projects(
                id TEXT PRIMARY KEY,
                name TEXT,
                instructions TEXT,
                created_at REAL,
                updated_at REAL
            );
            CREATE TABLE IF NOT EXISTS project_files(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT,
                name TEXT,
                content TEXT,
                created_at REAL
            );
            """
        )
        cols = [r["name"] for r in db.execute("PRAGMA table_info(sessions)").fetchall()]
        if "project_id" not in cols:
            db.execute("ALTER TABLE sessions ADD COLUMN project_id TEXT")
        mcols = [r["name"] for r in db.execute("PRAGMA table_info(mcp_servers)").fetchall()]
        if "url" not in mcols:
            db.execute("ALTER TABLE mcp_servers ADD COLUMN url TEXT DEFAULT ''")
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


def create_session(session_id: str, title: str, project_id: str | None = None) -> None:
    import time
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO sessions(id,title,created_at,updated_at,project_id) VALUES(?,?,?,?,?)",
            (session_id, title, time.time(), time.time(), project_id),
        )


def delete_session(session_id: str) -> bool:
    with _lock, _conn() as db:
        db.execute("DELETE FROM messages WHERE session_id=?", (session_id,))
        db.execute("DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE session_id=?)", (session_id,))
        db.execute("DELETE FROM jobs WHERE session_id=?", (session_id,))
        cur = db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        return cur.rowcount > 0


def set_session_project(session_id: str, project_id: str | None) -> None:
    with _lock, _conn() as db:
        db.execute("UPDATE sessions SET project_id=? WHERE id=?", (project_id, session_id))


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


# ---------------- jobs (background agent runs) ----------------

def create_job(job_id: str, session_id: str) -> None:
    import time
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO jobs(id,session_id,status,created_at,updated_at) VALUES(?,?,?,?,?)",
            (job_id, session_id, "running", time.time(), time.time()),
        )


def set_job_status(job_id: str, status: str) -> None:
    import time
    with _lock, _conn() as db:
        db.execute("UPDATE jobs SET status=?,updated_at=? WHERE id=?", (status, time.time(), job_id))


def get_job(job_id: str) -> dict[str, Any] | None:
    with _lock, _conn() as db:
        return _row_to_dict(db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())


def list_jobs(limit: int = 100) -> list[dict[str, Any]]:
    with _lock, _conn() as db:
        rows = db.execute(
            "SELECT j.*, s.title AS session_title FROM jobs j"
            " LEFT JOIN sessions s ON s.id = j.session_id"
            " ORDER BY j.created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def add_job_event(job_id: str, idx: int, event: dict[str, Any]) -> None:
    import time
    with _lock, _conn() as db:
        db.execute(
            "INSERT OR REPLACE INTO job_events(job_id,idx,event) VALUES(?,?,?)",
            (job_id, idx, json.dumps(event, ensure_ascii=False)),
        )
        db.execute("UPDATE jobs SET updated_at=? WHERE id=?", (time.time(), job_id))


def get_job_events(job_id: str, after: int = 0) -> list[dict[str, Any]]:
    with _lock, _conn() as db:
        rows = db.execute(
            "SELECT event FROM job_events WHERE job_id=? AND idx>=? ORDER BY idx",
            (job_id, after),
        ).fetchall()
        out = []
        for r in rows:
            try:
                out.append(json.loads(r["event"]))
            except json.JSONDecodeError:
                continue
        return out


def interrupt_stale_jobs() -> None:
    import time
    with _lock, _conn() as db:
        rows = db.execute("SELECT id FROM jobs WHERE status='running'").fetchall()
        for r in rows:
            ev = {"type": "error", "message": "Server restarted while this task was running — it was interrupted. Send the task again to retry."}
            n = db.execute("SELECT COALESCE(MAX(idx)+1,0) AS n FROM job_events WHERE job_id=?", (r["id"],)).fetchone()["n"]
            db.execute("INSERT OR REPLACE INTO job_events(job_id,idx,event) VALUES(?,?,?)", (r["id"], n, json.dumps(ev)))
            db.execute("UPDATE jobs SET status='interrupted',updated_at=? WHERE id=?", (time.time(), r["id"]))


# ---------------- MCP servers ----------------

def list_mcp_servers() -> list[dict[str, Any]]:
    with _lock, _conn() as db:
        rows = db.execute("SELECT * FROM mcp_servers ORDER BY id").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["args"] = json.loads(d["args"] or "[]")
            env = json.loads(d["env"] or "{}")
            d["env"] = {k: ("••••••" if v else "") for k, v in env.items()}
            d["enabled"] = bool(d["enabled"])
            out.append(d)
        return out


def get_mcp_server(server_id: int) -> dict[str, Any] | None:
    with _lock, _conn() as db:
        row = db.execute("SELECT * FROM mcp_servers WHERE id=?", (server_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["args"] = json.loads(d["args"] or "[]")
        d["env"] = json.loads(d["env"] or "{}")
        return d


def add_mcp_server(name: str, command: str, args: list[str], env: dict[str, str], url: str = "") -> int:
    import time
    with _lock, _conn() as db:
        cur = db.execute(
            "INSERT INTO mcp_servers(name,command,args,env,url,enabled,created_at) VALUES(?,?,?,?,?,1,?)",
            (name, command, json.dumps(args), json.dumps(env), url, time.time()),
        )
        return cur.lastrowid


def update_mcp_server(server_id: int, name: str, command: str, args: list[str], env: dict[str, str] | None, enabled: bool, url: str = "") -> None:
    with _lock, _conn() as db:
        if env is None:
            db.execute(
                "UPDATE mcp_servers SET name=?,command=?,args=?,url=?,enabled=? WHERE id=?",
                (name, command, json.dumps(args), url, 1 if enabled else 0, server_id),
            )
        else:
            db.execute(
                "UPDATE mcp_servers SET name=?,command=?,args=?,env=?,url=?,enabled=? WHERE id=?",
                (name, command, json.dumps(args), json.dumps(env), url, 1 if enabled else 0, server_id),
            )


def delete_mcp_server(server_id: int) -> bool:
    with _lock, _conn() as db:
        return db.execute("DELETE FROM mcp_servers WHERE id=?", (server_id,)).rowcount > 0


# ---------------- projects + knowledge ----------------

def list_projects() -> list[dict[str, Any]]:
    with _lock, _conn() as db:
        rows = db.execute(
            "SELECT p.*, (SELECT COUNT(*) FROM project_files f WHERE f.project_id=p.id) AS file_count"
            " FROM projects p ORDER BY p.updated_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def get_project(project_id: str) -> dict[str, Any] | None:
    with _lock, _conn() as db:
        return _row_to_dict(db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone())


def create_project(project_id: str, name: str, instructions: str) -> None:
    import time
    with _lock, _conn() as db:
        db.execute(
            "INSERT INTO projects(id,name,instructions,created_at,updated_at) VALUES(?,?,?,?,?)",
            (project_id, name, instructions, time.time(), time.time()),
        )


def update_project(project_id: str, name: str, instructions: str) -> None:
    import time
    with _lock, _conn() as db:
        db.execute(
            "UPDATE projects SET name=?,instructions=?,updated_at=? WHERE id=?",
            (name, instructions, time.time(), project_id),
        )


def delete_project(project_id: str) -> bool:
    with _lock, _conn() as db:
        db.execute("DELETE FROM project_files WHERE project_id=?", (project_id,))
        db.execute("UPDATE sessions SET project_id=NULL WHERE project_id=?", (project_id,))
        return db.execute("DELETE FROM projects WHERE id=?", (project_id,)).rowcount > 0


def list_project_files(project_id: str) -> list[dict[str, Any]]:
    with _lock, _conn() as db:
        rows = db.execute(
            "SELECT id,project_id,name,created_at,LENGTH(content) AS size FROM project_files WHERE project_id=? ORDER BY id",
            (project_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def get_project_file(file_id: int) -> dict[str, Any] | None:
    with _lock, _conn() as db:
        return _row_to_dict(db.execute("SELECT * FROM project_files WHERE id=?", (file_id,)).fetchone())


def add_project_file(project_id: str, name: str, content: str) -> int:
    import time
    with _lock, _conn() as db:
        cur = db.execute(
            "INSERT INTO project_files(project_id,name,content,created_at) VALUES(?,?,?,?)",
            (project_id, name, content, time.time()),
        )
        db.execute("UPDATE projects SET updated_at=? WHERE id=?", (time.time(), project_id))
        return cur.lastrowid


def delete_project_file(file_id: int) -> bool:
    with _lock, _conn() as db:
        return db.execute("DELETE FROM project_files WHERE id=?", (file_id,)).rowcount > 0