# Muse Desktop on Guix + GNOME

Port of the stable **v1.0.0** mac stack to Guix System (GNOME).

Guix stack modelled on grok-desktop `deploy/v0.8.9-guix` @ `35dac5c`
(tag `v0.9.4-guix-shell-host` @ `f8e0eb8`): same native-shell shape, same
launcher discipline, same docs layout — with the grok-only pieces (ACP pool
knobs, chrome-shell SoT, ask-rescue) left out because this host never had them.

## Architecture (native app — default)

```
GTK4 + libadwaita + WebKitGTK  (real window — not Chrome/Firefox)
         ↓  http://127.0.0.1:3850/
Node host (src/server)  sessions/MSP · FTS · MCP lifecycle
         ↓
muse serve × N (hot capped)
```

Same pattern as **macOS** (`macos/` Swift + WKWebView): native frame + system web engine.
**Not** tied to any installed browser. Fallback: `MUSE_DESKTOP_SHELL=chrome` or `muse-desktop chrome`.

```bash
./scripts/native-launch.sh open   # recommended
./bin/muse-desktop                # native when the shell binary is built, else Chrome
# ~/.local/bin/muse-desktop is a symlink — ROOT must resolve through it (HAZ-10)
```

### "App won't open" on Guix (quick triage)

1. **`[native-launch] node not on PATH`** → `guix install node curl` (profile), re-source profile. Host may still answer on `:3850`.
2. **`native shell not built` + Open manually** while `linux/gtk-shell/muse-desktop-shell` exists → symlink ROOT bug; need `bin/muse-desktop` that follows symlinks.
3. **Hang >121s, no output** → different bug: lost prebuilt fast path / forced `guix shell -m manifest` — see §"Launch path" below.

Full table: `docs/DEPLOY-GUIX.md` §9.

### Two buttons in the header bar — they are not the same thing

| Button | Does | Use after |
|--------|------|-----------|
| 🔄 Reload (`Ctrl+R` / `Ctrl+Shift+R` / `F5`) | purges the WebKit cache and reloads the page | a **renderer** change (CSS/JS) |
| ↻ Restart host | graceful `POST /api/host/shutdown {killAgents:false}` → restart node → reload | a **server** change (`src/server/**`) |

Reload alone after a server-side pickup repaints the new bundle against the **old**
node process and reads as a false PASS. Warm agents survive the restart.

Headless equivalent for QC:

```bash
gdbus call --session --dest com.aukkwat83.MuseDesktop \
  --object-path /com/aukkwat83/MuseDesktop \
  --method org.gtk.Actions.Activate restart-host '[]' '{}'
```

The Web Inspector is enabled (right-click → *Inspect Element*), matching mac.
`MUSE_DESKTOP_DEVTOOLS=1` also forwards the page console into `host.log`.

### Launch path — do not re-wrap the binary in `guix shell`

`build.sh` links `linux/gtk-shell/muse-desktop-shell` against its `/gnu/store` libs, so it
runs **standalone**. `native-launch.sh` therefore execs it directly.

Do not "fix" library resolution by wrapping that exec in `guix shell -m manifest.scm`.
The manifest carries build-only packages (`gcc-toolchain`, `pkg-config`,
`gobject-introspection`, `python-pygobject`); realizing it costs a ~105 MB download that
Guix re-checks on **every** launch, with no terminal output. The app appears to hang and
the bug reads as *"the app won't open"*. The slow path lives behind
`MUSE_DESKTOP_FORCE_GUIX_SHELL=1` only.

macOS never executes this code (`command -v guix` fails there), so mac QC cannot catch a
regression here. Launch-path changes need a Guix QC record before tagging.

## Performance (Guix notes)

| Lever | Guix implementation |
|-------|---------------------|
| App shell | native GTK4 + WebKitGTK (no browser); Chrome `--app` fallback with minimal flags |
| Chrome profile | `~/.local/state/muse-desktop/chrome-profile` (writable; avoids blank freeze) |
| Hot pool | capped at `MUSE_DESKTOP_MAX_HOT_AGENTS` (default 6); raise on big RAM |
| History paint | windowed transcript (`history-window.js`); same code as mac |
| Host | `UV_THREADPOOL_SIZE=8` · keep-on-exit · warm pool |

```bash
./scripts/linux-launch.sh flags   # print Chrome fallback args + profile
./scripts/linux-launch.sh open
npm run test:guix
```

## Quick start

**Setting up a *new* Guix machine? → [`docs/DEPLOY-GUIX.md`](./docs/DEPLOY-GUIX.md)**
(step-by-step with verification + failure table). The rest of this file assumes the
host is already deployed.

```bash
git clone https://github.com/aukkwat83/muse-desktop-guix.git ~/muse-desktop-guix
cd ~/muse-desktop-guix
npm install
./scripts/native-launch.sh open   # or: ./bin/muse-desktop
# install/restart host only:
./scripts/deploy.sh --start
# stop:
./scripts/deploy.sh --stop
```

