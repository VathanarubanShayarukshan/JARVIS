"""List providers from the running server using the DB web token."""
import json
import sqlite3
import urllib.request

tok = sqlite3.connect("data/app.db").execute(
    "SELECT value FROM settings WHERE key='web_token'"
).fetchone()[0]
req = urllib.request.Request(
    "http://127.0.0.1:8000/api/providers",
    headers={"Authorization": "Bearer " + tok},
)
ps = json.load(urllib.request.urlopen(req))
for p in ps:
    print(p["id"], "|", p["name"], "| custom:", p["is_custom"], "| models:", len(p.get("models") or []))