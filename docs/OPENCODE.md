# OpenCode Zen (free provider)

OpenCode Zen is an OpenAI-compatible API with a **free tier** — free models and
a free API key with **no credit card required** for the free models.

## Get a free API key

1. Go to https://opencode.ai/auth and create an account (email or GitHub sign-in).
2. Open your Dashboard → **API keys** (or Settings → API keys) and click
   **Create new key**.
3. Copy the key — it is stored only on your server (`data/app.db`), never
   shown to your users.

Access is free for the models ending in `-free`. If a paid endpoint later
asks for billing details, the `-free` models keep working without them.

## Add it to JARVIS

The preset is already in the provider list after a restart:

- **Settings → Models** → the "OpenCode Zen (free)" row should appear.
- Click **Check connectivity**, then **Set key** and paste your key.
- Pick a model in the top-right dropdown, e.g. `deepseek-v4-flash-free`.

## Details

| Setting | Value |
| --- | --- |
| Base URL | `https://opencode.ai/zen/v1` |
| Chat endpoint | `https://opencode.ai/zen/v1/chat/completions` (OpenAI-compatible) |
| Models | `deepseek-v4-flash-free`, `nemotron-3-ultra-free`, `mimo-v2.5-free`, `big-pickle`, `qwen3.6-plus-free`, `minimax-m3-free`, `north-mini-code-free`, … |
| Key rule | `Bearer <key>` header |

The **Check connectivity** button probes `/models` and can import the full
free model list into the box.

> Tip: keep this as a second provider — if your primary free provider rate-
> limits you, the agent loop retries with another model in the list.