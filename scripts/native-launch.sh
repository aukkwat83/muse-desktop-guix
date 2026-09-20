#!/usr/bin/env bash
# Native GNOME shell — GTK4 + WebKitGTK binary (not Chrome/Firefox/any browser).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MUSE_DESKTOP_ROOT="$ROOT"
export PATH="${HOME}/.local/bin:${HOME}/.guix-profile/bin:/run/current-system/profile/bin:${PATH}"
export NO_OPEN=1
export MUSE_DESKTOP_KEEP_ON_EXIT="${MUSE_DESKTOP_KEEP_ON_EXIT:-1}"
export MUSE_DESKTOP_MAX_HOT_AGENTS="${MUSE_DESKTOP_MAX_HOT_AGENTS:-6}"
export MUSE_DESKTOP_CREATE_WARM="${MUSE_DESKTOP_CREATE_WARM:-1}"
export UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-8}"

SHELL_BIN="$ROOT/linux/gtk-shell/muse-desktop-shell"
MANIFEST="$ROOT/linux/gtk-shell/manifest.scm"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/muse-desktop"
mkdir -p "$STATE"

if ! command -v guix >/dev/null 2>&1; then
  echo "[native-launch] guix required for GTK/WebKit env" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[native-launch] node not on PATH" >&2
  exit 1
fi

build_shell() {
  echo "[native-launch] building native shell (once)…"
  guix shell -m "$MANIFEST" -- bash "$ROOT/linux/gtk-shell/build.sh"
}

run_shell() {
  # Prefer prebuilt binary with guix runtime libs
  if [[ ! -x "$SHELL_BIN" ]]; then
    build_shell
  fi
  echo "[native-launch] native app (GTK4+WebKitGTK) — independent of browsers"
  # Host for faster first paint
  if ! curl -fsS --max-time 1 "http://127.0.0.1:${MUSE_DESKTOP_PORT:-3850}/api/state" >/dev/null 2>&1; then
    (
      cd "$ROOT"
      nohup env NO_OPEN=1 MUSE_DESKTOP_KEEP_ON_EXIT=1 node src/server/index.js \
        >>"$STATE/host.log" 2>&1 &
      echo $! >"$STATE/host.pid"
    )
    host_up=0
    for _ in $(seq 1 40); do
      if curl -fsS --max-time 1 "http://127.0.0.1:${MUSE_DESKTOP_PORT:-3850}/api/state" >/dev/null 2>&1; then
        host_up=1
        break
      fi
      sleep 0.25
    done
    # Without this the shell opens against a dead port: a blank window, no error, no log pointer.
    if [[ "$host_up" != "1" ]]; then
      echo "[native-launch] host failed to come up on ${MUSE_DESKTOP_PORT:-3850} — see $STATE/host.log" >&2
      exit 1
    fi
  fi
  # WebKitGTK process sandbox (bubblewrap) breaks under nested guix shell + store paths.
  # Safe for localhost-only UI (127.0.0.1). Same class of tradeoff as many distro flatpaks.
  export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1

  # Fast path (default): build.sh already links the binary against its /gnu/store libs,
  # so it runs standalone — `ldd` resolves everything without a profile.
  # Wrapping it in `guix shell` re-realizes the whole manifest (gcc-toolchain, webkitgtk,
  # python-pygobject); on a cold store that is a multi-minute substitute download with no
  # output, which is exactly what "the app won't open" looks like to a user.
  # Opt into the slow path with MUSE_DESKTOP_FORCE_GUIX_SHELL=1.
  if [[ "${MUSE_DESKTOP_FORCE_GUIX_SHELL:-0}" != "1" ]]; then
    echo "[native-launch] launching prebuilt binary (instant)…"
    exec env \
      WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 \
      MUSE_DESKTOP_ROOT="$ROOT" \
      MUSE_DESKTOP_KEEP_ON_EXIT=1 \
      "$SHELL_BIN"
  fi

  echo "[native-launch] guix shell mode (may download packages once)…"
  exec guix shell -m "$MANIFEST" -- env \
    WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1 \
    MUSE_DESKTOP_ROOT="$ROOT" \
    MUSE_DESKTOP_KEEP_ON_EXIT=1 \
    "$SHELL_BIN"
}

case "${1:-open}" in
  open|start) run_shell ;;
  build) build_shell ;;
  host) exec "$ROOT/scripts/linux-launch.sh" host ;;
  stop) exec "$ROOT/scripts/linux-launch.sh" stop ;;
  status)
    if curl -fsS --max-time 2 "http://127.0.0.1:${MUSE_DESKTOP_PORT:-3850}/api/version"; then
      echo
      echo "shell=native-gtk-webkit bin=$SHELL_BIN"
      [[ -x "$SHELL_BIN" ]] && echo "binary=yes" || echo "binary=missing (run: $0 build)"
    else
      echo "host stopped"; exit 1
    fi
    ;;
  chrome)
    exec "$ROOT/scripts/linux-launch.sh" open
    ;;
  *)
    echo "Usage: $0 {open|build|host|stop|status|chrome}"
    echo "  open   — native GNOME window (default; no browser)"
    echo "  build  — compile linux/gtk-shell/muse-desktop-shell"
    echo "  chrome — fallback Chrome --app"
    exit 2
    ;;
esac
