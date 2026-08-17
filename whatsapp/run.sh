#!/usr/bin/env bash
# Run the WhatsApp bot (Baileys) for AgenticAI.
#   - reads AgenticAI server config from whatsapp/.env if present,
#     otherwise uses defaults
#   - installs missing npm packages on first run
#   - presses nothing: press Enter at the prompt for QR login
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f package.json ]; then
  echo "==> Initializing package.json"
  npm init -y >/dev/null
fi

echo "==> Checking dependencies"
npm install --no-audit --no-fund --silent @whiskeysockets/baileys pino puppeteer qrcode-terminal

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export AGENTIC_URL="${AGENTIC_URL:-http://localhost:8000}"
export AGENTIC_PASSWORD="${AGENTIC_PASSWORD:-test-pass}"

echo "==> AgenticAI server: ${AGENTIC_URL}"
echo "==> Starting WhatsApp bot (press Enter at the prompt for QR login)"
node index.js