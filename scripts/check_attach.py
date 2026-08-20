"""End-to-end: attach a file, chat with skill, expect done.files from write_file."""
import json
import sqlite3
import urllib.request

tok = sqlite3.connect("data/app.db").execute(
    "SELECT value FROM settings WHERE key='web_token'"
).fetchone()[0]
H = {"Authorization": "Bearer " + tok}


def req(path, method="GET", body=None, ctype="application/json"):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        "http://127.0.0.1:8000" + path,
        data=data, headers={**H, **({"Content-Type": ctype} if ctype else {})},
        method=method,
    )
    return json.load(urllib.request.urlopen(r, timeout=90))


# upload an attachment
boundary = "b" + "x" * 24
mp = []
mp.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\nattachments/s1\r\n".encode())
mp.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"notes.txt\"\r\nContent-Type: text/plain\r\n\r\nmy secret notes: buy milk\n".encode())
mp.append(f"\r\n--{boundary}--\r\n".encode())
r2 = urllib.request.Request(
    "http://127.0.0.1:8000/api/files/upload",
    data=b"".join(mp),
    headers={**H, "Content-Type": f"multipart/form-data; boundary={boundary}"},
    method="POST",
)
print("upload ->", json.load(urllib.request.urlopen(r2)))

sid = req("/api/sessions", "POST")["id"]
print("session:", sid)

body = {
    "session_id": sid,
    "message": "summarize my notes and create result.txt with the summary",
    "provider_id": 4,
    "model": "stub-1",
    "skill": "code-review",
    "attachments": ["attachments/s1/notes.txt"],
}
r = urllib.request.Request("http://127.0.0.1:8000/api/chat", data=json.dumps(body).encode(),
                           headers={**H, "Content-Type": "application/json"}, method="POST")
events = urllib.request.urlopen(r, timeout=90).read().decode()
done = [e for e in events.split("\n\n") if '"type": "done"' in e]
print("done event:", done[-1][:400] if done else "MISSING")

msgs = req(f"/api/sessions/{sid}/messages")
user_msg = msgs[0]["content"]
print("user msg mentions attachment:", "attachments/s1/notes.txt" in user_msg)
print("agent wrote result.txt:", any("result.txt" in str(m.get("content", "")) for m in msgs))
print("DONE")