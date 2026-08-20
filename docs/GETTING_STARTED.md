# Getting Started

Run your own agentic AI on any server — no GPU, no local LLM, and end users
never need an API key.

## 1. Install & start

Linux / macOS:

```bash
git clone https://github.com/VathanarubanShayarukshan/my-agentic-ai.git
cd my-agentic-ai
./agentic.sh install
./agentic.sh start
```

Windows: double-click `start.bat`.

Docker:

```bash
docker build -t agentic-ai .
docker run -d -p 8000:8000 -v agentic-data:/data agentic-ai
```

## 2. First run

1. Open `http://localhost:8000` — the first-run screen asks for an admin
   password. Everyone else signs in with the same password.
2. **Settings → Models** → paste one **free** key (no credit card):

| Provider | Free key at | Free tool-capable model |
| --- | --- | --- |
| Google Gemini | https://aistudio.google.com/apikey | `gemini-3.6-flash` |
| Groq | https://console.groq.com/keys | `llama-3.3-70b-versatile` |
| OpenRouter | https://openrouter.ai/settings/keys | models ending in `:free` |
| Hugging Face | https://huggingface.co/settings/tokens | free models via `router.huggingface.co` |

Click **Check connectivity**, then **Set key**. That's it — the model runs on
the **server**, users just chat.

## 3. Chat

- Pick a model in the top-right dropdown (grouped per provider).
- Pick a **skill** in the top-left dropdown (Code Review, Explain, Build & Fix…)
  to steer how the agent works.
- The agent can read/write/edit files, run shell commands and search the web —
  all inside the workspace folder.

## 4. Files

**Settings → Files**: browse the workspace, click to edit, **save** changes,
**upload** files from your computer, and **download** any file.

## 5. WhatsApp

`whatsapp/` has a Baileys bot with an `.agent` mode that drives this API from
WhatsApp. See `whatsapp/README.md`.

## 6. API & tokens

Other apps call the same API. Create a token in **Settings → API tokens** and
see `docs/API.md` for the curl one-liners.