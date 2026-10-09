#!/usr/bin/env bash
set -euo pipefail

STOCK_VERSION="1.7.0"
PROVIDER_TAG="v0.2.0-alpha.1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
STATE="${PASEO_BRIDGE_HOME:-$HOME/.local/share/paseo-codexify-sidecar}"
SOCKET="${PASEO_BRIDGE_SOCKET:-$STATE/controller.sock}"
WORKSPACE="${PASEO_BRIDGE_WORKSPACE_ROOT:-/Users/Shared/PaseoWorkspaces}"
UPSTREAM="${PASEO_BRIDGE_UPSTREAM:-http://127.0.0.1:3000/mcp}"
PORT="${PASEO_BRIDGE_PORT:-38722}"
AGENTS="$HOME/Library/LaunchAgents"
BRIDGE_LABEL="dev.paseo.codexify.sidecar"
STOCK_LABEL="dev.paseo.codexify.stock"
MODE="install"
YES=0
SKIP_PROVIDER=0
SKIP_STOCK=0

log(){ printf '==> %s\n' "$*"; }
fail(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
have(){ command -v "$1" >/dev/null 2>&1; }
usage() {
cat <<'USAGE'
Usage: ./install.sh [--dry-run | --check | --uninstall] [options]
  --dry-run            Describe planned changes without making any
  --check              Read-only dependency/service/socket checks
  --uninstall          Remove sidecar LaunchAgent (preserves Codexify and data)
  --yes                Confirm installing trusted components
  --skip-provider      Do not install/modify Paseo plugin
  --skip-stock         Require already-running official Codexify endpoint
  --upstream URL       Existing Codexify MCP endpoint (local only)
  --proxy-port PORT    Sidecar's local MCP proxy port (default 38722)
  --state-dir PATH     Private installer-owned state directory
  --socket PATH        Paseo controller socket, under state directory
  --workspace-root P  Allowed project root
  --help
macOS alpha. HTTPS tunnel/ChatGPT connector and backend attachment are manual.
Existing Codexify binaries, services, configs and Paseo sessions are NEVER restarted.
USAGE
}
while (( $# )); do
 case "$1" in
  --dry-run|--check|--uninstall)
   [[ "$MODE" == install ]] || fail 'Only one operation allowed'
   MODE="${1#--}";;
  --yes) YES=1;;
  --skip-provider) SKIP_PROVIDER=1;;
  --skip-stock) SKIP_STOCK=1;;
  --upstream|--proxy-port|--state-dir|--socket|--workspace-root)
   option="$1";shift; (( $# )) || fail "Missing value for $option"
   case "$option" in
    --upstream) UPSTREAM="$1";;
    --proxy-port) PORT="$1";;
    --state-dir)
     prior="$STATE";STATE="$1"
     if [[ "$SOCKET" == "$prior/controller.sock" ]];then SOCKET="$STATE/controller.sock";fi;;
    --socket) SOCKET="$1";;
    --workspace-root) WORKSPACE="$1";;
   esac;;
  -h|--help) usage;exit 0;;
  *) fail "Unexpected option: $1";;
 esac
 shift
