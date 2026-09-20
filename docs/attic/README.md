# Attic

Non-functional sketches kept from the original scaffold. **Neither of these runs.** They are here
for reference only, so the top level does not advertise platforms that do not exist.

### `kimi-desktop-gtk.py.sketch`

A ~45-line GTK4/libadwaita outline. It creates a window, packs three unwired buttons, spawns
`kimi acp`, and stops there — no ACP handshake, no session, no transcript, no rendering. The
comment `# ... add chat view, swarm panel, etc.` marks where the application would have started.

### `kimi-desktop.scm.sketch`

A Guix package definition whose `sha256` is a placeholder of zeroes and whose install plan copies
`dist/Kimi Desktop.app` — a path this project never produced (the bundle is
`dist/KimiDesktop.app`, and a macOS `.app` is meaningless on Guix anyway).

Porting either one means writing the real thing: the Node host is already cross-platform, so a
Linux shell needs a GTK/WebKitGTK window pointed at `http://127.0.0.1:3849` plus a supervisor
equivalent to `macos/KimiDesktopShell/HostSupervisor.swift`.
