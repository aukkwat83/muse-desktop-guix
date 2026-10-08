#!/usr/bin/env bash
# Build native Muse Desktop shell (GTK4 + WebKitGTK + Adwaita).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${MUSE_DESKTOP_SHELL_BIN:-$ROOT/linux/gtk-shell/muse-desktop-shell}"
cd "$ROOT/linux/gtk-shell"

if ! command -v pkg-config >/dev/null; then
  echo "pkg-config required (use: guix shell -m manifest.scm gcc-toolchain pkg-config -- bash build.sh)" >&2
  exit 1
fi

CFLAGS="$(pkg-config --cflags gtk4 libadwaita-1 webkitgtk-6.0)"
LIBS="$(pkg-config --libs gtk4 libadwaita-1 webkitgtk-6.0)"

echo "[build] compiling $OUT"
# -ldl: dlopen() for the libX11 zombie probe (a stub on new glibc, required
# on old — harmless either way). The X11 client lib is never linked directly:
# zero new link deps by design (pinned by test:guix-shell).
# shellcheck disable=SC2086
gcc -O2 -Wall -Wextra -o "$OUT" main.c $CFLAGS $LIBS -ldl
chmod +x "$OUT"
echo "[build] ok → $OUT"
"$OUT" --help 2>/dev/null || true
ls -la "$OUT"
