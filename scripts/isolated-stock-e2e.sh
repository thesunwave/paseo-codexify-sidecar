#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN="${STOCK_CODEXIFY_BIN:-$ROOT/.test-tools/codexify17/codexify-v1.7.0-darwin-arm64/codexify}"
[[ -x "$BIN" ]] || { echo "Set STOCK_CODEXIFY_BIN to official v1.7.0 binary" >&2; exit 1; }
[[ -n "${POC_PROVIDER_MODULE:-}" ]] || { echo "Set POC_PROVIDER_MODULE to a provider.ts in a checkout with dependencies" >&2;exit 1; }
TMP="$(mktemp -d /tmp/paseo-stock-e2e.XXXXXX)"
mkdir -p "$TMP/socket" "$TMP/home" "$TMP/workspace"
chmod 700 "$TMP/socket"
stock_pid='' bridge_pid=''
cleanup(){
  [[ -z "$bridge_pid" ]] || kill "$bridge_pid" >/dev/null 2>&1 || true
  [[ -z "$stock_pid" ]] || kill "$stock_pid" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM
read -r STOCK_PORT PROXY_PORT < <(python3 - <<'PY'
import socket
sockets=[]
for i in range(2):
 s=socket.socket();s.bind(('127.0.0.1',0));sockets.append(s)
print(*[s.getsockname()[1] for s in sockets])
for s in sockets:s.close()
PY
)
python3 - "$TMP/config.json" "$TMP/workspace" "$STOCK_PORT" <<'PY'
import json,sys
config,root,port=sys.argv[1:]
with open(config,'w') as f:
 json.dump({'schemaVersion':1,'port':int(port),'workDir':root,'multiProject':True,'uiWidgets':False,
            'codexMcp':{'enabled':False},'mcpServers':{}},f)
PY
HOME="$TMP/home" "$BIN" --config "$TMP/config.json" --port "$STOCK_PORT" > "$TMP/stock.log" 2>&1 &
stock_pid=$!
for i in $(seq 1 80);do
  curl -fsS --max-time 1 "http://127.0.0.1:$STOCK_PORT/health" >/dev/null 2>&1 && break
  sleep 0.15
done
curl -fsS --max-time 2 "http://127.0.0.1:$STOCK_PORT/health" >/dev/null
PASEO_BRIDGE_MODE=proxy PASEO_BRIDGE_PORT="$PROXY_PORT" \
  PASEO_BRIDGE_UPSTREAM="http://127.0.0.1:$STOCK_PORT/mcp" \
  PASEO_BRIDGE_SOCKET="$TMP/socket/controller.sock" \
  PASEO_BRIDGE_WORKSPACE_ROOT="$TMP/workspace" \
  node "$ROOT/src/sidecar.mjs" > "$TMP/bridge.log" 2>&1 &
bridge_pid=$!
for i in $(seq 1 80);do
 curl -fsS --max-time 1 "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1 && break
 sleep 0.15
done
curl -fsS --max-time 2 "http://127.0.0.1:$PROXY_PORT/health" >/dev/null
POC_PROXY_URL="http://127.0.0.1:$PROXY_PORT/mcp" POC_WORKSPACE="$TMP/workspace" \
  CODEXIFY_CHATGPT_BACKEND_SOCKET="$TMP/socket/controller.sock" \
  node "$ROOT/scripts/proxy-e2e.mjs"
POC_PROXY_URL="http://127.0.0.1:$PROXY_PORT/mcp" POC_WORKSPACE="$TMP/workspace" \
  CODEXIFY_CHATGPT_BACKEND_SOCKET="$TMP/socket/controller.sock" \
  node "$ROOT/scripts/stock-cancel-smoke.mjs"
echo "ISOLATED_STOCK_CODEXIFY_E2E=PASS"
