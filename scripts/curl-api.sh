#!/usr/bin/env bash
# AgenticAI REST API cheat sheet for custom UIs (curl).
#
# Setup:
#   BASE=http://localhost:8000
#   1) First run only:  ./scripts/curl-api.sh setup 'your-admin-password'
#   2) Login:           ./scripts/curl-api.sh login 'your-admin-password'
#   3) Long-lived token for your custom UI:
#                      ./scripts/curl-api.sh tok 'my-app'
#   TOKEN=$(... your app token ...)  # paste the generated token below
set -euo pipefail
BASE="${BASE:-http://localhost:8000}"
TOKEN="${TOKEN:-}"
SID="${SID:-}"

json() { printf '%s' "$1" | curl -fsS -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" "${BASE}${2}" "${@:3}"; }

usage() { echo "Commands: setup <pass> | login <pass> | tok <name> | sessions | new | chat <msg> | msgs | providers | health"; exit 0; }

case "${1:-}" in
  health) curl -fsS "$BASE/api/health"; echo;;
  setup)   # first run only: create admin password, prints web token
    curl -fsS -X POST "$BASE/api/auth/setup" -H 'Content-Type: application/json' \
      -d "{\"password\":\"$2\"}"; echo;;
  login)   # returns the web token (use it or mint a dedicated API token below)
    curl -fsS -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
      -d "{\"password\":\"$2\"}"; echo;;
  tok)     # long-lived API token for your custom UI (needs web TOKEN set)
    json "{\"name\":\"$2\"}" /api/tokens; echo;;
  providers) json '{}' /api/providers; echo;;
  sessions)  json '{}' /api/sessions; echo;;
  new)       curl -fsS -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions"; echo;;
  chat)      # SSE stream; requires SID (session id from 'new') and TOKEN
    curl -fsSN -X POST "$BASE/api/chat" -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $TOKEN" \
      -d "{\"session_id\":\"$SID\",\"message\":\"$2\",\"model\":\"${3:-}\"}";;
  msgs)      [[ -n "$SID" ]] || { echo "set SID=<session-id>"; exit 1; }
    curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/api/sessions/$SID/messages"; echo;;
  *) usage;;
esac