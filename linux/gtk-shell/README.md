# Native GNOME shell — no browser

**Independent of Chrome, Firefox, Chromium, Flatpak browsers.**

GTK4 + libadwaita window embeds **WebKitGTK 6** (system engine), same idea as
macOS `MuseDesktopShell` (Swift + WKWebView).

## Run

```bash
./scripts/native-launch.sh open     # default app path
./bin/muse-desktop                  # same when guix is available
./scripts/native-launch.sh build    # recompile C shell
```

Chrome fallback only if you ask:

```bash
./scripts/native-launch.sh chrome
# or
MUSE_DESKTOP_SHELL=chrome ./bin/muse-desktop
```

## Architecture

```
┌─────────────────────────────────────┐
│  muse-desktop-shell  (C)            │  real GNOME window
│  GTK4 + Adwaita + WebKitGTK         │  not a browser UI
└──────────────────┬──────────────────┘
                   │ http://127.0.0.1:3850/
┌──────────────────▼──────────────────┐
│  Node host                          │  MSP · FTS · MCP
└─────────────────────────────────────┘
```

## Build deps (Guix)

`linux/gtk-shell/manifest.scm` — pulled automatically by `native-launch.sh`.

Rebuild after any `main.c` change:

```bash
guix shell -m linux/gtk-shell/manifest.scm -- bash linux/gtk-shell/build.sh
npm run test:guix-shell   # static contract + stale-binary guard
```

`npm run test:guix-shell` fails if the shipped binary is older than `main.c`, which
is the failure mode that otherwise looks like "my change did nothing".

## Notes

| Topic | Detail |
|-------|--------|
| Keep host on close | `KEEP_ON_EXIT=1` (host not killed) |
| WebKit sandbox | Disabled under guix shell (`WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`) — localhost-only UI |
| Python prototype | `muse_desktop_shell.py` kept as a fallback/reference; the C shell is the default |
| Binary | `linux/gtk-shell/muse-desktop-shell` (gitignored or rebuilt) |
| **SVG card drag-out (R50)** | **Registered, dormant.** `WebKitUserContentManager` + `cardDrag` handler + a `GtkDragSource` in `GTK_PHASE_CAPTURE`; drops a real `.svg`/raster file, not a link, once a renderer sender exists. Neither the mac shell nor the renderer implements card drag yet, so diagrams use the in-page ↓ SVG / ↓ PNG buttons today. |
| **Reload (R39)** | **Ported.** 🔄 and **Ctrl+R / Ctrl+Shift+R / F5** purge the HTTP cache (disk+memory) then `webkit_web_view_reload_bypass_cache()`. Cookies/localStorage (theme) survive. **Renderer only** — see the next row. |
| **Restart host (R58-guix)** | **Ported** from mac's `HostSupervisor.restart()`. Second header-bar button (↻ `system-reboot-symbolic`): graceful `POST /api/host/shutdown {killAgents:false}` (warm agents survive) → verified SIGTERM only if HTTP never lands (`/proc/<pid>/cmdline` must match the host) → wait for the port → start → wait healthy → cache-ignoring reload. Timeout-driven, so the window never freezes. Needed after any **server-side** pickup: Reload alone repaints the new bundle against the *old* node process, which reads as a false PASS. Exposed as the `app.restart-host` GAction, so QC can drive the same path headlessly: `gdbus call --session --dest com.aukkwat83.MuseDesktop --object-path /com/aukkwat83/MuseDesktop --method org.gtk.Actions.Activate restart-host '[]' '{}'`. |
| **Web Inspector (R58-guix)** | **Ported** from `ContentView.swift` (`developerExtrasEnabled`). Always on — right-click → *Inspect Element*. `MUSE_DESKTOP_DEVTOOLS=1` additionally forwards the page console to the shell's stderr (i.e. `host.log`); off by default so the log stays clean. |
| JS↔native bridge | `cardDrag` registered (dormant — no renderer sender yet). `diagramSave` is macOS-only — the renderer feature-detects it, so the diagram panel silently falls back to the in-page download. |
| Bridge health | `host.log` prints `[native-shell] cardDrag bridge registered` at startup — if that says `FAILED`, a future drag-out sender would degrade to the `↓` button. |

## Desktop entry

```bash
./scripts/install-desktop.sh
```
