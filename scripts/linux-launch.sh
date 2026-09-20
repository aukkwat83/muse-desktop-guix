#!/usr/bin/env bash
# GNOME/Guix launcher — host keep-alive + Chrome app window (parity with mac-launch.sh).
# Chrome fallback uses minimal inline --app flags (no SoT module); the default path
# is the native GTK shell via scripts/native-launch.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/muse-desktop"
PID_FILE="${STATE}/host.pid"
PORT="${MUSE_DESKTOP_PORT:-3850}"
URL="http://127.0.0.1:${PORT}/"
export PATH="${HOME}/.local/bin:${HOME}/.guix-profile/bin:/run/current-system/profile/bin:${PATH}"

# Host runtime: SQLite + concurrent agents
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-8}"
# Warm-pool defaults (same as src/server/sessions.js); export explicitly for children
export MUSE_DESKTOP_KEEP_ON_EXIT="${MUSE_DESKTOP_KEEP_ON_EXIT:-1}"
export MUSE_DESKTOP_MAX_HOT_AGENTS="${MUSE_DESKTOP_MAX_HOT_AGENTS:-6}"
export MUSE_DESKTOP_CREATE_WARM="${MUSE_DESKTOP_CREATE_WARM:-1}"

mkdir -p "$STATE"

host_running() {
  if [[ -f "$PID_FILE" ]]; then
    local p
    p="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${p:-}" ]] && kill -0 "$p" 2>/dev/null; then
      return 0
    fi
  fi
  curl -fsS --max-time 1 "${URL}api/state" >/dev/null 2>&1
}

start_host() {
  if host_running; then
    echo "[linux-launch] host already up"
    return 0
  fi
  echo "[linux-launch] starting host…"
  (
    cd "$ROOT"
    export NO_OPEN=1
    export MUSE_DESKTOP_KEEP_ON_EXIT=1
    # Do not use nice -n -5: many Guix users get "Permission denied" (noise + no benefit)
    nohup node src/server/index.js >>"${STATE}/host.log" 2>&1 &
    echo $! >"$PID_FILE"
  )
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 1 "${URL}api/state" >/dev/null 2>&1; then
      echo "[linux-launch] host ready pid=$(cat "$PID_FILE" 2>/dev/null || echo '?')"
      return 0
    fi
    sleep 0.25
  done
  echo "[linux-launch] host failed to become ready — see ${STATE}/host.log" >&2
  return 1
}

stop_host() {
  echo "[linux-launch] stopping host + agents…"
  MUSE_DESKTOP_KEEP_ON_EXIT=0
  if [[ -f "$PID_FILE" ]]; then
    local p
    p="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${p:-}" ]]; then
      kill "$p" 2>/dev/null || true
      sleep 0.4
      kill -9 "$p" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" 2>/dev/null || true
  fi
  echo "[linux-launch] stopped"
}

resolve_chrome() {
  if [[ -n "${MUSE_DESKTOP_CHROME:-}" && -x "${MUSE_DESKTOP_CHROME}" ]]; then
    echo "$MUSE_DESKTOP_CHROME"
    return
  fi
  if [[ -n "${CHROME_BIN:-}" && -x "${CHROME_BIN}" ]]; then
    echo "$CHROME_BIN"
    return
  fi
  for c in \
    "${HOME}/.local/bin/google-chrome" \
    "${HOME}/.guix-profile/bin/chromium" \
    /run/current-system/profile/bin/chromium \
    /usr/bin/google-chrome \
    /usr/bin/chromium
  do
    [[ -x "$c" ]] && echo "$c" && return
  done
}

open_ui() {
  start_host || return 1
  local chrome
  chrome="$(resolve_chrome || true)"
  if [[ -z "${chrome:-}" ]]; then
    echo "[linux-launch] open manually: $URL"
    command -v xdg-open >/dev/null && xdg-open "$URL" || true
    return 0
  fi
  # Minimal --app flags (same shape as bin/muse-desktop open_window).
  mkdir -p "${STATE}/chrome-profile"
  local -a args=(--app="$URL" --class=MuseDesktop --user-data-dir="${STATE}/chrome-profile"
    --enable-gpu-rasterization --enable-zero-copy --disable-extensions)
  # Log flags once for freeze debugging
  echo "[linux-launch] chrome=$chrome profile=${STATE}/chrome-profile"
  nohup "$chrome" "${args[@]}" >>"${STATE}/chrome.log" 2>&1 &
  echo "[linux-launch] opened UI via $chrome (${#args[@]} flags) pid=$!"
}

case "${1:-open}" in
  open|start) open_ui ;;
  host) start_host ;;
  stop) stop_host ;;
  status)
    if host_running; then
      curl -fsS "${URL}api/version" || true
      echo
      curl -fsS "${URL}api/memory" 2>/dev/null | head -c 400 || true
      echo
      echo "running $URL"
    else
      echo "stopped"
      exit 1
    fi
    ;;
  flags)
    # Debug: print resolved Chrome + the --app flags open_ui would use
    echo "chrome=$(resolve_chrome || echo MISSING)"
    echo "profile=${STATE}/chrome-profile"
    printf '%s\n' --app="$URL" --class=MuseDesktop --user-data-dir="${STATE}/chrome-profile" \
      --enable-gpu-rasterization --enable-zero-copy --disable-extensions
    ;;
  *)
    echo "Usage: $0 {open|host|stop|status|flags}"
    exit 2
    ;;
esac
