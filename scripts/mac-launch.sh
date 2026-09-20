#!/usr/bin/env bash
# Build and launch Muse Desktop on macOS: Node host (daemon) + SwiftUI/WKWebView shell.
#
#   ./scripts/mac-launch.sh open    build if needed, wrap the .app, open it
#   ./scripts/mac-launch.sh build   build the shell and refresh the .app only
#   ./scripts/mac-launch.sh host    run the Node host in the foreground
#   ./scripts/mac-launch.sh stop    stop the host (verified pid, then fallback)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MUSE_DESKTOP_ROOT="$ROOT"
export MUSE_DESKTOP_PORT="${MUSE_DESKTOP_PORT:-3850}"
export MUSE_DESKTOP_HOST="${MUSE_DESKTOP_HOST:-127.0.0.1}"
export NO_OPEN=1
export MUSE_DESKTOP_KEEP_ON_EXIT=1

# A GUI app does not inherit a login shell's PATH — resolve node here and
# bake a working PATH (with ~/.local/bin for `muse`) into the bundle.
NODE_BIN_DIR="$(dirname "$(command -v node || echo /usr/local/bin/node)")"
export PATH="$NODE_BIN_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Proxy: adopt the machine's local PAC bridge only if something is actually
# listening on it. Never hardcode a corporate proxy into a launch that may run
# on a different network.
if [[ -z "${https_proxy:-}" ]] && nc -z 127.0.0.1 39080 >/dev/null 2>&1; then
  export https_proxy="http://127.0.0.1:39080"
  export http_proxy="$https_proxy"
fi
export HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
export HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-}}"
export no_proxy="${no_proxy:-localhost,127.0.0.1,::1}"
export NO_PROXY="$no_proxy"

STATE="${XDG_STATE_HOME:-$HOME/.local/state}/muse-desktop"
mkdir -p "$STATE"

SHELL_DIR="$ROOT/macos/MuseDesktopShell"
BIN="$SHELL_DIR/.build/release/MuseDesktopShell"
APP_OUT="$ROOT/dist/MuseDesktop.app"

build_shell() {
  echo "[mac-launch] building SwiftUI shell…"
  (cd "$SHELL_DIR" && swift build -c release)
}

ensure_shell() {
  [[ -x "$BIN" ]] || build_shell
}

ensure_deps() {
  if [[ ! -f "$ROOT/node_modules/marked/lib/marked.esm.js" ]]; then
    echo "[mac-launch] installing npm dependencies…"
    (cd "$ROOT" && npm install --no-audit --no-fund)
  fi
}

build_app_icon() {
  local png="$ROOT/assets/icon.png"
  local res_dir="$1"
  local iconset="$STATE/AppIcon.iconset"
  [[ -f "$png" ]] || { echo "[mac-launch] warn: assets/icon.png missing — no Dock icon"; return 1; }
  rm -rf "$iconset"
  mkdir -p "$iconset" "$res_dir"
  local sizes=(16 32 32 64 128 256 256 512 512 1024)
  local names=(
    icon_16x16 icon_16x16@2x icon_32x32 icon_32x32@2x
    icon_128x128 icon_128x128@2x icon_256x256 icon_256x256@2x
    icon_512x512 icon_512x512@2x
  )
  for i in "${!sizes[@]}"; do
    sips -z "${sizes[$i]}" "${sizes[$i]}" "$png" --out "$iconset/${names[$i]}.png" >/dev/null
  done
  if iconutil -c icns "$iconset" -o "$res_dir/AppIcon.icns" 2>/dev/null; then
    echo "[mac-launch] AppIcon.icns ready"
  else
    echo "[mac-launch] warn: iconutil failed — bundling PNG only"
    cp -f "$png" "$res_dir/AppIcon.png"
  fi
}

