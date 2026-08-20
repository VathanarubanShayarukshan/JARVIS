# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Stack

- Python 3.11+ backend: FastAPI (`app/main.py`), SQLite (`app/database.py`),
  agent loop (`app/agent.py`), LLM client (`app/llm.py`).
- Vanilla JS frontend, no build step: `webui/index.html`,
  `webui/assets/app.js`, `webui/assets/style.css`.
- LLM providers are OpenAI-compatible HTTPS endpoints only (Gemini/Groq/
  OpenRouter/HF router); no local inference is required.

## Conventions

- No comments in code unless asked; keep existing style.
- Server-side: `from .config import settings` for config; DB access via
  `app/database.py` helpers, never raw sqlite in views.
- API style: JSON everywhere; errors are `{"detail": "..."}`; auth is
  `Authorization: Bearer <token>` (`require_web` = admin, `require_any` =
  web token or API token). `OPEN_ACCESS=true` disables both (main.py).
- SSE stream for `/api/chat`: status/tool_call/tool_result/text/done/error.
- Skills live in `skills/*.md` (see `docs/SKILLS.md`) and are read per
  request — edit or add files, no restart.
- The agent may only touch the configured workspace folder (`settings.workspace`):
  `_fs_resolve()` enforces it; shell executes with the workspace as cwd.

## Tests

- `scripts/smoke_test.py` — end-to-end suite against a stub provider
  (`scripts/stub_provider.py` on :9500).
- `node --check webui/assets/app.js` for the UI syntax.
- `bash -n` on any `.sh` shell script.

## Secrets

- Never commit keys: `data/`, `data-test/`, `.env`, `*.log`,
  `stub_requests.jsonl`, `.venv/` are gitignored. API keys are stored
  plaintext in `data/app.db` — protect `data/`.