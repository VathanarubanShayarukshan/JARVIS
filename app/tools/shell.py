import asyncio
import os
import re
import sys
import tempfile
from pathlib import Path

from ..config import settings

WORKSPACE = settings.workspace
IS_WINDOWS = os.name == "nt"
DEFAULT_TIMEOUT = 120


def _tool(fn):
    fn._tool = _describe(fn)
    return fn


def _describe(fn):
    import inspect

    sig = inspect.signature(fn)
    props: dict[str, object] = {}
    required: list[str] = []
    for pname, param in sig.parameters.items():
        if pname == "return":
            continue
        props[pname] = {"type": "string", "description": ""}
        if param.default is inspect.Parameter.empty:
            required.append(pname)
    return {
        "type": "function",
        "function": {
            "name": fn.__name__,
            "description": (fn.__doc__ or "").strip() or "...",
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


def _wrap(coro):
    try:
        return asyncio.run(coro)
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()


@_tool
def run_command(command: str, timeout: int = DEFAULT_TIMEOUT) -> dict:
    """Run a shell command in the workspace folder. Use for builds, tests, git,
    installs, and any command-line work. Commands run via bash on Unix and
    powershell on Windows."""
    if IS_WINDOWS:
        argv = ["powershell", "-NoProfile", "-Command", _powershell_compat(command)]
    else:
        argv = ["/bin/bash", "-lc", command]

    proc = subprocess_run(argv, timeout=timeout)
    return _format_result(proc, command)


def _powershell_compat(command: str) -> str:
    """Translate a few common bash idioms into PowerShell so that models that
    mostly target Unix don't produce a parser error on Windows hosts."""
    c = command
    and_count = c.count(" && ")
    or_count = c.count(" || ")
    c = re.sub(r"\s+&&\s+", "; if ($?) { ", c)
    c = re.sub(r"\s+\|\|\s+", "; if (-not $?) { ", c)
    c = c.replace(" 2>/dev/null", " 2>$null").replace(" >/dev/null", " | Out-Null")
    c = c.replace(" 2>&1", " 2>&1")
    if and_count or or_count:
        c = c + ("}" * (and_count + or_count))
    return c


@_tool
def run_script(script: str, language: str = "python", timeout: int = DEFAULT_TIMEOUT) -> dict:
    """Write a script into the workspace temp dir and run it.
    language: python | node | powershell | bash. Use for multi-step computations."""
    lang = language.lower()
    ext = {"python": ".py", "node": ".js", "powershell": ".ps1", "bash": ".sh"}.get(lang, ".txt")
    tmp = Path(tempfile.gettempdir()) / f"agentic-script-{os.getpid()}"
    tmp.mkdir(parents=True, exist_ok=True)
    path = tmp / f"script{ext}"
    path.write_text(script, encoding="utf-8")
    if lang == "python":
        argv = [sys.executable, str(path)]
    elif lang == "node":
        argv = ["node", str(path)]
    elif lang == "powershell":
        argv = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(path)]
    elif lang == "bash":
        argv = ["/bin/bash", str(path)]
    else:
        return {"error": f"unsupported language {language}"}
    proc = subprocess_run(argv, timeout=timeout)
    out = _format_result(proc, " ".join(argv))
    out["script"] = script
    return out


def subprocess_run(argv: list[str], timeout: int, cwd: Path | None = None):
    import subprocess

    try:
        return subprocess.run(
            argv,
            cwd=str(cwd or WORKSPACE),
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired as e:
        return _TimedOut(timeout, e.stdout or "", e.stderr or "")
    except FileNotFoundError as e:
        return _NotFound(str(e))
    except Exception as e:  # noqa: BLE001
        return _NotFound(str(e))


class _TimedOut:
    returncode = -1

    def __init__(self, timeout, stdout="", stderr=""):
        self.timeout = timeout
        self.stdout = stdout
        self.stderr = stderr


class _NotFound:
    returncode = -2

    def __init__(self, msg=""):
        self.stdout = ""
        self.stderr = msg


def _format_result(proc, command: str) -> dict:
    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()
    if getattr(proc, "returncode", -1) == -1:
        return {
            "command": command,
            "timed_out": True,
            "note": f"process exceeded {proc.timeout}s",
            "stdout": stdout,
            "stderr": stderr,
        }
    if getattr(proc, "returncode", -1) == -2:
        return {"command": command, "error": f"could not start process: {proc.stderr}"}
    return {
        "command": command,
        "exit_code": proc.returncode,
        "stdout": stdout[-12000:],
        "stderr": stderr[-12000:],
    }