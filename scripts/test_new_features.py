"""Tests for the newer JARVIS features, against the app on :8000 (DATA_DIR=data-test).

Prereq: scripts/stub_provider.py on :9500 and the app on :8000 (same as smoke_test).
This script starts its own multi-round stub on :9501.
Run: .venv/Scripts/python.exe scripts/test_new_features.py
"""

import json
import pathlib
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE = "http://127.0.0.1:8000"
TOKEN = None
ROUNDS = 15


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


def sse_events(raw):
    out = []
    for frame in raw.split("\n\n"):
        line = next((l for l in frame.split("\n") if l.startswith("data: ")), None)
        if line:
            try:
                out.append(json.loads(line[6:]))
            except json.JSONDecodeError:
                pass
    return out


class ManyStub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send({"object": "list", "data": [{"id": "stub-many"}, {"id": "stub-slow"}]})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        messages = body.get("messages", [])
        model = body.get("model", "")
        user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        tool_msgs = [m for m in messages if m["role"] == "tool"]

        if model == "stub-slow":
            time.sleep(1.5)

        if "call mcp" in user and not tool_msgs:
            chunk = {
                "choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "mcp__echo__echo", "arguments": json.dumps({"text": "hello-mcp"})}}]}}]
            }
        elif model == "stub-many" and len(tool_msgs) < ROUNDS:
            n = len(tool_msgs)
            chunk = {
                "choices": [{"delta": {"tool_calls": [{"index": 0, "id": f"c{n}", "function": {"name": "write_file", "arguments": json.dumps({"path": f"loop_{n}.txt", "content": str(n)})}}]}}]
            }
        elif tool_msgs:
            last = tool_msgs[-1]["content"]
            chunk = {"choices": [{"delta": {"content": f"finished after {len(tool_msgs)} tool rounds. last={last[:80]}"}}]}
        else:
            chunk = {"choices": [{"delta": {"content": "no tools needed"}}]}

        resp = b"data: " + json.dumps(chunk).encode() + b"\n\ndata: [DONE]\n\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(resp)))
        self.end_headers()
        self.wfile.write(resp)