wrap_app() {
  local macos_dir="$APP_OUT/Contents/MacOS"
  local res_dir="$APP_OUT/Contents/Resources"
  mkdir -p "$macos_dir" "$res_dir"
  cp -f "$BIN" "$macos_dir/MuseDesktop"
  chmod +x "$macos_dir/MuseDesktop"

  # SwiftPM emits the resource bundle next to the binary; the app needs it too.
  local bundle="$SHELL_DIR/.build/release/MuseDesktopShell_MuseDesktopShell.bundle"
  [[ -d "$bundle" ]] && cp -Rf "$bundle" "$res_dir/"

  local ver
  ver="$(node -pe "require('$ROOT/package.json').version" 2>/dev/null || echo 0.0.0)"

  build_app_icon "$res_dir" || true

  cat >"$APP_OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Muse Desktop</string>
  <key>CFBundleDisplayName</key><string>Muse Desktop</string>
  <key>CFBundleIdentifier</key><string>com.aukkwat83.musedesktop</string>
  <key>CFBundleVersion</key><string>${ver}</string>
  <key>CFBundleShortVersionString</key><string>${ver}</string>
  <key>CFBundleExecutable</key><string>MuseDesktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIconName</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSEnvironment</key>
  <dict>
    <key>MUSE_DESKTOP_ROOT</key><string>${ROOT}</string>
    <key>MUSE_DESKTOP_PORT</key><string>${MUSE_DESKTOP_PORT}</string>
    <key>MUSE_DESKTOP_KEEP_ON_EXIT</key><string>1</string>
    <key>NO_OPEN</key><string>1</string>
    <key>PATH</key><string>${PATH}</string>
    <key>http_proxy</key><string>${http_proxy:-}</string>
    <key>https_proxy</key><string>${https_proxy:-}</string>
    <key>HTTP_PROXY</key><string>${HTTP_PROXY:-}</string>
    <key>HTTPS_PROXY</key><string>${HTTPS_PROXY:-}</string>
    <key>no_proxy</key><string>${no_proxy}</string>
    <key>NO_PROXY</key><string>${NO_PROXY}</string>
  </dict>
</dict>
</plist>
PLIST

  touch "$APP_OUT"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$APP_OUT" 2>/dev/null || true
  echo "[mac-launch] bundle → $APP_OUT (v${ver})"
}

case "${1:-open}" in
  build)
    ensure_deps
    build_shell
    wrap_app
    ;;
  host)
    ensure_deps
    NO_OPEN=1 node "$ROOT/src/server/index.js"
    ;;
  open|"")
    ensure_deps
    ensure_shell
    wrap_app
    open "$APP_OUT"
    echo "[mac-launch] opened $APP_OUT"
    echo "[mac-launch] UI:  http://127.0.0.1:${MUSE_DESKTOP_PORT}/"
    echo "[mac-launch] log: $STATE/host.log"
    ;;
  stop)
    # Ask the host to stop itself first; only signal a pid it confirmed is its own.
    if curl -fsS -m 5 -X POST "http://127.0.0.1:${MUSE_DESKTOP_PORT}/api/host/shutdown" \
        -H 'Content-Type: application/json' -d '{"killAgents":true}' >/dev/null 2>&1; then
      echo "[mac-launch] host shutting down"
    elif [[ -f "$STATE/host.pid" ]]; then
      # Verified-pid fallback, mirroring HostSupervisor.verifiedOursPid: the
      # pid file is only a hint — macOS recycles pids, so signal just the pid
      # the live host reports at /api/state, and refuse otherwise.
      api_pid="$(curl -fsS -m 3 "http://127.0.0.1:${MUSE_DESKTOP_PORT}/api/state" 2>/dev/null \
        | sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' | head -n1)"
      if [[ "$api_pid" =~ ^[0-9]+$ ]] && kill -0 "$api_pid" 2>/dev/null; then
        kill -TERM "$api_pid" 2>/dev/null || true
        echo "[mac-launch] SIGTERM sent to verified pid $api_pid"
      else
        echo "[mac-launch] no verified host pid — refusing to signal anything" >&2
      fi
    else
      echo "[mac-launch] no host found"
    fi
    rm -f "$STATE/host.pid"
    ;;
  *)
    echo "usage: $0 {open|build|host|stop}" >&2
    exit 2
    ;;
esac
