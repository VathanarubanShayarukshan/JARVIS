#!/usr/bin/env bash
# One-shot setup + start for Linux/macOS self-hosting.
# Windows users: just double-click start.bat instead.
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || PY=python

echo "==> Creating virtualenv (.venv)"
if [ ! -d ".venv" ]; then
  "$PY" -m venv .venv
fi

echo "==> Installing dependencies"
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r requirements.txt

if [ ! -f ".env" ]; then
  echo "==> Creating .env from .env.example"
  cp .env.example .env
fi

echo "==> Starting JARVIS at http://localhost:${PORT:-8000}"
echo "    (first run: set your admin password in the browser, then add a free"
echo "     provider key under Settings > Models - Gemini / Groq / OpenRouter / HF)"
exec .venv/bin/python -m app.main