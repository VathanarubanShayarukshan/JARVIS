# HTTP API

All routes answer with JSON except `/api/chat` (SSE stream) and
`/api/files/download` (binary). Auth: `Authorization: Bearer <token>` where
the token is either the web token (from login) or an API token (Settings →
API tokens).

Open access: set `OPEN_ACCESS=true` in `.env` to disable auth entirely
(LAN only — the agent can run shell commands).

Cheat sheet script: `scripts/curl-api.sh`.

## Meta & auth

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | — | status, setup_done, workspace path |
| POST | `/api/auth/setup` | `{password}` | first-run admin password (returns web token) |
| POST | `/api/auth/login` | `{password}` | returns web token |
| POST | `/api/auth/change-password` | `{password}` | change admin password (admin) |

## Providers

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| GET | `/api/providers` | — | providers + models + api_key_set (admin) |
| POST | `/api/providers/probe` | `{base_url, api_key?}` | list models from any OpenAI-compatible URL |
| POST | `/api/providers` | `{name, base_url, api_key?, models?}` | add custom provider (admin) |
| PUT | `/api/providers/{id}` | `{api_key?, models?}` | save key / models (admin) |
| DELETE | `/api/providers/{id}` | — | delete custom provider (admin) |

## Chat & sessions

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| GET | `/api/sessions` | — | list sessions |
| POST | `/api/sessions` | — | create session → `{id, ...}` |
| GET | `/api/sessions/{id}/messages` | — | full history |
| DELETE | `/api/sessions/{id}` | — | delete |
| POST | `/api/sessions/{id}/title` | `{title}` | rename |
| POST | `/api/chat` | `{session_id, message, provider_id?, model?, skill?}` | SSE agent run |
| GET | `/api/models` | — | default model |
| GET | `/api/skills` | — | available skills |

`provider_id` and `model` are optional — omit to use the server default
(first provider with a key). `skill` is optional; e.g. `"code-review"`.

### `/api/chat` SSE events

```
data: {"type":"status","message":"Thinking..."}
data: {"type":"tool_call","id":"...","name":"write_file","arguments":{...}}
data: {"type":"tool_result","id":"...","name":"write_file","result":"..."}
data: {"type":"text","text":"streamed text"}
data: {"type":"done","content":"final answer","messages":2,"duration":12.3}
data: {"type":"error","message":"..."}
```

One-liner:

```bash
T=$(curl -s -X POST localhost:8000/api/auth/login -d '{"password":"pass"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
S=$(curl -s -X POST -H "Authorization: Bearer $T" localhost:8000/api/sessions | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl -N -X POST localhost:8000/api/chat -H "Authorization: Bearer $T" \
  -d "{\"session_id\":\"$S\",\"message\":\"hello\",\"skill\":\"code-review\"}"
```

## Files (workspace)

| Method | Path | Params | Purpose |
| --- | --- | --- | --- |
| GET | `/api/files` | `?path=` | list directory |
| GET | `/api/files/content` | `?path=` | read text file (≤ 500 KB) |
| POST | `/api/files/write` | `{path, content}` | write text file |
| POST | `/api/files/mkdir` | `{path}` | create directory |
| POST | `/api/files/upload` | multipart `path` + `file`(s) | upload files (admin-free) |
| GET | `/api/files/download` | `?path=` | download a file |

Upload example:

```bash
curl -X POST localhost:8000/api/files/upload -H "Authorization: Bearer $T" \
  -F "path=projects/demo" -F "file=@report.pdf" -F "file=@photo.png"
```

## API tokens (admin)

| Method | Path | Body | Purpose |
| --- | --- | --- | --- |
| GET | `/api/tokens` | — | list tokens |
| POST | `/api/tokens` | `{name}` | create → returns the token once |
| DELETE | `/api/tokens/{id}` | — | delete |

## Errors

Errors are JSON: `{"detail": "..."}` with HTTP 400/401/403/404.