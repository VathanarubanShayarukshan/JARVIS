#!/bin/bash
# JARVIS Agent CLI — like WhatsApp .agent mode
# Usage: bash agent.sh

set -e
BASE_URL="${AGENTIC_URL:-http://127.0.0.1:8000}"
PASS="${AGENTIC_PASSWORD:-test-pass}"

echo "🤖 JARVIS Agent CLI"
echo "===================="
echo ""

# Get token
echo "[1/4] Logging in..."
TOKEN=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASS\"}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || true)

if [ -z "$TOKEN" ]; then
  # Try OPEN_ACCESS
  echo "  (OPEN_ACCESS mode — no token needed)"
  AUTH_HEADER=""
else
  echo "  Token obtained."
  AUTH_HEADER="Authorization: Bearer $TOKEN"
fi

# Get providers
echo ""
echo "[2/4] Loading providers..."
PROVIDERS=$(curl -s "$BASE_URL/api/providers" -H "$AUTH_HEADER" 2>/dev/null)

if [ -z "$PROVIDERS" ] || echo "$PROVIDERS" | grep -q '"detail"'; then
  echo "❌ Cannot reach JARVIS at $BASE_URL"
  echo "   Make sure server is running: bash ~/Tools/my-agentic-ai/update.sh"
  exit 1
fi

# Parse providers with python
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
  echo "❌ No providers with models found."
  echo "   Add a provider in Settings -> Models first."
  exit 1
fi

echo "$PROVIDER_LIST"
echo ""

# Choose provider
read -p "🏷️  Choose provider (1-$TOTAL): " PROVIDER_NUM
if [ -z "$PROVIDER_NUM" ] || [ "$PROVIDER_NUM" -lt 1 ] 2>/dev/null || [ "$PROVIDER_NUM" -gt "$TOTAL" ] 2>/dev/null; then
  echo "❌ Invalid choice."
  exit 1
fi

PROVIDER_DATA=$(echo "$PROVIDERS" | python3 -c "
import sys, json
providers = json.load(sys.stdin)
providers = [p for p in providers if p.get('models')]
p = providers[$PROVIDER_NUM - 1]
print(json.dumps({'id': p['id'], 'name': p['name'], 'models': p['models']}))
" 2>/dev/null)

PROVIDER_ID=$(echo "$PROVIDER_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
PROVIDER_NAME=$(echo "$PROVIDER_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin)['name'])")

# Get models
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

# Choose model
read -p "🏷️  Choose model (1-$MODEL_TOTAL): " MODEL_NUM
if [ -z "$MODEL_NUM" ] || [ "$MODEL_NUM" -lt 1 ] 2>/dev/null || [ "$MODEL_NUM" -gt "$MODEL_TOTAL" ] 2>/dev/null; then
  echo "❌ Invalid choice."
  exit 1
fi

MODEL=$(echo "$PROVIDER_DATA" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d['models'][$MODEL_NUM - 1])
" 2>/dev/null)

echo ""
echo "🎯 Model: $MODEL"
echo ""

# Get task
read -p "📝 Describe your task: " TASK
if [ -z "$TASK" ]; then
  echo "❌ No task provided."
  exit 1
fi

# Create session
echo ""
echo "[3/4] Creating session..."
SESSION=$(curl -s -X POST "$BASE_URL/api/sessions" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HEADER" \
  -d '{}')

SESSION_ID=$(echo "$SESSION" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  echo "❌ Failed to create session."
  exit 1
fi

echo "  Session: $SESSION_ID"

# Run agent
echo ""
echo "[4/4] Running agent..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
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
      NAME=$(echo "$EVENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('name',''))" 2>/dev/null || true)
      echo -ne "\r⚙️  Running: $NAME"
    elif [ "$TYPE" = "text" ]; then
      TEXT=$(echo "$EVENT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('text',''),end='')" 2>/dev/null || true)
      echo -n "$TEXT"
    elif [ "$TYPE" = "done" ]; then
      CONTENT=$(echo "$EVENT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('content',''))" 2>/dev/null || true)
      if [ -n "$CONTENT" ]; then
        echo ""
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "✅ DONE"
      fi
    elif [ "$TYPE" = "error" ]; then
      MSG=$(echo "$EVENT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))" 2>/dev/null || true)
      echo ""
      echo "❌ ERROR: $MSG"
    fi
  fi
done

echo ""
