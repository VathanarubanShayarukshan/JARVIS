# Slow OpenAI-compatible LLM used to test background jobs: streams for ~6s.

import json
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 9504
STEPS = 12
STEP_DELAY = 0.5


def sse_chunk(payload: dict) -> bytes:
    return b"data: " + json.dumps(payload).encode() + b"\n\n"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, status: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._send(200, {"object": "list", "data": [{"id": "slow-6", "object": "model"}]})
        else:
            self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._send(404, {"error": {"message": "not found"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)

        resp_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        base = {"id": resp_id, "object": "chat.completion.chunk", "created": int(time.time()), "model": "slow-6"}

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(delta, finish=None):
            self.wfile.write(sse_chunk({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}))
            self.wfile.flush()

        emit({"role": "assistant", "content": ""})
        for i in range(STEPS):
            time.sleep(STEP_DELAY)
            emit({"content": f"step {i + 1}/{STEPS} "})
        emit({"content": "\n\nslow work finished"})
        emit({}, "stop")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


if __name__ == "__main__":
    print(f"Slow stub LLM listening on http://127.0.0.1:{PORT}/v1")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()