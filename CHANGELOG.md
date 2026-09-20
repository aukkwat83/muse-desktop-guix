# Changelog

## 1.1.0 — 2026-09-21

Guix System port (new repo `muse-desktop-guix`, mac v1.0.0 imported as baseline).
Guix stack modelled on grok-desktop `deploy/v0.8.9-guix` @ `35dac5c`
(`v0.9.4-guix-shell-host`). Nothing mac removed. Full note:
[docs/releases/v1.1.0-guix-parity.md](docs/releases/v1.1.0-guix-parity.md).

### Added

- **Native GTK shell** (`linux/gtk-shell/main.c` + Python fallback): real GNOME
  window over WebKitGTK — cache-ignoring Reload (Ctrl+R/F5), ↻ Restart host
  (`app.restart-host` GAction, warm agents survive), Web Inspector, memory
  meter, external-link trap. `cardDrag` bridge registered but dormant (no
  renderer sender yet).
- **Launchers**: `bin/muse-desktop` (symlink-safe ROOT, native-first with
  Chrome fallback), `scripts/native-launch.sh` (prebuilt fast path, no
  per-launch `guix shell`), `scripts/linux-launch.sh` (host + Chrome `--app`),
  `scripts/install-desktop.sh` (menu/Desktop/CLI/icon), Guix manifest,
  systemd user unit (foreign distros; Guix System uses Shepherd).
- **Attach picker on Linux**: `/api/pick-files` drives zenity/qarma/yad/kdialog
  (`src/server/file-picker.js`); the "macOS only" dead-end is gone.
- **Darwin-only PAC fallback** (`defaultPacProxy`): Linux agents connect direct
  unless proxy env is explicit; `deploy.sh` matches and builds/stops per platform.
- **Ctrl+N / ⇧Ctrl+N** for new session/group on Linux (Cmd variants unchanged).
- **Suites**: `test:guix` (18, platform contracts) + `test:guix-shell` (16, C
  contracts + stale-binary guard), both in `npm test`.
- **Docs**: `GUIX.md`, `docs/DEPLOY-GUIX.md`, `docs/releases/`.

## 1.0.0 — 2026-09-21

First stable release. Everything below landed on top of 0.1.0 (MSP port) and
0.2.0 (MCP + subagent panels); all of it is covered by `npm test`
(27 suites green, e2e 54/54).

### Added

- **Mermaid diagrams** (grok-desktop parity): ` ```mermaid ` fences paint as SVG
  cards with ⧉ Mermaid (copy a gitdop-renderable fence), ↓ SVG and ↓ PNG
  (host download to ~/Downloads), hero-size `mermaid-hero`/`viz` boxes,
  per-theme palettes with re-tint on theme switch, and graceful source
  fallback when a diagram cannot be drawn.
- **Cross-chat search** (FTS5, grok-desktop parity + trigram): sidebar box
  finds any substring in any chat — Thai mid-token included — with operator
  filters (`group:`/`kind:`/`in:`/`is:`), `⌘F` find-in-chat over generated
  content only, deep-link + flash navigation, boot rebuild of every session,
  and a self-healing open (corrupt db quarantines and rebuilds; FTS is never
  silently disabled).
- **File attach** (grok-desktop UX, cleaner wire): native macOS picker,
  pasted paths, paste/drop images, per-chat chips; images ride as MSP `image`
  parts and files as `@path` mentions in a separate text part — the user's
  own text is never merged with attachment preambles.
- **Context + usage pills**: grok-style context bar with session used/limit
  in the header, subscription pill with 5h + weekly quota and reset times.
- **Tasks + goal chips**: live task counts and the active goal with progress
  in the header, drill-down on click.
- **Resizable sidebar** with persisted width (double-click resets) and a
  full-bleed result column that follows the drag.

### Changed

- New chats default to **yolo + ultra**; stream latency cut (text-only fast
  path, 8ms batch, 32ms markdown) toward grok-desktop responsiveness.
- Cold-start honesty: the composer warms the agent while you type
  (create-warm hides the ~20s MCP connect) and the UI says so while warming;
  last-used MCP servers persist across restarts.

### Fixed

- Turn-text accumulation (delta into turn total + reconcile on item
  completion), ack/delta-burst race that dropped deltas, transcript pollution
  from item deltas, turn-ack races, and a flaky long-burst e2e.

## 0.1.0 — 2026-09-20

First release. Forked from `kimi-desktop` (0.4.x) with the agent wire replaced:
the app now drives Muse CLI over MSP (`muse serve`) instead of Kimi over ACP.

### Changed (the port)

- **New wire client** (`src/server/msp-client.js`): `initialize` / `session/start|resume` /
  `turn/start|interrupt` over newline-delimited JSON-RPC, UUIDv7 command ids, durable sessions
  (ephemeral `--no-session-log` withholds the view events), MSP frames normalized to the turn
  core's update kinds.
- **Modes** `ask → plan → yolo` now resolve onto the closed ApprovalMode vocabulary
  (`promptUnmatched` / `denyUnmatched` / `allowAll`) and apply live via
  `session/setApprovalMode` — no respawn exists on this path.
- **Model + thinking selects** come from `model/list` and the schema's closed reasoning tiers
  (`none…ultra`), applied via `session/setModel` / `session/setReasoningEffort`.
- **Approvals and questions** arrive as `approval/*` / `userInput/*`; single-question prompts
  mount an ask card, wider shapes auto-cancel with a visible trace instead of stranding the turn.
- **Mock agent + E2E** rewritten for the MSP dialect (`mock-msp-agent.mjs`, 38 cases green);
  `npm run test:msp` probes the real binary (handshake → session → streaming turn).
- Host port **3850** (kimi keeps 3849), state dir `~/.local/state/muse-desktop/`, bundle
  `MuseDesktop.app` (`com.aukkwat83.musedesktop`).

### Kept from the lineage

Turn core (single `settleTurn` funnel), chat store, SSE wire with replay, renderer, Swift shell
shape, themes + contrast audit, deploy/launch scripts. `docs/bugfix/` keeps the kimi-era bug
records; the numbers are still cited where the lesson applies.
