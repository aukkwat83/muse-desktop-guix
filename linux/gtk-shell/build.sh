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
# shellcheck disable=SC2086
gcc -O2 -Wall -Wextra -o "$OUT" main.c $CFLAGS $LIBS
chmod +x "$OUT"
echo "[build] ok → $OUT"
"$OUT" --help 2>/dev/null || true
ls -la "$OUT"
