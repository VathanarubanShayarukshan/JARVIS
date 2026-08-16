"""End-to-end smoke test against a running server + stub provider.

Prereq (already done): stub on :9500 and app on :8000.
Run: .venv/Scripts/python.exe scripts/smoke_test.py
"""

import json
import sys
import urllib.request

BASE = "http://127.0.0.1:8000"
TOKEN = None


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            ctype = r.headers.get("Content-Type", "")
            return r.status, raw.decode(errors="replace") if "text/event-stream" not in ctype else raw.decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


def main():
    # 1. health
    s, body = call("GET", "/api/health")
    health = json.loads(body)

    # 2. setup or login
    global TOKEN
    if health["setup_done"]:
        s, body = call("POST", "/api/auth/login", {"password": "test-pass"})
        assert s == 200, f"login failed: {body[:300]}"
        TOKEN = json.loads(body)["token"]
        print("1. health OK, 2. login OK")
    else:
        s, body = call("POST", "/api/auth/setup", {"password": "test-pass"})
        assert s == 200, f"setup failed: {body[:300]}"
        TOKEN = json.loads(body)["token"]
        print("1. health OK, 2. setup OK")

    # 3. wrong login rejected
    s, _ = call("POST", "/api/auth/login", {"password": "nope"})
    assert s == 401, f"wrong password should 401, got {s}"
    print("3. bad login rejected OK")

    # 4. add stub provider directly (no probe needed) if missing
    s, body = call("GET", "/api/providers", None, TOKEN)
    providers = json.loads(body)
    stub = next((p for p in providers if p["base_url"].endswith("127.0.0.1:9500/v1")), None)
    if stub:
        pid = stub["id"]
        print(f"4. provider already present (id={pid}) OK")
    else:
        s, body = call(
            "POST",
            "/api/providers",
            {"name": "Stub", "base_url": "http://127.0.0.1:9500/v1", "api_key": "x", "models": ["stub-1"]},
            TOKEN,
        )
        assert s == 200, f"provider add failed: {body[:300]}"
        pid = json.loads(body)["id"]
        print(f"4. provider added (id={pid}) OK")

    # 5. probe endpoint
    s, body = call("POST", "/api/providers/probe", {"base_url": "http://127.0.0.1:9500/v1", "api_key": "x"})
    models = json.loads(body)["models"]
    assert "stub-1" in models, models
    print("5. probe OK")

    # 6. create session + unauthorized check
    s, _ = call("GET", "/api/sessions")
    assert s == 401, "no token should be 401"
    s, body = call("POST", "/api/sessions", None, TOKEN)
    sid = json.loads(body)["id"]
    print("6. session created OK")

    # 7. chat -> full agent loop (tool call + final text)
    s, body = call("POST", "/api/chat", {"session_id": sid, "message": "create a file for me", "provider_id": pid, "model": "stub-1"}, TOKEN)
    assert s == 200, f"chat HTTP {s}: {body[:300]}"
    events = []
    for frame in body.split("\n\n"):
        line = next((l for l in frame.split("\n") if l.startswith("data: ")), None)
        if line:
            try:
                events.append(json.loads(line[6:]))
            except Exception:
                pass
    types = [e["type"] for e in events]
    assert "tool_call" in types and "tool_result" in types and "done" in types, types
    tc = next(e for e in events if e["type"] == "tool_call")
    assert tc["name"] == "write_file" and tc["arguments"]["path"] == "hello.txt", tc
    final = next(e for e in events if e["type"] == "done")["content"]
    assert "hello.txt" in final, final
    errs = [e for e in events if e["type"] == "error"]
    assert not errs, errs
    print(f"7. chat loop OK: {len(events)} events, wrote hello.txt")

    # 8. message history persisted
    s, body = call("GET", f"/api/sessions/{sid}/messages", None, TOKEN)
    msgs = json.loads(body)
    assert len(msgs) == 2 and msgs[0]["role"] == "user" and msgs[1]["role"] == "assistant", msgs
    print("8. history persisted OK")

    # 9. file exists in workspace + API token flow
    import pathlib

    ws = [p for p in pathlib.Path("data-test").glob("workspace/hello.txt")]
    assert ws, "hello.txt missing in workspace"
    print("9. workspace file OK:", ws[0])

    s, body = call("POST", "/api/tokens", {"name": "demo-app"}, TOKEN)
    at = json.loads(body)["token"]
    s, body = call("GET", "/api/sessions", None, at)
    assert s == 200, "api token should work"
    print("10. API token OK")

    print("\nALL TESTS PASSED")


if __name__ == "__main__":
    main()