def main():
    global TOKEN
    s, body = call("POST", "/api/auth/login", {"password": "test-pass"})
    if s != 200:
        s, body = call("POST", "/api/auth/setup", {"password": "test-pass"})
    TOKEN = json.loads(body)["token"]

    srv = HTTPServer(("127.0.0.1", 9501), ManyStub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    s, body = call("GET", "/api/providers", token=TOKEN)
    providers = json.loads(body)
    many = next((p for p in providers if p["base_url"].endswith("9501/v1")), None)
    if many:
        many_pid = many["id"]
    else:
        s, body = call("POST", "/api/providers", {"name": "StubMany", "base_url": "http://127.0.0.1:9501/v1", "api_key": "x", "models": ["stub-many", "stub-slow"]}, TOKEN)
        many_pid = json.loads(body)["id"]
    stub_pid = next(p["id"] for p in providers if p["base_url"].endswith("9500/v1"))

    # 1. unlimited tool loop: 15 rounds (> old 12 limit)
    s, body = call("POST", "/api/sessions", {}, TOKEN)
    sid = json.loads(body)["id"]
    s, body = call("POST", "/api/chat", {"session_id": sid, "message": "loop test", "provider_id": many_pid, "model": "stub-many"}, TOKEN, timeout=120)
    evs = sse_events(body)
    calls = [e for e in evs if e["type"] == "tool_call"]
    assert len(calls) >= ROUNDS, f"expected >={ROUNDS} tool calls, got {len(calls)}"
    assert any(e["type"] == "done" for e in evs), evs[-3:]
    assert not any(e["type"] == "error" for e in evs), [e for e in evs if e["type"] == "error"]
    print(f"1. unlimited loop OK: {len(calls)} tool calls in one prompt")

    # 2. skills CRUD
    s, body = call("POST", "/api/skills", {"id": "test-skill", "content": "# Test Skill\nDo the thing."}, TOKEN)
    assert s == 200, body
    s, body = call("GET", "/api/skills", token=TOKEN)
    assert any(x["id"] == "test-skill" for x in json.loads(body))
    s, body = call("GET", "/api/skills/test-skill", token=TOKEN)
    assert "Do the thing." in json.loads(body)["content"]
    s, _ = call("PUT", "/api/skills/test-skill", {"content": "# Test Skill\nUpdated."}, TOKEN)
    assert s == 200
    s, _ = call("DELETE", "/api/skills/test-skill", token=TOKEN)
    assert s == 200
    s, _ = call("GET", "/api/skills/test-skill", token=TOKEN)
    assert s == 404
    print("2. skills CRUD OK")

    # 3. project knowledge reaches the model's system prompt
    s, body = call("POST", "/api/projects", {"name": "Demo Project", "instructions": "Always answer in Tamil."}, TOKEN)
    proj = json.loads(body)
    s, _ = call("POST", f"/api/projects/{proj['id']}/files", {"name": "facts.md", "content": "The secret code is BLUE-42."}, TOKEN)
    assert s == 200
    s, body = call("POST", "/api/sessions", {"project_id": proj["id"]}, TOKEN)
    psid = json.loads(body)["id"]
    assert json.loads(body)["project_id"] == proj["id"]
    s, body = call("POST", "/api/chat", {"session_id": psid, "message": "what is the code?", "provider_id": stub_pid, "model": "stub-1"}, TOKEN)
    assert s == 200 and any(e["type"] == "done" for e in sse_events(body)), body[:300]
    log = pathlib.Path("stub_requests.jsonl").read_text(encoding="utf-8").strip().split("\n")
    last = json.loads(log[-1])
    system = last["messages"][0]["content"]
    assert "BLUE-42" in system and "Always answer in Tamil." in system, system[:400]
    print("3. project instructions + knowledge injected OK")

    # 4. push to background: disconnect mid-run, job finishes anyway, replay works
    s, body = call("POST", "/api/sessions", {}, TOKEN)
    bsid = json.loads(body)["id"]
    req = urllib.request.Request(BASE + "/api/chat", data=json.dumps({"session_id": bsid, "message": "slow task", "provider_id": many_pid, "model": "stub-slow"}).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + TOKEN)
    r = urllib.request.urlopen(req, timeout=30)
    first = r.readline().decode()
    job_ev = json.loads(first.removeprefix("data: ").strip())
    assert job_ev["type"] == "job", job_ev
    job_id = job_ev["id"]
    r.close()  # simulate push / closing the window
    time.sleep(5)
    s, body = call("GET", "/api/jobs", token=TOKEN)
    job = next(j for j in json.loads(body) if j["id"] == job_id)
    assert job["status"] == "done", job
    s, body = call("GET", f"/api/jobs/{job_id}/stream?after=0", token=TOKEN)
    evs = sse_events(body)
    assert any(e["type"] == "done" for e in evs), evs[-3:]
    s, body = call("GET", f"/api/sessions/{bsid}/messages", token=TOKEN)
    msgs = json.loads(body)
    assert len(msgs) == 2 and msgs[1]["role"] == "assistant", msgs
    print("4. background job survived disconnect + replay OK")

    # 5. stop a running job
    s, body = call("POST", "/api/sessions", {}, TOKEN)
    ssid = json.loads(body)["id"]
    req = urllib.request.Request(BASE + "/api/chat", data=json.dumps({"session_id": ssid, "message": "stop me", "provider_id": many_pid, "model": "stub-slow"}).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + TOKEN)
    r = urllib.request.urlopen(req, timeout=30)
    job_ev = json.loads(r.readline().decode().removeprefix("data: ").strip())
    stop_id = job_ev["id"]
    s, body = call("POST", f"/api/jobs/{stop_id}/stop", {}, TOKEN)
    assert s == 200 and json.loads(body)["ok"], body
    r.close()
    s, body = call("GET", "/api/jobs", token=TOKEN)
    job = next(j for j in json.loads(body) if j["id"] == stop_id)
    assert job["status"] == "stopped", job
    s, body = call("GET", f"/api/jobs/{stop_id}/stream?after=0", token=TOKEN)
    assert any(e.get("stopped") for e in sse_events(body))
    print("5. job stop OK")

    # 6. MCP: presets, add real stdio server, test handshake, agent tool call
    s, body = call("GET", "/api/mcp", token=TOKEN)
    mcp_data = json.loads(body)
    assert any(p["name"] == "GitHub" for p in mcp_data["presets"])
    script = str(pathlib.Path(__file__).resolve().parent / "echo_mcp_server.py")
    s, body = call("POST", "/api/mcp", {"name": "echo", "command": sys.executable, "args": [script], "env": {}}, TOKEN)
    assert s == 200, body
    mid = json.loads(body)["id"]
    s, body = call("POST", f"/api/mcp/{mid}/test", {}, TOKEN, timeout=150)
    j = json.loads(body)
    assert j.get("ok") and any(t["name"] == "echo" for t in j.get("tools", [])), j
    s, body = call("POST", "/api/sessions", {}, TOKEN)
    msid = json.loads(body)["id"]
    s, body = call("POST", "/api/chat", {"session_id": msid, "message": "call mcp now", "provider_id": many_pid, "model": "stub-many"}, TOKEN, timeout=150)
    evs = sse_events(body)
    tc = next((e for e in evs if e["type"] == "tool_call" and e["name"] == "mcp__echo__echo"), None)
    assert tc, [e for e in evs if e["type"] in ("tool_call", "error", "status")][:6]
    tr = next(e for e in evs if e["type"] == "tool_result" and e["name"] == "mcp__echo__echo")
    assert "echo: hello-mcp" in tr["result"], tr
    assert any(e["type"] == "done" for e in evs)
    s, _ = call("DELETE", f"/api/mcp/{mid}", token=TOKEN)
    assert s == 200
    print("6. MCP add/test/agent-call OK")

    srv.shutdown()
    print("\nALL NEW-FEATURE TESTS PASSED")


if __name__ == "__main__":
    main()