#!/usr/bin/env bash
# Deploy Muse Desktop on this machine (BUG-069), keeping the
# kimi lineage's verified-shutdown discipline:
#
#   deps (Node ≥ 20) → build dist/MuseDesktop.app → stop old host (HTTP-first,
#   verified-pid SIGTERM fallback — the same code path as BUG-068) → start the
#   host detached → /api/state health gate → post-deploy e2e smoke → open app.
#
#   ./scripts/deploy.sh            full deploy
#   ./scripts/deploy.sh --start    start only (skip deps/build)
#   ./scripts/deploy.sh --stop     stop the host
#   ./scripts/deploy.sh --status   print /api/state
#
# HARD SAFETY: the local PAC proxy (127.0.0.1:39080) is referenced only as a
# URL passed through the environment (existing SCB_PAC_PROXY behavior). This
# script never probes, starts, stops, or signals that process.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${MUSE_DESKTOP_PORT:-3850}"
HOST="${MUSE_DESKTOP_HOST:-127.0.0.1}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/muse-desktop"
LOG_FILE="$STATE/host.log"
PID_FILE="$STATE/host.pid"
BASE="http://${HOST}:${PORT}"
APP_OUT="$ROOT/dist/MuseDesktop.app"

# A GUI/detached host does not inherit a login shell's PATH — resolve node now
# and seed the usual global-bin locations (~/.local/bin holds `muse`).
NODE_BIN_DIR="$(dirname "$(command -v node || echo /usr/local/bin/node)")"
export PATH="$NODE_BIN_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Proxy: adopt the machine's PAC bridge as an env var only (same default as
# msp-client.js spawnEnv's SCB_PAC_PROXY fallback; an explicitly exported env
# always wins). Pre-setting https_proxy also short-circuits the nc probe in
# mac-launch.sh, so nothing on the deploy path ever probes the proxy port.
export https_proxy="${https_proxy:-${SCB_PAC_PROXY:-http://127.0.0.1:39080}}"
export http_proxy="${http_proxy:-$https_proxy}"
export HTTPS_PROXY="${HTTPS_PROXY:-$https_proxy}"
export HTTP_PROXY="${HTTP_PROXY:-$http_proxy}"
export no_proxy="${no_proxy:-localhost,127.0.0.1,::1}"
export NO_PROXY="${NO_PROXY:-$no_proxy}"

log()  { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

healthy() { curl -fsS -m 2 "$BASE/api/state" >/dev/null 2>&1; }

install_deps() {
  command -v node >/dev/null 2>&1 || fail "missing required command: node"
  command -v npm >/dev/null 2>&1 || fail "missing required command: npm"
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 20 ]] || fail "Node.js >= 20 required (found $(node -v))"
  log "node $(node -v) · npm $(npm -v)"
  if [[ ! -f "$ROOT/node_modules/marked/lib/marked.esm.js" ]]; then
    log "npm install"
    npm install --no-audit --no-fund
  fi
  log "deps ok"
}

build_app() {
  # The whole build (swift build + wrap_app) already lives in mac-launch.sh.
  bash "$ROOT/scripts/mac-launch.sh" build
}

check_muse() {
  if command -v muse >/dev/null 2>&1; then
    log "muse: $(command -v muse) · $(muse --version 2>/dev/null | head -1 || true)"
  else
    log "WARNING: muse CLI not on PATH — install it and run \`muse login\`"
  fi
}

stop_host() {
  # One implementation of the HTTP-first, verified-pid teardown (BUG-068) —
  # deploy never re-implements (or weakens) it.
  MUSE_DESKTOP_PORT="$PORT" bash "$ROOT/scripts/mac-launch.sh" stop
  local i
  for i in $(seq 1 40); do
    healthy || return 0
    sleep 0.2
  done
  log "warn: host still answering after stop"
}

start_host() {
  mkdir -p "$STATE"
  if healthy || [[ -f "$PID_FILE" ]]; then
    log "stopping old host first…"
    stop_host
  fi
  log "starting host (detached) — log: $LOG_FILE"
  NO_OPEN=1 MUSE_DESKTOP_KEEP_ON_EXIT=1 MUSE_DESKTOP_PORT="$PORT" MUSE_DESKTOP_HOST="$HOST" \
    nohup node "$ROOT/src/server/index.js" >>"$LOG_FILE" 2>&1 &
  # host.pid is written by the host itself once it listens (index.js).
  # Health gate: the deploy fails unless /api/state answers within 15s.
  local i
  for i in $(seq 1 75); do
    if healthy; then
      log "host healthy · $BASE · pid $(cat "$PID_FILE" 2>/dev/null || echo '?')"
      return 0
    fi
    sleep 0.2
  done
  fail "host failed the health gate within 15s — see $LOG_FILE"
}

smoke() {
  # Self-contained: the e2e starts its own host + mock agent on a random
  # 39xx port, so it never collides with the live host on $PORT and needs no
  # interactive muse login (test:msp stays opt-in for that reason).
  log "post-deploy smoke: npm run test:e2e"
  npm run test:e2e
}

open_app() {
  if [[ "${NO_OPEN:-}" == "1" || "${CI:-}" == "1" ]]; then
    log "skip open (NO_OPEN/CI)"
    return 0
  fi
  if [[ -d "$APP_OUT" ]]; then
    open "$APP_OUT"
    log "opened $APP_OUT"
  else
    log "no app bundle — UI at $BASE"
  fi
}

status_host() {
  if healthy; then
    curl -fsS -m 3 "$BASE/api/state"
    echo
    log "running at $BASE"
    return 0
  fi
  log "stopped"
  return 1
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [option]

  (default)   deps → build app → stop old host → start → health gate → smoke → open
  --start     start only (skip deps/build)
  --stop      stop the host (HTTP-first, verified-pid fallback)
  --status    print /api/state
  -h, --help  this help

Env:
  MUSE_DESKTOP_PORT   default 3850
  MUSE_DESKTOP_HOST   default 127.0.0.1
  SCB_PAC_PROXY       PAC bridge URL for the agent env (default http://127.0.0.1:39080)
  NO_OPEN=1           don't open the app after deploy
  CI=1                same as NO_OPEN
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --stop)    stop_host; exit 0 ;;
  --status)  status_host; exit $? ;;
  --start)
    check_muse
    start_host
    ;;
  --no-start)
    install_deps
    build_app
    check_muse
    ;;
  "")
    install_deps
    build_app
    check_muse
    start_host
    smoke
    open_app
    log "deploy complete · $BASE · log: $LOG_FILE"
    ;;
  *) fail "unknown option: $1 (try --help)" ;;
esac
