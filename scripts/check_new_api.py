"""Verify new endpoints: skills list, skill chat, upload, download."""
import sqlite3
import urllib.request

tok = sqlite3.connect("data/app.db").execute(
    "SELECT value FROM settings WHERE key='web_token'"
).fetchone()[0]
H = {"Authorization": "Bearer " + tok}


def get(path):
    return urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8000" + path, headers=H))


sk = get("/api/skills")
import json
skills = json.load(sk)
print("skills:", [s["id"] for s in skills])

sess = json.load(get("/api/sessions") if False else urllib.request.urlopen(
    urllib.request.Request("http://127.0.0.1:8000/api/sessions", method="POST", headers=H)
))
sid = sess["id"]
print("session:", sid)

body = json.dumps({
    "session_id": sid,
    "message": "say OK",
    "provider_id": 4,
    "model": "stub-1",
    "skill": "code-review",
}).encode()
req = urllib.request.Request(
    "http://127.0.0.1:8000/api/chat",
    data=body, headers={**H, "Content-Type": "application/json"}, method="POST",
)
events = urllib.request.urlopen(req, timeout=60).read().decode()
has_text = '"type": "text"' in events
print("chat with skill streamed text:", has_text)

# upload via multipart
import uuid
boundary = "----webboundary" + uuid.uuid4().hex
filename = "utest.txt"
file_bytes = b"hello upload world\n"
mp = []
mp.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n\r\n".encode())
mp.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: text/plain\r\n\r\n".encode())
mp.append(file_bytes)
mp.append(f"\r\n--{boundary}--\r\n".encode())
data = b"".join(mp)
req2 = urllib.request.Request(
    "http://127.0.0.1:8000/api/files/upload",
    data=data, headers={**H, "Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST",
)
print("upload:", json.load(urllib.request.urlopen(req2)))

dl = get("/api/files/download?path=utest.txt")
print("download:", dl.read().decode().strip())

print("ALL ENDPOINT CHECKS DONE")