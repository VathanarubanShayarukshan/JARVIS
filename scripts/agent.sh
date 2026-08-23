#!/bin/bash
# JARVIS Agent CLI — WhatsApp-style .agent mode, single session
# Usage: bash agent.sh

set -e
BASE_URL="${AGENTIC_URL:-http://127.0.0.1:8000}"
PASS="${AGENTIC_PASSWORD:-test-pass}"

echo "🤖 JARVIS Agent CLI"
echo "===================="
echo ""

# Login
echo "[1/3] Logging in..."
TOKEN=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASS\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || true)

if [ -z "$TOKEN" ]; then
  AUTH_HEADER=""
else
  AUTH_HEADER="Authorization: Bearer $TOKEN"
fi

# Get providers
echo "[2/3] Loading providers..."
PROVIDERS=$(curl -s "$BASE_URL/api/providers" -H "$AUTH_HEADER" 2>/dev/null)

if [ -z "$PROVIDERS" ] || echo "$PROVIDERS" | grep -q '"detail"'; then
  echo "❌ Cannot reach JARVIS at $BASE_URL"
  exit 1
fi

PROVIDER_COUNT=$(echo "$PROVIDERS" | python3 -c "
import sys, json
providers = json.load(sys.stdin)
providers = [p for p in providers if p.get('models')]
for i, p in enumerate(providers):
    key = '✅' if p.get('api_key_set') else ''
    print(f\"{i+1}. {p['name']} ({len(p['models'])} models) {key}\")
print(f'__COUNT__{len(providers)}')
" 2>/dev/null)

TOTAL=$(echo "$PROVIDER_COUNT" | grep "__COUNT__" | sed 's/__COUNT__//')
PROVIDER_LIST=$(echo "$PROVIDER_COUNT" | grep -v "__COUNT__")

if [ -z "$TOTAL" ] || [ "$TOTAL" = "0" ]; then
  echo "❌ No providers with models."
  exit 1
fi

echo "$PROVIDER_LIST"
echo ""
read -p "🏷️  Choose provider (1-$TOTAL): " PROVIDER_NUM

PROVIDER_DATA=$(echo "$PROVIDERS" | python3 -c "
import sys, json
providers = json.load(sys.stdin)
providers = [p for p in providers if p.get('models')]
p = providers[$PROVIDER_NUM - 1]
print(json.dumps({'id': p['id'], 'name': p['name'], 'models': p['models']}))
" 2>/dev/null)

PROVIDER_ID=$(echo "$PROVIDER_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
PROVIDER_NAME=$(echo "$PROVIDER_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])")

MODELS=$(echo "$PROVIDER_DATA" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for i, m in enumerate(d['models'][:40]):
    print(f'{i+1}. {m}')
print(f'__COUNT__{len(d[\"models\"])}')
" 2>/dev/null)

MODEL_TOTAL=$(echo "$MODELS" | grep "__COUNT__" | sed 's/__COUNT__//')
MODEL_LIST=$(echo "$MODELS" | grep -v "__COUNT__")

echo ""
echo "🏷️  $PROVIDER_NAME — choose model:"
echo "$MODEL_LIST"
echo ""
read -p "🏷️  Choose model (1-$MODEL_TOTAL): " MODEL_NUM

MODEL=$(echo "$PROVIDER_DATA" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d['models'][$MODEL_NUM - 1])
" 2>/dev/null)

# Create ONE session
echo ""
echo "[3/3] Creating session..."
SESSION_ID=$(curl -s -X POST "$BASE_URL/api/sessions" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  echo "❌ Failed to create session."
  exit 1
fi

echo "✅ Session: $SESSION_ID"
echo "🎯 Model: $MODEL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Type your tasks below. Type 'exit' to quit."
echo ""

# Chat loop — reuse same session
while true; do
  read -p "📝 You: " TASK
  [ "$TASK" = "exit" ] && echo "👋 Bye!" && break
  [ -z "$TASK" ] && continue

  echo ""
  curl -s -N -X POST "$BASE_URL/api/chat" \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d "{\"session_id\":\"$SESSION_ID\",\"message\":\"$TASK\",\"provider_id\":\"$PROVIDER_ID\",\"model\":\"$MODEL\"}" | \
  while IFS= read -r line; do
    if [[ "$line" == data:* ]]; then
      EVENT=$(echo "$line" | sed 's/^data: //')
      TYPE=$(echo "$EVENT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('type',''))" 2>/dev/null || true)
      
      if [ "$TYPE" = "status" ]; then
        MSG=$(echo "$EVENT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))" 2>/dev/null || true)
        echo -ne "\r⚙️  $MSG"
      elif [ "$TYPE" = "tool_call" ]; then
        NAME=$(echo "$EVENT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('name',''))" 2>/dev/null || true)
        echo -ne "\r⚙️  Running: $NAME"
      elif [ "$TYPE" = "text" ]; then
        TEXT=$(echo "$EVENT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('text',''),end='')" 2>/dev/null || true)
        echo -n "$TEXT"
      elif [ "$TYPE" = "done" ]; then
        echo ""
      elif [ "$TYPE" = "error" ]; then
        MSG=$(echo "$EVENT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))" 2>/dev/null || true)
        echo ""
        echo "❌ $MSG"
      fi
    fi
  done

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
done
