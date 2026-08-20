#!/usr/bin/env bash
# AgenticAI launcher — self-hosted agentic AI with a built-in web UI.
#
#   ./agentic.sh install      create venv, install deps, generate .env
#   ./agentic.sh setup        guided first-run config (password + provider key)
#   ./agentic.sh start        start the server (daemonized)
#   ./agentic.sh stop         stop the server
#   ./agentic.sh restart      stop + start
#   ./agentic.sh status       is it running? which port? workspace?
#   ./agentic.sh logs [-f]    show server logs (tail -f with -f)
#   ./agentic.sh update       git pull + pip install -r requirements.txt
#   ./agentic.sh help         this help
#
# Config is read from ./.env (see .env.example). Defaults:
#   PORT=8000  DATA_DIR=data  WORKSPACE_DIR=$DATA_DIR/workspace
set -uo pipefail

cd "$(dirname "$0")" || exit 1

# ---------- config ----------
ENV_FILE=".env"
PID_FILE="${DATA_DIR:-data}/server.pid"
LOG_FILE="srv.log"
ERR_LOG="srv.err.log"
PY=".venv/bin/python"
PIP=".venv/bin/pip"
PORT="8000"
CONTAINER="agenticai"

load_env() { [ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a; }
ensure_venv() {
  if [ ! -x "$PY" ]; then
    echo "==> Creating virtualenv (.venv)"
    python3 -m venv .venv 2>/dev/null || python -m venv .venv
  fi
}

do_install() {
  ensure_venv
  echo "==> Installing dependencies"
  "$PIP" install --quiet --upgrade pip
  "$PIP" install --quiet -r requirements.txt
  if [ ! -f "$ENV_FILE" ]; then
    cp .env.example "$ENV_FILE"
    echo "==> Created $ENV_FILE from .env.example (edit it, then run ./agentic.sh start)"
  fi
  echo "==> Install complete. Next: ./agentic.sh setup  (or ./agentic.sh start)"
}

do_setup() {
  load_env
  ensure_venv
  [ -f "$ENV_FILE" ] || cp .env.example "$ENV_FILE"
  echo "==> Interactive setup"
  read -rp "Listen port [${PORT}]: " p; [ -n "$p" ] && sed -i.bak "s/^PORT=.*/PORT=$p/" "$ENV_FILE" || sed -i.bak "s/^PORT=.*/PORT=$PORT/" "$ENV_FILE"
  read -rp "Admin password (min 4 chars): " pw
  if [ ${#pw} -ge 4 ]; then
    "$PY" - "$pw" <<'PYEOF'
import sys, sqlite3, secrets
from pathlib import Path
new = sys.argv[1]
p = Path("data")
p.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(p / "app.db")
db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('admin_password',?)", (new,))
db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('web_token',?)", (secrets.token_urlsafe(32),))
db.commit(); db.close()
print("Password saved. Web token generated.")
PYEOF
  else
    echo "  Skipping password (too short) — set it in the web UI on first open instead."
  fi
  echo "==> Setup done. Run ./agentic.sh start"
}

do_start() {
  load_env
  ensure_venv
  PORT="${PORT:-8000}"
  DATA_DIR="${DATA_DIR:-data}"
  PID_FILE="$DATA_DIR/server.pid"
  mkdir -p "$DATA_DIR"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "Already running (pid $(cat "$PID_FILE")). Use 'restart' to bounce it."
    return 0
  fi
  echo "==> Starting AgenticAI on http://localhost:$PORT   (workspace: $DATA_DIR/workspace)"
  nohup env PORT="$PORT" DATA_DIR="$DATA_DIR" "$PY" -m app.main >>"$LOG_FILE" 2>>"$ERR_LOG" &
  echo $! > "$PID_FILE"
  sleep 2
  do_status
}

do_stop() {
  load_env
  PID_FILE="${DATA_DIR:-data}/server.pid"
  if [ -f "$PID_FILE" ]; then
    PID="$(cat "$PID_FILE" 2>/dev/null)"
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null
      for _ in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
      kill -9 "$PID" 2>/dev/null || true
      echo "Stopped (pid $PID)."
    else
      echo "Not running (stale pid file)."
    fi
    rm -f "$PID_FILE"
  else
    echo "No pid file — nothing to stop."
  fi
}

do_status() {
  load_env
  PORT="${PORT:-8000}"
  PID_FILE="${DATA_DIR:-data}/server.pid"
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
    echo "RUNNING  pid=$(cat "$PID_FILE")  url=http://localhost:$PORT"
    curl -fsS "http://localhost:$PORT/api/health" 2>/dev/null && echo || echo "(API not responding yet)"
  else
    echo "STOPPED  (run ./agentic.sh start)"
  fi
}

do_logs() {
  S=""
  [ "${1:-}" = "-f" ] && S="-f"
  [ -f "$LOG_FILE" ] && tail $S -n 80 "$LOG_FILE"
  [ -s "$ERR_LOG" ] && { echo "--- stderr ---"; [ "${1:-}" = "-f" ] && tail -f "$ERR_LOG" || tail -n 30 "$ERR_LOG"; }
  [ -f "$LOG_FILE" ] || echo "No logs yet."
}

do_update() {
  ensure_venv
  echo "==> Pulling latest code"
  git pull --ff-only 2>/dev/null || echo "(not a git checkout or pull failed — continue anyway)"
  "$PIP" install --quiet -r requirements.txt
  echo "==> Restarting"
  do_stop
  do_start
  echo "==> Update complete."
}

case "${1:-help}" in
  install) do_install ;;
  setup)   do_setup ;;
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  logs)    do_logs "${2:-}" ;;
  update)  do_update ;;
  help|--help|-h|"") cat <<'EOF'
AgenticAI — self-hosted agentic AI launcher

Usage:  ./agentic.sh <command> [args]

Commands:
  install    create venv + install deps + generate .env
  setup      interactive first-run config (port + admin password)
  start      start the server in the background
  stop       stop the server
  restart    stop then start
  status     show running state + health
  logs [-f]  show server logs
  update     git pull + reinstall deps + restart
  help       this help

Example:  ./agentic.sh install && ./agentic.sh start
EOF
    ;;
  *) echo "Unknown command: $1  (try ./agentic.sh help)"; exit 1 ;;
esac