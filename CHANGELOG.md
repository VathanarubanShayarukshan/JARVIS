# Changelog

## 0.4.0 (2026-08-19)

- Skills system: `skills/*.md` instruction packs, `/api/skills` endpoint,
  skill picker in the web UI, `"skill"` field in `/api/chat`
  (docs/SKILLS.md).
- File transfer in the web UI: upload (multipart, multiple files) and
  download buttons in Settings → Files; `/api/files/upload` +
  `/api/files/download`.
- Full GUI restyle: gradient theme, glass cards, chat bubbles, suggestion
  chips, responsive layout, hover states.
- `agentic.sh` launcher: install / setup / start / stop / restart / status /
  logs / update.
- Docs: GETTING_STARTED.md, API.md, SKILLS.md, AGENTS.md, CHANGELOG.md.
- WhatsApp bot (whatsapp/): `.agent` mode, QR login, run.sh.

## 0.3.0 (2026-08-19)

- Model chooser grouped by provider (optgroup), per-session model memory.
- Hugging Face preset + big model-import handling.
- `OPEN_ACCESS=true` tokenless mode.

## 0.2.0 (2026-08-18)

- Gemini 3.x `thought_signature` echo-back; rate-limit retry with Retry-After.
- PowerShell-compatible shell tool; `/workspace` prefix tolerance.
- Compact activity pill + collapsible tool log in the UI.

## 0.1.0 (2026-08-18)

- Initial release: FastAPI server, web UI, agent loop with file/shell/web
  tools, free provider presets (Gemini/Groq/OpenRouter), API tokens,
  SQLite persistence, stub provider + smoke tests.