done
[[ "$(uname -s)" == Darwin ]] || fail 'macOS required for automated installation'
[[ "$STATE" == /* && "$WORKSPACE" == /* && "$SOCKET" == /* ]] || fail 'Use absolute filesystem paths'
[[ "$SOCKET" == "$STATE/"* ]] || fail 'Socket must remain within private state directory'
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || fail 'Proxy port out of range'
[[ "$UPSTREAM" == http://127.0.0.1:*/* || "$UPSTREAM" == http://localhost:*/* ]] ||
 fail 'Upstream must be a loopback HTTP Codexify server'
[[ ! -L "$STATE" && ! -L "$SOCKET" ]] || fail 'Symlinked state/socket refused'
BRIDGE_PLIST="$AGENTS/$BRIDGE_LABEL.plist"
STOCK_PLIST="$AGENTS/$STOCK_LABEL.plist"
stock_alive(){ curl -fsS --max-time 2 "${UPSTREAM%/mcp}/health" >/dev/null 2>&1; }
proxy_alive(){ curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; }
check(){
 log "Node: $(command -v node || echo missing)"
 log "Paseo CLI: $(command -v paseo || echo missing)"
 log "Codexify: $UPSTREAM ($(stock_alive && echo responding || echo unavailable))"
 log "Proxy: http://127.0.0.1:$PORT/mcp ($(proxy_alive && echo responding || echo unavailable))"
 log "Socket: $SOCKET ($(test -S "$SOCKET" && echo exists || echo missing))"
 log "Workspaces: $WORKSPACE"
 [[ -f "$BRIDGE_PLIST" ]] && log "LaunchAgent: $BRIDGE_PLIST" || true
}
if [[ "$MODE" == check ]];then check;exit 0;fi
if [[ "$MODE" == dry-run ]];then
 log "Would install dependencies, reuse existing Codexify or download verified official v$STOCK_VERSION"
 log 'Would create NEW per-user LaunchAgents and install pinned Paseo provider'
 log 'Would configure future Paseo processes to connect to the private controller socket'
 log 'Would NEVER replace, stop or restart an existing Codexify/Paseo service'
 log 'HTTPS connector/tunnel and ChatGPT attach require user action'
 check
 exit 0
fi
if [[ "$MODE" == uninstall ]];then
 [[ -f "$BRIDGE_PLIST" ]] || fail 'No installer-owned sidecar LaunchAgent'
 if (( ! YES ));then
  read -r -p 'Remove sidecar and Paseo provider? Keep Codexify/config/data? [y/N] ' answer
  [[ "$answer" == y || "$answer" == Y ]] || fail 'Cancelled'
 fi
 launchctl bootout "gui/$(id -u)/$BRIDGE_LABEL" >/dev/null 2>&1 || true
 rm -f "$BRIDGE_PLIST"
 if (( ! SKIP_PROVIDER )) && [[ -f "$STATE/installed-provider" ]] && have paseo;then
   paseo plugin remove chatgpt-codexify || true
   rm -f "$STATE/installed-provider"
  fi
 log "Sidecar stopped, Codexify binaries, credentials, history preserved: $STATE"
 exit 0
fi

[[ -f "$ROOT/src/sidecar.mjs" && -f "$ROOT/src/proxy.mjs" ]] || fail 'Incomplete sidecar checkout'
if (( ! YES ));then
 log 'This is trusted unsandboxed code with your Codexify tool permissions.'
 read -r -p 'Continue? [y/N] ' answer
 [[ "$answer" == y || "$answer" == Y ]] || fail 'Cancelled'
fi
if ! have node;then
 have brew || fail 'Install Node >=20 or Homebrew first'
 brew install node
fi
node -e 'process.exit(Number(process.versions.node.split(".")[0])<20?1:0)' || fail 'Node >=20 required'
have curl && have shasum && have tar || fail 'curl, shasum and tar required'
if ! have python3;then
 have brew || fail 'Python3 required for LaunchAgent generation'
 brew install python
fi
mkdir -p "$STATE" "$STATE/src" "$STATE/log" "$AGENTS" "$WORKSPACE"
chmod 700 "$STATE"
if ! stock_alive;then
 (( ! SKIP_STOCK )) || fail 'Configured Codexify endpoint is unreachable'
 [[ "$UPSTREAM" == http://127.0.0.1:3000/mcp ]] || fail 'Custom upstream unreachable'
 if [[ -f "$STOCK_PLIST" ]];then
  UPSTREAM="http://127.0.0.1:38721/mcp"
  stock_alive || fail 'Installed stock LaunchAgent exists but is unhealthy; refusing to replace'
 else
  curl -fsS --max-time 2 http://127.0.0.1:38721/health >/dev/null 2>&1 &&
   fail 'Port 38721 already in use'
  case "$(uname -m)" in
   arm64) arch=arm64;;
   x86_64) arch=x64;;
   *) fail 'Unsupported macOS CPU architecture';;
  esac
  asset="codexify-v$STOCK_VERSION-darwin-$arch.tar.gz"
  url="https://github.com/devnoname120/codexify/releases/download/v$STOCK_VERSION"
  mkdir -p "$STATE/download" "$STATE/stock"
  log "Downloading official Codexify $STOCK_VERSION; checking SHA256"
  curl -fLsS "$url/checksums.txt" -o "$STATE/download/checksums.txt"
  curl -fLsS "$url/$asset" -o "$STATE/download/$asset"
  (cd "$STATE/download" && grep "  $asset\$" checksums.txt | shasum -a 256 -c -) ||
   fail 'Codexify SHA256 mismatch'
  tar -xzf "$STATE/download/$asset" -C "$STATE/stock"
  binary="$STATE/stock/codexify-v$STOCK_VERSION-darwin-$arch/codexify"
  [[ -x "$binary" ]] || fail "Codexify binary not found after extraction"
  python3 - "$STATE/stock-config.json" "$WORKSPACE" <<'PY'
import json,sys,os
path,root=sys.argv[1:]
if os.path.exists(path):raise SystemExit('Stock config exists; refusing overwrite')
with open(path,'w') as f:json.dump({'schemaVersion':1,'port':38721,'workDir':root,'multiProject':True,'codexMcp':{'enabled':False},'mcpServers':{}},f,indent=2)
os.chmod(path,0o600)
PY
  python3 "$ROOT/scripts/plist.py" "$STOCK_PLIST" "$STOCK_LABEL" "$binary" "$STATE/stock-config.json" 38721 "$STATE" stock
  plutil -lint "$STOCK_PLIST" >/dev/null
  launchctl bootstrap "gui/$(id -u)" "$STOCK_PLIST"
  UPSTREAM="http://127.0.0.1:38721/mcp"
  log 'Started NEW official Codexify service, did not change any existing service'
 fi
fi

if [[ ! -f "$BRIDGE_PLIST" ]];then
 [[ ! -e "$SOCKET" ]] || fail "Controller socket already exists: $SOCKET"
 cp "$ROOT/src/sidecar.mjs" "$ROOT/src/proxy.mjs" "$STATE/src/"
 python3 "$ROOT/scripts/plist.py" "$BRIDGE_PLIST" "$BRIDGE_LABEL" "$(command -v node)" "$UPSTREAM" "$PORT" "$STATE" bridge "$SOCKET" "$WORKSPACE"
 plutil -lint "$BRIDGE_PLIST" >/dev/null
 launchctl bootstrap "gui/$(id -u)" "$BRIDGE_PLIST"
 log 'Installed per-user MCP proxy LaunchAgent'
else
 log 'Existing sidecar LaunchAgent detected; preserving running version'
fi
if (( ! SKIP_PROVIDER ));then
 if ! have paseo;then
  have npm || fail 'npm required for Paseo CLI'
  npm install --prefix "$STATE/paseo-cli" --no-audit --no-fund @getpaseo/cli@0.10.3
  export PATH="$STATE/paseo-cli/node_modules/.bin:$PATH"
 fi
 if ! paseo plugin ls chatgpt-codexify 2>/dev/null | grep -q chatgpt-codexify;then
  paseo plugin add git:thesunwave/paseo-chatgpt-provider --ref "$PROVIDER_TAG"
  touch "$STATE/installed-provider"
 fi
fi
launchctl setenv CODEXIFY_CHATGPT_BACKEND_SOCKET "$SOCKET"
check
log "NEXT: Point ChatGPT HTTPS connector/tunnel at http://127.0.0.1:$PORT/mcp"
log 'NEXT: Enable Paseo plugins and voluntarily restart Paseo to pick up socket environment'
log 'NEXT: Attach a ChatGPT conversation using paseo_backend_attach and paseo_backend_exchange'
