# WhatsApp Bot (Baileys) + JARVIS

Runs your WhatsApp bot on Termux/Kali Linux (or any Node 18+ box) and adds a
new **`.agent`** mode that drives the JARVIS server.

## Setup (Termux / Ubuntu on Termux)

```bash
pkg install nodejs git   # or: apt install nodejs git
mkdir -p ~/Termux && cd ~/Termux
git clone https://github.com/VathanarubanShayarukshan/JARVIS.git
cd my-agentic-ai/whatsapp
npm init -y
npm i @whiskeysockets/baileys pino puppeteer qrcode-terminal
```

## Run

One command handles everything (config + deps + start):

```bash
./run.sh
```

It reads `whatsapp/.env` if present (optional):

```bash
AGENTIC_URL=http://localhost:8000
AGENTIC_PASSWORD=test-pass
```

Otherwise defaults `http://localhost:8000` / `test-pass` are used. Missing npm
packages are installed automatically on first run. Manual alternative:

```bash
export AGENTIC_URL=http://localhost:8000
export AGENTIC_PASSWORD=test-pass
node index.js
```

## Login to WhatsApp (two ways)

**1. Web-UI style (QR code)** — easiest, no phone number needed:

- At the prompt `Enter your WhatsApp number...` just press **Enter**
- a QR code prints in the terminal — open WhatsApp on your phone →
  **Menu ⋮ → Linked devices → Link a device** → scan it
- the QR auto-refreshes if it expires; scanning logs the bot in

**2. Pairing code** — when you can't scan (e.g. remote box):

- type your number with country code (`9477...`, no `+` or spaces)
- a **pairing code** prints (`🔑 YOUR VALID PAIRING CODE IS: ...`)
- in WhatsApp → **Linked devices → Link a device → Link with phone
  number instead** → enter the code

Both methods store the session in `auth_session/` — next run reconnects
automatically. To log in as a different account, delete the `auth_session`
folder first and restart.

## Commands

| Command | Meaning |
| --- | --- |
| `.help` | command guide |
| `.run <cmd>` | Linux terminal in `/home/ubuntu` (cd persists) |
| `.send <file>` | download a file as WhatsApp media |
| `.get <path>` | send media/document with caption to upload it |
| `.brows <url> [-p scroll] [-d delay]` | headless screenshot of a page |
| `.agent` | **JARVIS mode**: pick provider → pick model (by number) → describe the task → reply with the agent's output |
| `.pro` | live status — in agent mode shows `Thinking...` / `Running command: ...` |
| `.kill` | abort the running task (agent mode: aborts the JARVIS task) |
| `.stop` | exit the current mode |

## How `.agent` works

1. `.agent` → bot lists providers with ids (`1. Google Gemini (free) ✅` …)
2. reply with the provider number → bot lists that provider's models with ids
3. reply with the model number → bot asks for the task
4. send the task → bot streams the JARVIS run; `.pro` shows live status
   (status events, `Running command: write_file {…}`, result received)
5. final output is sent back (long replies are chunked into 3900-char messages)
6. send another task to continue, or `.stop` to exit

Notes:
- Uses the server-side provider keys — WhatsApp users never need API keys.
- Works with `OPEN_ACCESS=true` servers too (login is attempted, then skipped).
- `AGENTIC_MAX_MODELS` caps the numbered list (default 40) to fit WhatsApp limits.
