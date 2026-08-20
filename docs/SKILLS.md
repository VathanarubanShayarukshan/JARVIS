# Skills

Skills are markdown instruction packs stored in `skills/*.md`. They steer how
the agent handles a task — like Copilot-style skills/context. Anyone can pick
one in the web UI (top-left dropdown) or via the API (`"skill": "<id>"` in
`/api/chat`).

## Built-in skills

| id | Title | What it does |
| --- | --- | --- |
| `code-review` | Code Review Expert | Reviews workspace code: bugs, security, performance, verdict |
| `explain-code` | Explain Code Simply | Explains code to a beginner, part by part |
| `build-and-fix` | Build & Fix | Builds/runs/tests a project and fixes it until it works |

## Write your own

Create `skills/<id>.md`:

```markdown
# Friendly Translator
description: Translate any text to Tamil and back.

Act as a professional translator:
1. If the text is in English, translate it to Tamil.
2. If it is in Tamil, translate it to English.
3. Keep numbers, code and names unchanged.
```

- First line must be `# Title` (shown in the UI dropdown).
- The users' message is appended after `---\n\nTask:`.
- Restart not needed — skills are read from disk on every request.

## Via API

```bash
curl -H "Authorization: Bearer $T" localhost:8000/api/skills
curl -N -X POST localhost:8000/api/chat -H "Authorization: Bearer $T" \
  -d "{\"session_id\":\"$S\",\"message\":\"translate this\","skill":"friendly-translator\"}"
```