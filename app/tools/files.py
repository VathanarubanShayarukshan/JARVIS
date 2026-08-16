import fnmatch
import os
import re
from pathlib import Path

from ..config import settings

WORKSPACE = settings.workspace
MAX_READ_BYTES = 200_000


def _resolve(path: str) -> Path:
    p = (WORKSPACE / path).resolve()
    if not p.is_relative_to(WORKSPACE):
        raise PermissionError(f"path {path!r} escapes the workspace")
    return p


def _tool(fn):
    fn._tool = _describe(fn)
    return fn


def _describe(fn):
    import inspect

    sig = inspect.signature(fn)
    props: dict[str, Any] = {}
    required: list[str] = []
    for pname, param in sig.parameters.items():
        if pname in ("return",):
            continue
        ann = param.annotation
        t = {"int": "integer", "float": "number", "bool": "boolean"}.get(ann.__name__, "string")
        if ann is bool:
            t = "boolean"
        props[pname] = {"type": t, "description": ""}
        if param.default is inspect.Parameter.empty:
            required.append(pname)
    doc = (fn.__doc__ or "").strip().split("\n")[0]
    desc = (fn.__doc__ or "").strip().replace("\n", " ")
    return {
        "type": "function",
        "function": {
            "name": fn.__name__,
            "description": desc or doc or "...",
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


@_tool
def list_dir(path: str = ".") -> dict:
    """List the contents of a directory inside the workspace. Returns an object."""
    p = _resolve(path)
    entries = []
    for child in sorted(p.iterdir(), key=lambda c: c.name.lower()):
        rel = str(child.relative_to(WORKSPACE)).replace("\\", "/")
        if child.is_dir():
            entries.append({"type": "dir", "name": child.name, "path": rel})
        else:
            entries.append(
                {
                    "type": "file",
                    "name": child.name,
                    "path": rel,
                    "size": (child.stat().st_size if child.exists() else 0),
                }
            )
    return {"path": str(path), "entries": entries}


@_tool
def read_file(path: str, offset: int = 0, limit: int = 2000) -> dict:
    """Read a text file (max ~200KB), optionally paging by line numbers. Returns an object."""
    p = _resolve(path)
    if not p.is_file():
        return {"error": f"file not found: {path}", "path": str(path)}
    if p.stat().st_size > MAX_READ_BYTES:
        return {"error": f"file too large ({p.stat().st_size} bytes), max {MAX_READ_BYTES}", "path": str(path)}
    text = p.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    start = max(offset, 0)
    end = None if limit <= 0 else start + limit
    return {
        "path": str(path),
        "total_lines": len(lines),
        "lines": lines[start:end],
        "type": "text",
    }


@_tool
def write_file(path: str, content: str) -> dict:
    """Create a brand-new file or completely overwrite an existing one. Returns an object."""
    p = _resolve(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return {"path": str(path), "result": "ok", "chars": len(content)}


@_tool
def edit_file(path: str, old_string: str, new_string: str, replace_all: bool = False) -> dict:
    """Replace an exact string within a file (SafeEdit). Never guess content — read first. Returns an object."""
    p = _resolve(path)
    text = p.read_text(encoding="utf-8")
    if old_string not in text:
        return {"error": f"old_string not found in {path}", "path": str(path)}
    count = text.count(old_string)
    if count > 1 and not replace_all:
        return {
            "error": f"Found {count} matches. Pass replace_all=true, or include more surrounding context.",
            "path": str(path),
        }
    text = text.replace(old_string, new_string) if replace_all else text.replace(old_string, new_string, 1)
    p.write_text(text, encoding="utf-8")
    return {"path": str(path), "result": "ok", "replaced": count if replace_all else 1}


@_tool
def delete_file(path: str) -> dict:
    """Delete a file inside the workspace. Returns an object."""
    p = _resolve(path)
    if p.is_file():
        p.unlink()
        return {"path": str(path), "result": "deleted"}
    if p.is_dir():
        return {"error": "use delete_dir for directories"}
    return {"error": f"not found: {path}"}


@_tool
def delete_dir(path: str) -> dict:
    """Recursively delete a directory inside the workspace. Returns an object."""
    p = _resolve(path)
    if not p.is_dir():
        return {"error": f"not found: {path}"}
    import shutil

    shutil.rmtree(p)
    return {"path": str(path), "result": "deleted"}


@_tool
def glob_pattern(pattern: str, path: str = ".") -> dict:
    """Find files matching a glob pattern under a path. Returns an object."""
    root = _resolve(path)
    matches = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = str(p.relative_to(WORKSPACE)).replace("\\", "/")
        if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(p.name, pattern):
            matches.append(rel)
    matches.sort()
    return {"count": len(matches), "matches": matches}


@_tool
def grep(pattern: str, path: str = ".", include: str = "") -> dict:
    """Search file contents with a regex inside the workspace. Returns matching lines."""
    rx = re.compile(pattern)
    root = _resolve(path)
    hits = []
    count = 0
    if root.is_file():
        candidates = [root]
    else:
        candidates = [p for p in root.rglob("*") if p.is_file()]
    for p in candidates:
        if include and not fnmatch.fnmatch(p.name, include):
            continue
        try:
            if p.stat().st_size > MAX_READ_BYTES:
                continue
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if rx.search(line):
                rel = str(p.relative_to(WORKSPACE)).replace("\\", "/")
                hits.append({"file": rel, "line": i, "text": line[:400]})
                count += 1
                if count > 200:
                    return {"count": count, "truncated": True, "hits": hits}
    return {"count": count, "hits": hits}