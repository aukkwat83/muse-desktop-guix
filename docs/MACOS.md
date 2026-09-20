# Muse Desktop on macOS

## Launching

```bash
npm run mac                      # build shell if needed, wrap the .app, open it
open dist/MuseDesktop.app        # afterwards
npm run mac:build                # rebuild the shell + bundle only
npm run mac:host                 # run the Node host in the foreground (no window)
npm run mac:stop                 # stop the host and its agents
```

The bundle is built, not downloaded: `scripts/mac-launch.sh` compiles
`macos/MuseDesktopShell` with `swift build -c release`, copies the binary into
`dist/MuseDesktop.app/Contents/MacOS/`, renders `AppIcon.icns` from `assets/icon.png` with
`sips` + `iconutil`, writes `Info.plist`, and re-registers the bundle with Launch Services so the
Dock and Spotlight pick up the icon.

## Lifecycle

| Action | Effect |
|---|---|
| Close the window | host and agents keep running |
| ⌘Q | host and agents keep running (`MUSE_DESKTOP_KEEP_ON_EXIT=1`) |
| Host ▸ รีสตาร์ท host | graceful restart, serialized against any concurrent start |
| Host ▸ หยุด host + agents | the only sanctioned full teardown |

This is deliberate: an agent can be minutes into a task, and closing a window should not throw
that away.

### How the host is stopped

`POST /api/host/shutdown` first. Signals are a fallback and are **ownership-verified**: the shell
compares `host.pid` against the `pid` the live host reports at `GET /api/state` and refuses to
signal a pid it cannot confirm. A pid file alone is not proof — it goes stale across crashes, and
macOS recycles pids, so signalling a merely-remembered pid can hit an unrelated process.

## Environment

Baked into `Info.plist` as `LSEnvironment` at wrap time, because a GUI app does not inherit a
login shell's environment:

- `PATH` — includes the directory of the `node` that built the bundle, so `node` and the `muse` launcher under `~/.local/bin` resolve.
- `http_proxy` / `https_proxy` — adopted **only** if something is listening on the machine's local
  PAC bridge (`127.0.0.1:39080`) at wrap time. Nothing corporate is hardcoded; on a machine
  without it, the keys are written empty.
- `MUSE_DESKTOP_PORT` (default 3850), `MUSE_DESKTOP_ROOT`, `MUSE_DESKTOP_KEEP_ON_EXIT`.

Override the port with `MUSE_DESKTOP_PORT=3851 npm run mac`.

## Files

```
~/.local/state/muse-desktop/host.log     host stdout + stderr
~/.local/state/muse-desktop/host.pid     pid, cross-checked against /api/state
~/.local/state/muse-desktop/chats.json   chats and transcripts
~/.local/share/muse/                   the agent's own config and sessions
```

Host ▸ เปิด log ของ host and Host ▸ เปิดโฟลเดอร์ state open the first two.

## Troubleshooting

**Window shows "หมดเวลารอ host"** — the Node host did not come up. Read `host.log`; the usual
cause is a port already in use.

**Login card will not go away** — `muse login` must complete in a real terminal. Verify with
`npm run test:msp`; it prints the handshake result or the exact command to run.

**A UI change appears to do nothing** — WKWebView cached the old bundle. ⌘R purges the HTTP cache
and reloads; bump the `?v=` on `app.js` / `style.css` when shipping renderer changes.

**The app is not signed.** It is built locally for local use. Gatekeeper may prompt on first
launch after a rebuild.
