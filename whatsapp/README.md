# WhatsApp Bot (Baileys) + AgenticAI

Runs your WhatsApp bot on Termux/Kali Linux (or any Node 18+ box) and adds a
new **`.agent`** mode that drives the AgenticAI server.

## Setup (Termux / Ubuntu on Termux)

```bash
pkg install nodejs git   # or: apt install nodejs git
mkdir -p ~/Termux && cd ~/Termux
git clone https://github.com/VathanarubanShayarukshan/my-agentic-ai.git
cd my-agentic-ai/whatsapp
npm init -y
npm i @whiskeysockets/baileys pino puppeteer
```

## Configure

```bash
# where your AgenticAI server runs (localhost if it's on the same box)
export AGENTIC_URL=http://localhost:8000
# admin password for the AgenticAI web UI / API
export AGENTIC_PASSWORD=test-pass
node index.js
```

Enter your WhatsApp number with country code → a **pairing code** prints →
enter it in WhatsApp → Linked Devices. If `AGENTIC_URL`/`AGENTIC_PASSWORD`
are unset, defaults are `http://localhost:8000` / `test-pass`.

## Commands

| Command | Meaning |
| --- | --- |
| `.help` | command guide |
| `.run <cmd>` | Linux terminal in `/home/ubuntu` (cd persists) |
| `.send <file>` | download a file as WhatsApp media |
| `.get <path>` | send media/document with caption to upload it |
| `.brows <url> [-p scroll] [-d delay]` | headless screenshot of a page |
| `.agent` | **AgenticAI mode**: pick provider → pick model (by number) → describe the task → reply with the agent's output |
| `.pro` | live status — in agent mode shows `Thinking...` / `Running command: ...` |
| `.kill` | abort the running task (agent mode: aborts the AgenticAI task) |
| `.stop` | exit the current mode |

## How `.agent` works

1. `.agent` → bot lists providers with ids (`1. Google Gemini (free) ✅` …)
2. reply with the provider number → bot lists that provider's models with ids
3. reply with the model number → bot asks for the task
4. send the task → bot streams the AgenticAI run; `.pro` shows live status
   (status events, `Running command: write_file {…}`, result received)
5. final output is sent back (long replies are chunked into 3900-char messages)
6. send another task to continue, or `.stop` to exit

Notes:
- Uses the server-side provider keys — WhatsApp users never need API keys.
- Works with `OPEN_ACCESS=true` servers too (login is attempted, then skipped).
- `AGENTIC_MAX_MODELS` caps the numbered list (default 40) to fit WhatsApp limits.
