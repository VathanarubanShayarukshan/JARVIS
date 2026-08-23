# JARVIS

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
locally (needs lots of CPU/GPU/RAM). JARVIS fixes that:

1. The **self-hoster adds one free-tier key** — Google Gemini, Groq, or
   OpenRouter all give free API keys (no credit card) and fast free models
   that understand tool calling.
2. All users of the web app just log in with their password — **no keys
   anywhere on the client**.
3. A local LLM is still auto-detected as a bonus if one happens to run on the
   server — it is never required.

## Features

- Built-in web UI: chat, session history, streaming replies, tool activity cards,
  **file upload/download**, **skills** (Code Review, Explain, Build & Fix…),
  **voice chat (walkie-talkie mode)**, suggestion chips, responsive design
- Agent loop with tool calling: read/write/edit files, run shell commands,
  search the web, fetch pages — all inside a sandboxed workspace folder
- Skills: drop any `skills/*.md` instruction pack in; pick it in the UI or
  via `"skill"` in the API (see `docs/SKILLS.md`)
- **TinyAI built-in local model** (`builtin://tiny`): zero-install, no network,
  English + Tamil, simple math — plus optional **Ollama** local LLM support
- API + admin UI: providers (any OpenAI-compatible endpoint), API tokens for
  external tools/web apps, workspace file browser/editor, change password
- Everything persisted in SQLite; zero external dependencies beyond the LLM API
- Single-process deploy: `python -m app.main`, `./agentic.sh`, or Docker

Docs: `docs/GETTING_STARTED.md`, `docs/API.md`, `docs/SKILLS.md`,
`docs/OPENCODE.md` (free key), `docs/VOICE.md`, `docs/TINY_LOCAL.md`.
WhatsApp bot: `whatsapp/` (`.agent` mode drives this API from chat).

## Quick start (self-host)

Requirements: Python 3.11+ (or Docker).

Linux / macOS:
```bash
git clone https://github.com/VathanarubanShayarukshan/JARVIS.git
cd my-agentic-ai
./agentic.sh install     # venv + deps + .env
./agentic.sh start       # run in background
./agentic.sh status      # health check
./agentic.sh logs -f     # tail the logs
```

Windows:
```bat
start.bat
```

Or manually:
```bash
pip install -r requirements.txt
python -m app.main
```

Open http://localhost:8000 — first-run screen asks you to set an admin
password. Then go to **Settings → Models** and paste a free key:

| Provider | Free key | Free, tool-capable models |
| --- | --- | --- |
| Google Gemini | https://aistudio.google.com/apikey | `gemini-3.6-flash` |
| Groq | https://console.groq.com/keys | `llama-3.3-70b-versatile` |
| OpenRouter | https://openrouter.ai/settings/keys | models ending in `:free` |
| Hugging Face | https://huggingface.co/settings/tokens | free models via `router.huggingface.co` |
| OpenCode Zen | https://opencode.ai/auth | `deepseek-v4-flash-free`, `qwen3.6-plus-free`, … (see `docs/OPENCODE.md`) |

Not connected yet? TinyAI (built-in) and Ollama (local) work with **no key**
at all — see `docs/TINY_LOCAL.md`.

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
| `OPEN_ACCESS` | `true` to disable token auth (LAN only — see Security notes) |
| `ADMIN_TOKEN` | pre-set admin password instead of first-run setup |
| `WORKSPACE_DIR` | folder the agent may read/write/run commands in |
| `DEFAULT_MODEL` | default model id when client picks none |
| `PROVIDER_BASE_URL` / `PROVIDER_API_KEY` / `PROVIDER_MODELS` | hard-code one OpenAI-compatible provider |
| `MAX_TOOL_ITERATIONS` / `MAX_MESSAGES` | agent loop safety limits |

## API for your own web apps

The web UI is just a client. Any other app can call the same API with
`Authorization: Bearer <token>`. A ready-made cheat sheet lives at
`scripts/curl-api.sh`; full workflow with raw curl:

```bash
BASE=http://localhost:8000

# 1) first run only — set an admin password (returns the web token)
curl -X POST $BASE/api/auth/setup -H 'Content-Type: application/json' \
  -d '{"password":"secret"}'

# 2) login (returns the web token) — or mint a dedicated API token for the app
curl -X POST $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"password":"secret"}'
curl -X POST $BASE/api/tokens -H "Authorization: Bearer <web-token>" \
  -H 'Content-Type: application/json' -d '{"name":"my-app"}'   # -> {"token": "..."}

TOKEN=<token from above>

# 3) pick a provider/model
curl -H "Authorization: Bearer $TOKEN" $BASE/api/providers          # list + models
curl -X POST $BASE/api/providers/probe -H 'Content-Type: application/json' \
  -d '{"base_url":"https://generativelanguage.googleapis.com/v1beta/openai/"}' \
  -H "Authorization: Bearer $TOKEN"                                 # verify a URL

# 4) create a session and chat (SSE stream, one line per event)
SID=$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" $BASE/api/sessions | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -N -X POST $BASE/api/chat \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"session_id\":\"$SID\",\"message\":\"list the files and summarize\",\"model\":\"gemini-3.6-flash\"}"
#   -> data: {"type":"status","status":"thinking"}\n\n
#      data: {"type":"tool_call","name":"list_dir","args":{...}}\n\n
#      data: {"type":"tool_result",...}\n\n
#      data: {"type":"text","text":"..."}\n\n
#      data: {"type":"done","messages":2,"duration":42.3}\n\n

# 5) read it back / manage files
curl -H "Authorization: Bearer $TOKEN" $BASE/api/sessions/$SID/messages
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/files"              # tree
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/files/content?path=notes.md"
```

SSE event types: `status`, `text`, `tool_call`, `tool_result`, `done`,
`error`. Consuming the stream in a custom UI:

```js
const res = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ session_id, message, model }),
});
for (const chunk of parseSSE(await res.body.getReader())) {   // see webui/assets/app.js
  if (chunk.type === "text") render(chunk.text);
  if (chunk.type === "done") done();
}
```

Note: `model` is optional — omit it to use the server default. `provider_id`
is optional too; the server picks the first provider that has a key.
`GET/POST/DELETE /api/sessions`, `GET /api/sessions/{id}/messages`, `GET/POST
/api/files`, `GET /api/files/content`, `POST /api/files/write`,
`POST /api/files/mkdir` are all available (full reference: `app/main.py`).

## Security notes (self-hosting)

- The agent can **run arbitrary shell commands** in the workspace. Only expose
  the server to people you trust, and put it behind a reverse proxy with HTTPS
  (Caddy/nginx) if it's public.
- The workspace folder is enforced for all file tools; the shell tool runs in
  the workspace cwd but is otherwise unrestricted on the host.
- Login/API tokens are stored in the SQLite DB (`data/app.db`). API keys are
  stored plaintext there too — protect the `data/` folder.

## WhatsApp bot

`whatsapp/` contains a Baileys-based WhatsApp bot (Termux/Kali, Node 18+) that
reuses all its modes (`.run` / `.send` / `.get` / `.brows`) and adds an
**`.agent`** mode: it asks for a provider, a model (by number), and a task,
then drives the JARVIS API — with live status via `.pro`
(`Thinking...`, `Running command: ...`) and long replies chunked for
WhatsApp. See `whatsapp/README.md` for setup.

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