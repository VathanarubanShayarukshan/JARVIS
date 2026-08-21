# Fake OpenAI-compatible LLM for development/testing without any API key.
# Serves /v1/models and /v1/chat/completions (streaming).
# First assistant turn: emits a write_file tool call.
# Second turn: emits a final text answer that mentions the file.

import json
import os
import time
import uuid

from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 9500
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "stub_requests.jsonl")


def sse_chunk(payload: dict) -> bytes:
    return b"data: " + json.dumps(payload).encode() + b"\n\n"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def _send(self, status: int, obj: dict, ctype: str = "application/json"):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._send(200, {"object": "list", "data": [{"id": "stub-1", "object": "model"}]})
        else:
            self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._send(404, {"error": {"message": "not found"}})
            return
        body = self._json_body()
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"messages": body.get("messages", [])}, ensure_ascii=False) + "\n")
        messages = body.get("messages", [])
        user_turn = next(
            (m["content"] for m in reversed(messages) if m["role"] == "user"),
            "",
        )
        has_tool_result = any(m["role"] == "tool" for m in messages)

        if has_tool_result:
            # final answer, mention the tool result
            last_tool = next(m["content"] for m in reversed(messages) if m["role"] == "tool")
            text = (
                "I created the file for you. The tool wrote a file called "
                f"`{user_turn}` (I stored the tool output). Summary: {last_tool[:80]}...\n\n"
                "Everything is saved in the workspace. Check it in `Settings -> Files`."
            )
        else:
            # first turn: a scripted tool call that creates a file
            text = ""
            tool_call = {
                "id": f"call_{uuid.uuid4().hex[:8]}",
                "type": "function",
                "extra_content": {"google": {"thought_signature": f"sig_{uuid.uuid4().hex[:16]}"}},
                "function": {
                    "name": "write_file",
                    "arguments": json.dumps(
                        {"path": "hello.txt", "content": "Hello from JARVIS stub provider!\n"}
                    ),
                },
            }

        resp_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        created = int(time.time())
        done = {"id": resp_id, "object": "chat.completion.chunk", "created": created, "model": "stub-1"}

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        # model state line
        self.wfile.write(
            sse_chunk(
                {
                    **done,
                    "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}],
                }
            )
        )
        if not has_tool_result:
            self.wfile.write(
                sse_chunk(
                    {
                        **done,
                        "choices": [
                            {"index": 0, "delta": {"role": "assistant", "content": "", "tool_calls": [tool_call]}, "finish_reason": None}
                        ],
                    }
                )
            )
            time.sleep(0.2)
        else:
            # stream the final text in chunks
            for atom in [text[i : i + 12] for i in range(0, len(text), 12)]:
                self.wfile.write(
                    sse_chunk(
                        {
                            **done,
                            "choices": [{"index": 0, "delta": {"role": "assistant", "content": atom}, "finish_reason": None}],
                        }
                    )
                )
                time.sleep(0.05)
        # finish
        self.wfile.write(
            sse_chunk(
                {
                    **done,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
            )
        )
        self.wfile.write(b"data: [DONE]\n\n")


if __name__ == "__main__":
    print(f"Stub OpenAI-compatible LLM listening on http://127.0.0.1:{PORT}/v1")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()