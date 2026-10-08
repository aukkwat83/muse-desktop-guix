#!/usr/bin/env bash
# Re-install menu/desktop launcher for Muse Desktop.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chmod +x "$ROOT/bin/muse-desktop"

mkdir -p "$HOME/.local/share/applications" "$HOME/Desktop" "$HOME/.local/bin"
mkdir -p "$HOME/.local/share/icons/hicolor/scalable/apps"
mkdir -p "$HOME/.local/share/icons/hicolor/256x256/apps"

ICON_PATH="$ROOT/assets/icon.svg"
if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 256 -h 256 "$ROOT/assets/icon.svg" -o "$ROOT/assets/icon.png"
  ICON_PATH="$ROOT/assets/icon.png"
elif [[ -f "$ROOT/assets/icon.png" ]]; then
  ICON_PATH="$ROOT/assets/icon.png"
fi

# Prefer native GTK shell (no browser). Fallback handled inside bin/muse-desktop.
cat >"$ROOT/assets/muse-desktop.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Muse Desktop
GenericName=Muse MSP Desktop
Comment=Native multi-session Muse agent (GTK+WebKit — not a browser)
Exec=$ROOT/bin/muse-desktop
Icon=$ICON_PATH
Path=$ROOT
Terminal=false
Categories=Development;IDE;Utility;
Keywords=muse;agent;cli;ai;msp;native;
StartupNotify=true
StartupWMClass=com.aukkwat83.MuseDesktop
SingleMainWindow=true
DBusActivatable=true
EOF

# GNOME matches GNotification actions (open-question taps, cold-start
# activation) to the APP ID, so the canonical installed entry is the
# reverse-DNS one. The legacy muse-desktop.desktop name stays installed
# but HIDDEN (NoDisplay) — two identical visible entries in the menu was
# the bug; old launchers and the Desktop file keep working.
cp "$ROOT/assets/muse-desktop.desktop" "$ROOT/assets/com.aukkwat83.MuseDesktop.desktop"
cp "$ROOT/assets/muse-desktop.desktop" "$HOME/.local/share/applications/com.aukkwat83.MuseDesktop.desktop"
{ cat "$ROOT/assets/muse-desktop.desktop"; echo "NoDisplay=true"; } >"$HOME/.local/share/applications/muse-desktop.desktop"
cp "$ROOT/assets/muse-desktop.desktop" "$HOME/Desktop/muse-desktop.desktop"
chmod +x "$HOME/Desktop/muse-desktop.desktop"
ln -sfn "$ROOT/bin/muse-desktop" "$HOME/.local/bin/muse-desktop"

# D-Bus activation: the host's gdbus call names the app-id bus
# (com.aukkwat83.MuseDesktop). With this .service file + DBusActivatable
# the bus daemon LAUNCHES the shell when it isn't running, then dispatches
# the notify/open action to it — cold taps work with zero running UI.
# Single-instance reuse is the shell's own GApplication contract (a second
# activation presents the existing window instead of forking).
mkdir -p "$HOME/.local/share/dbus-1/services"
cat >"$HOME/.local/share/dbus-1/services/com.aukkwat83.MuseDesktop.service" <<EOF
[D-BUS Service]
Name=com.aukkwat83.MuseDesktop
Exec=$ROOT/bin/muse-desktop
EOF

cp "$ROOT/assets/icon.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/muse-desktop.svg"
if [[ -f "$ROOT/assets/icon.png" ]]; then
  cp "$ROOT/assets/icon.png" "$HOME/.local/share/icons/hicolor/256x256/apps/muse-desktop.png"
fi

if command -v gio >/dev/null 2>&1; then
  gio set "$HOME/Desktop/muse-desktop.desktop" metadata::trusted true 2>/dev/null || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
fi

echo "Installed:"
echo "  Desktop:  $HOME/Desktop/muse-desktop.desktop"
echo "  Menu:     $HOME/.local/share/applications/com.aukkwat83.MuseDesktop.desktop"
echo "  Legacy:   $HOME/.local/share/applications/muse-desktop.desktop (NoDisplay)"
echo "  Bus:      $HOME/.local/share/dbus-1/services/com.aukkwat83.MuseDesktop.service"
echo "  CLI:      $HOME/.local/bin/muse-desktop"
echo "Run: double-click the Desktop icon, or: muse-desktop"
