"""URL-based MCP tests (Streamable HTTP + SSE) against a running server.

Prereq: app on :8000 with DATA_DIR=data-test.
Run: .venv/Scripts/python.exe scripts/test_url_mcp.py
"""

import json
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

from test_new_features import ManyStub, sse_events

BASE = "http://127.0.0.1:8000"
TOKEN = None
ROOT = Path(__file__).resolve().parent.parent


def call(method, path, body=None, token=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def wait_port(port, secs=30):
    end = time.time() + secs
    while time.time() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.4)
    return False


def main():
    global TOKEN
    s, body = call("POST", "/api/auth/login", {"password": "test-pass"})
    if s != 200:
        s, body = call("POST", "/api/auth/setup", {"password": "test-pass"})
    TOKEN = json.loads(body)["token"]

    procs = []
    for transport, port in (("streamable-http", 9502), ("sse", 9503)):
        procs.append(subprocess.Popen(
            [sys.executable, str(ROOT / "scripts" / "echo_mcp_server.py"), "--transport", transport, "--port", str(port)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ))
    srv = HTTPServer(("127.0.0.1", 9501), ManyStub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    added = []
    try:
        assert wait_port(9502) and wait_port(9503), "echo servers did not start"

        s, body = call("POST", "/api/mcp/test", {"name": "echo-http", "url": "http://127.0.0.1:9502/mcp"}, TOKEN)
        j = json.loads(body)
        assert j.get("ok") and any(t["name"] == "echo" for t in j["tools"]), j
        print("1. streamable-http URL probe OK")

        s, body = call("POST", "/api/mcp/test", {"name": "echo-sse", "url": "http://127.0.0.1:9503/sse"}, TOKEN)
        j = json.loads(body)
        assert j.get("ok") and any(t["name"] == "echo" for t in j["tools"]), j
        print("2. SSE URL probe OK (http->sse fallback)")

        s, body = call("POST", "/api/mcp", {"name": "bad", "url": "ftp://x"}, TOKEN)
        assert s == 400, (s, body)
        s, body = call("POST", "/api/mcp", {"name": "bad"}, TOKEN)
        assert s == 400, (s, body)
        print("3. validation OK (bad scheme / missing command+url rejected)")

        s, body = call("POST", "/api/mcp", {"name": "echo", "url": "http://127.0.0.1:9502/mcp"}, TOKEN)
        assert s == 200, body
        eid = json.loads(body)["id"]
        added.append(eid)
        s, body = call("GET", "/api/mcp", token=TOKEN)
        row = next(x for x in json.loads(body)["servers"] if x["id"] == eid)
        assert row["url"] == "http://127.0.0.1:9502/mcp", row
        print("4. URL server saved + listed OK")

        s, body = call("GET", "/api/providers", token=TOKEN)
        providers = json.loads(body)
        many = next((p for p in providers if p["base_url"].endswith("9501/v1")), None)
        if many:
            pid = many["id"]
        else:
            s, body = call("POST", "/api/providers", {"name": "StubMany", "base_url": "http://127.0.0.1:9501/v1", "api_key": "x", "models": ["stub-many", "stub-slow"]}, TOKEN)
            pid = json.loads(body)["id"]
        s, body = call("POST", "/api/sessions", {}, TOKEN)
        sid = json.loads(body)["id"]
        s, body = call("POST", "/api/chat", {"session_id": sid, "message": "call mcp now", "provider_id": pid, "model": "stub-many"}, TOKEN, timeout=120)
        evs = sse_events(body)
        tc = next((e for e in evs if e["type"] == "tool_call" and e["name"] == "mcp__echo__echo"), None)
        assert tc, evs
        tr = next(e for e in evs if e["type"] == "tool_result")
        assert "echo: hello-mcp" in tr.get("result", ""), tr
        assert any(e["type"] == "done" for e in evs) and not any(e["type"] == "error" for e in evs), evs[-3:]
        print("5. agent called URL MCP tool OK:", tr["result"][:60])

        s, body = call("POST", "/api/mcp", {"name": "echo-sse", "url": "http://127.0.0.1:9503/sse"}, TOKEN)
        assert s == 200, body
        ssid = json.loads(body)["id"]
        added.append(ssid)
        s, body = call("POST", f"/api/mcp/{ssid}/test", None, TOKEN)
        j = json.loads(body)
        assert j.get("ok"), j
        s, _ = call("PUT", f"/api/mcp/{ssid}", {"enabled": False}, TOKEN)
        assert s == 200
        s, body = call("GET", "/api/mcp", token=TOKEN)
        assert next(x for x in json.loads(body)["servers"] if x["id"] == ssid)["enabled"] is False
        s, _ = call("PUT", f"/api/mcp/{ssid}", {"enabled": True}, TOKEN)
        assert s == 200
        print("6. saved SSE server test + enable toggle OK")
        print("\nALL URL MCP TESTS PASSED")
    finally:
        for sid in added:
            call("DELETE", f"/api/mcp/{sid}", token=TOKEN)
        srv.shutdown()
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()


if __name__ == "__main__":
    main()