# AgenticAI

A self-hosted agentic AI — like OpenCode/OpenWork, but running on **your server
with a free cloud model** and a built-in web UI. No GPU, no Ollama, no local LLM
required, and **end users never need an API key**.

```
User -> Web UI (built in, served by the app)
             |
             v
        FastAPI server  ->  free cloud LLM (Gemini / Groq / OpenRouter, server-side key)
             |  ^
             v  |
        Tools: file read/write/edit, shell commands,
        web search & fetch, workspace management
```

## Why no local LLM?

People running OpenCode/OpenWork-style agents on laptops can't run a good model
locally (needs lots of CPU/GPU/RAM). AgenticAI fixes that:

1. The **self-hoster adds one free-tier key** — Google Gemini, Groq, or
   OpenRouter all give free API keys (no credit card) and fast free models
   that understand tool calling.
2. All users of the web app just log in with their password — **no keys
   anywhere on the client**.
3. A local LLM is still auto-detected as a bonus if one happens to run on the
   server — it is never required.

## Features

- Built-in web UI: chat, session history, streaming replies, tool activity cards
- Agent loop with tool calling: read/write/edit files, run shell commands,
  search the web, fetch pages — all inside a sandboxed workspace folder
- API + admin UI: providers (any OpenAI-compatible endpoint), API tokens for
  external tools/web apps, workspace file browser/editor, change password
- Everything persisted in SQLite; zero external dependencies beyond the LLM API
- Single-process deploy: `python -m app.main`, or Docker

## Quick start (self-host)

Requirements: Python 3.11+ (or Docker).

```bash
pip install -r requirements.txt
python -m app.main
```

Open http://localhost:8000 — first-run screen asks you to set an admin
password. Then go to **Settings → Models** and paste a free key:

| Provider | Free key | Free, tool-capable models |
| --- | --- | --- |
| Google Gemini | https://aistudio.google.com/apikey | `gemini-2.5-flash` |
| Groq | https://console.groq.com/keys | `llama-3.3-70b-versatile` |
| OpenRouter | https://openrouter.ai/settings/keys | models ending in `:free` |

Click **Check connectivity**, then **Set key** on the provider row. Pick the
model in the top-right dropdown and start chatting. That's it — every other
user just signs in with the admin password and gets the full agent.

### Docker

```bash
docker build -t agentic-ai .
docker run -d -p 8000:8000 -v agentic-data:/data agentic-ai
```

## Configuration (`.env`, all optional)

| Variable | Meaning |
| --- | --- |
| `PORT` | listen port (default 8000) |
| `ADMIN_TOKEN` | pre-set admin password instead of first-run setup |
| `WORKSPACE_DIR` | folder the agent may read/write/run commands in |
| `DEFAULT_MODEL` | default model id when client picks none |
| `PROVIDER_BASE_URL` / `PROVIDER_API_KEY` / `PROVIDER_MODELS` | hard-code one OpenAI-compatible provider |
| `MAX_TOOL_ITERATIONS` / `MAX_MESSAGES` | agent loop safety limits |

## API for your own web apps

The web UI is just a client. Any other app can call the same API with
`Authorization: Bearer <token>` (create tokens in **Settings → API tokens**):

```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"session_id":"<id>","message":"hello"}'
```

SSE event stream: `status`, `text`, `tool_call`, `tool_result`, `done`,
`error`. Also available: `GET/POST/DELETE /api/sessions`, `GET
/api/sessions/{id}/messages`, `GET/POST /api/files`, `GET /api/files/content`,
`POST /api/files/write` (see `app/main.py`).

## Security notes (self-hosting)

- The agent can **run arbitrary shell commands** in the workspace. Only expose
  the server to people you trust, and put it behind a reverse proxy with HTTPS
  (Caddy/nginx) if it's public.
- The workspace folder is enforced for all file tools; the shell tool runs in
  the workspace cwd but is otherwise unrestricted on the host.
- Login/API tokens are stored in the SQLite DB (`data/app.db`). API keys are
  stored plaintext there too — protect the `data/` folder.

## Development / testing

`scripts/stub_provider.py` is a fake OpenAI-compatible LLM that replies with a
scripted tool call + text, so you can test the full agent loop end-to-end
without any API key:

```bash
python scripts/stub_provider.py &   # listens on :9500
python -m app.main                  # then: Settings -> Models -> add custom
#   name: Stub   url: http://127.0.0.1:9500/v1   key: anything
#   models: stub-1   -> chat and watch it "create" a file
```