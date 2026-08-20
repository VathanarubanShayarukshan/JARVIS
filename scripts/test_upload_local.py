from fastapi import FastAPI, File, Form, UploadFile
from fastapi.testclient import TestClient

app = FastAPI()

@app.post("/up")
async def up(path: str = Form(""), files: list[UploadFile] = File(...)):
    names = [f.filename for f in files]
    return {"path": path, "files": names}

c = TestClient(app)

# empty path + one file
r = c.post("/up", files=[("file", ("a.txt", b"hi", "text/plain"))], data={"path": ""})
print("no path field   ->", r.status_code, r.json())

r2 = c.post("/up", files=[("file", ("b.txt", b"hi", "text/plain"))])
print("path absent     ->", r2.status_code, r2.json())

r3 = c.post("/up", files=[("file", ("c.txt", b"hi", "text/plain")), ("file", ("d.txt", b"x", "text/plain"))], data={"path": "sub"})
print("two files       ->", r3.status_code, r3.json())