#!/bin/bash
set -e

echo "=== JARVIS Auto-Update ==="
cd "$(dirname "$0")"

# pull latest
echo "[1/4] Pulling latest code..."
git pull origin master

# install new deps if requirements changed
echo "[2/4] Installing dependencies..."
.venv/bin/pip install -r requirements.txt -q

# restart server
echo "[3/4] Restarting server..."
pkill -f "app.main" 2>/dev/null || true
sleep 1
nohup .venv/bin/python -m app.main > app.log 2>&1 &
sleep 3

# health check
echo "[4/4] Checking health..."
if curl -s http://127.0.0.1:8000/api/health | grep -q '"ok":true'; then
    echo "✅ JARVIS updated and running!"
    curl -s http://127.0.0.1:8000/api/health | python3 -m json.tool 2>/dev/null || true
else
    echo "❌ Server may not have started. Check: cat app.log"
fi
