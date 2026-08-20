# Local models: TinyAI (built-in) and Ollama

You don't need any cloud key at all for light everyday use: AgenticAI ships
with a **zero-install local model** and can optionally drive a real local LLM
via Ollama.

## TinyAI — built-in, instant, no network (default fallback)

TinyAI is a tiny rule-based model that lives inside the server. No install,
no network, no key, no GPU — it answers instantly and is perfect for tests,
offline setups, and simple everyday inputs.

| Setting | Value |
| --- | --- |
| Provider | `TinyAI (built-in, instant)` |
| Base URL | `builtin://tiny` |
| Model | `tiny-answer-bot` |

It understands (in **English and Tamil**):

- greetings, how-are-you, who-are-you, help/abilities, thanks, bye
- simple arithmetic: `12 * 8`, `(45 + 15) / 3`, `17 % 5`
- time / date questions
- anything else → a short honest reply telling you to pick a real provider

To use it: restart the server, open **Settings → Models**, see
"TinyAI (built-in, instant)" in the provider list, and choose the model
`tiny-answer-bot` in the top-right dropdown. It works even with `OPEN_ACCESS`
off and with no key stored — it is served by the app itself
(`app/tinyml.py`).

> Tip: put `tiny-answer-bot` as the **first** model in a provider's list to
> get cheap instant answers, and let humans pick a big cloud model when they
> actually need an agent.

## Ollama — real local LLM (optional, free)

For real local intelligence (no internet, no key):

1. Install Ollama: https://ollama.com (Windows/macOS/Linux).
2. Pull a small model — 1B–3B runs fine on a laptop CPU:
   ```bash
   ollama pull llama3.2
   ollama pull qwen2.5:0.5b
   ```
3. Ollama serves an OpenAI-compatible API at `http://localhost:11434/v1`
   automatically. AgenticAI auto-detects it (see Settings → Models — it
   appears as "Ollama (local, no key)" when it is running) and there is also
   a preset row with the tiny models `llama3.2:1b`, `qwen2.5:0.5b`,
   `phi3:mini`.

Bigger models (7B+) are noticeably slower on CPU-only machines — for a light
setup stick to 0.5B–4B.

## What to pick when

| Need | Provider |
| --- | --- |
| Instant, offline, trivial questions | `TinyAI (built-in, instant)` |
| Real local reasoning, no internet | `Ollama (local, no key)` |
| Best free cloud agent (coding/files/bash) | Gemini / Groq / OpenCode Zen (see `docs/OPENCODE.md`) |