## Lifecycle

The host reads a small env set (same names on both platforms):

| Env | Default | Meaning |
|-----|---------|---------|
| `MUSE_DESKTOP_MAX_HOT_AGENTS` | `6` | Hot session ceiling; beyond it idle sessions evict |
| `MUSE_DESKTOP_CREATE_WARM` | `1` | Background-warm new chats (`0` disables) |
| `MUSE_DESKTOP_KEEP_ON_EXIT` | `1` | Host survives UI close |
| `MUSE_DESKTOP_WATCHDOG_HARD_MS` | `3900000` | Ceiling before a live in-flight turn is auto-cancelled (65 min) |
| `MUSE_DESKTOP_PORT` / `MUSE_DESKTOP_HOST` | `3850` / `127.0.0.1` | Listen address |

## Attach picker (Linux)

`/api/pick-files` drives a freedesktop dialog (`src/server/file-picker.js`):
zenity preferred, qarma/yad share its argv, kdialog supported. Resolved per
request, so a later install takes effect without restarting the host:

```bash
guix install zenity
```

Without any dialog binary the attach button reports that visibly (it names the
fix) instead of failing silently. Override path:
`MUSE_DESKTOP_FILE_DIALOG=/path/to/zenity`.

## Proxy — no PAC on Guix

The mac host defaults spawned agents to the local PAC bridge
(`SCB_PAC_PROXY`, `http://127.0.0.1:39080`). That bridge does not exist on Guix,
so the fallback is **darwin-only** (`defaultPacProxy` in `msp-client.js`):
Linux children connect direct unless you export proxy env explicitly, which
always wins on both platforms. `scripts/deploy.sh` applies the same rule.

## Diagram PNG (Linux)

mac uses `qlmanage`. Guix uses **`rsvg-convert`** (preferred) or ImageMagick `convert`
(same code path, `rasterizeSvgToPng` in `src/server/index.js`):

```bash
guix install librsvg   # provides rsvg-convert
# or
guix install imagemagick
```

Downloads go to `XDG_DOWNLOAD_DIR` or `~/Downloads`. Reveal uses `xdg-open` on the folder.

## Auth on Guix

`muse login` is a device-code flow in a real terminal — the app cannot do it for
you. On macOS the login card opens Terminal with the command; on Linux it shows
the command for you to run yourself (`/api/auth/login` returns
`{manual:true, command}` off-darwin).

## Tests

```bash
npm run test:guix         # platform contracts: manifest, desktop, service, picker, proxy (18)
npm run test:guix-shell   # C shell contracts + stale-binary guard (16)
npm test                  # everything, incl. the two guix suites + e2e mock agent
```

## systemd --user (optional keep-alive host) — **not on Guix System**

`linux/systemd/` is for Guix-the-package-manager on a *foreign* systemd distro
(Debian/Fedora). **Guix System's PID 1 is GNU Shepherd** — there is no
`systemctl` and no `/run/systemd/system`, so the recipe below cannot run there.
On Guix System the host already survives UI close via `MUSE_DESKTOP_KEEP_ON_EXIT=1`;
`./bin/muse-desktop` starts it on demand and `./scripts/deploy.sh --stop` ends it.

On a foreign systemd distro:

```bash
mkdir -p ~/.config/systemd/user
cp linux/systemd/muse-desktop-host.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now muse-desktop-host.service
```

Then open UI only:

```bash
./bin/muse-desktop   # or scripts/linux-launch.sh open
```

## Thai typography — the clipped-tone-mark trap

Linux renders Latin in **Inter** and Thai in **Sarabun** (both in the
`--font-ui` stack, Latin faces first); mac uses SF + Thonburi.
Sarabun's raised tone marks (`่ ้ ๊ ๋ ์` over an upper vowel:
ที่, สั่ง, แล้ว) paint above the line box, so anywhere the UI combines
`white-space: nowrap` with `overflow: hidden`, the clip box slices them off and
Thai silently reads wrong (`สั่ง` → `สัง`). mac never reproduces it.

**When adding any new one-line ellipsised element, pad the clip box** (same trap
class grok-desktop fixed as R57-guix) — a bare `overflow: hidden` + tight
`line-height` is a Thai bug on this platform.

## Known Guix limits

- Card drag-out: the `cardDrag` bridge is registered but dormant — neither the
  mac shell nor the renderer implements the sender yet. Diagrams use the in-page
  download SVG / download PNG buttons everywhere.
- `diagramSave` is macOS-only; the renderer feature-detects it and falls back
  to the in-page download on Linux.
- `better-sqlite3` must compile against this Node (`npm install` does so; on a
  newer Guix Node without a prebuild, install inside
  `guix shell gcc-toolchain python`).
