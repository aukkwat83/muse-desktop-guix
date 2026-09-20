# AGENTS.md — working on Muse Desktop

Read this before changing anything. It records the decisions that are load-bearing and the bugs
that motivated them, so they do not get re-introduced.

## What this is

A macOS client for Muse CLI over MSP (the Muse Session Protocol). Three processes:

1. **`MuseDesktop.app`** — SwiftUI shell, owns a WKWebView pointed at the host and the host's
   lifecycle. Contains no application logic.
2. **Node host** (`src/server/index.js`, port 3850) — owns agents, chat state and the SSE wire.
   Long-lived: it outlives the window on purpose.
3. **`muse serve`** — one child process per live chat, JSON-RPC over stdio.

`src/renderer/` is plain ES modules loaded straight from disk. There is no bundler, no framework
and no build step for the UI — edit and reload.

Forked from `kimi-desktop` (ACP) with the wire layer replaced; the turn core, store, SSE wire,
renderer and shell are the same lineage. `docs/bugfix/` keeps the kimi-era bug records — the
numbers are still cited in code comments where the lesson applies.

## Non-negotiables

**One funnel settles a turn.** `SessionManager.settleTurn()` is the only place that may emit a
terminal event. It is idempotent and ignores a `turnId` that is not the live one. Do not add a
second path that marks a turn finished — the lineage had three racing paths once and spent months
showing spinners for finished turns and painting answers twice.

**`POST /prompt` returns 202 and nothing else.** Every visible change arrives over SSE. Never
paint from an HTTP response body; that is what makes a second window (or a reload) show something
different from the first.

**Turn state is per chat.** `state.turnViews` in the renderer and `slot.turn` on the server are
both keyed by chat. A single "current turn" breaks the moment a user switches chats mid-stream.

**`mspSessionId` is flushed synchronously.** `SessionStore.update()` calls `flushNow()` for that
one field. A debounced write loses the race with process exit and leaves a dead agent-session id
on disk, which the next boot then retries forever.

**Terminal SSE events are never dropped.** Back-pressure may de-prioritise a delta; it may not
drop `turn_done` / `turn_error` / `interaction`. And the `hello` frame carries **no** `id:` — if
it carried the current sequence number, a client that dropped right after connecting would resume
past the events it had not received yet.

**Inline editors commit only on a real blur.** The sidebar's rename and "new group" inputs live in
a subtree that any SSE event can re-render, and detaching a focused node fires `blur`. Committing
on that blur created groups nobody asked for. `commitOnRealBlur()` checks `isConnected` a tick
later — keep that guard on any inline editor added here.

**Colour goes in a token, and `npm run test:contrast` has to stay green.** `--accent` is for
fills, `--accent-text` for accent-coloured type — never reuse one for the other, because the shade
that works as a button background is the wrong one for a label, in opposite directions on light
and dark themes. When adding a colour pair that carries text, add it to the PAIRS list in
`scripts/unit-test-theme-contrast.mjs`; the audit only protects what it knows about. And measure
muted text against the *tinted* surface it sits on (the active sidebar row), not the base panel —
that is where the dark theme quietly sat at 4.0.

**Group `order` is renumbered, never re-sorted, after a change.** `sortByOrder()` is for reading
from disk only. Calling it after a drag puts the list straight back and the reorder appears to do
nothing — that was a real bug.

**Unknown view events are forwarded, not swallowed.** They surface as
`agent_update_other`. A silently discarded channel is invisible until someone notices a feature
has never worked.

## Facts about `muse serve` (verified against 1.3.0, not assumed)

- Newline-delimited JSON-RPC 2.0 — same framing as the ACP dialect, different method set:
  `initialize` / `initialized` / `session/start|resume` / `turn/start|interrupt`, with view
  events (`item/*`, `turn/*`, `approval/*`, `userInput/*`, `session/*`) streamed back.
- Every `commandId` must be a **UUIDv7** or the host rejects it with `-32602`.
- `session/start` returns the session **and** auto-subscribes the connection; an explicit
  `view/subscribe` still works and is sent defensively.
- **`--no-session-log` withholds `view/subscribe`, `session/read` and `session/resume`** (the
  binary reports `sessionDurability: ephemeral`), and turn view events never flow. The client
  always spawns durable `serve` — verify before "simplifying" this.
- `turn/start` admits fast (`{status:'accepted', turnId}`); completion arrives as
  `turn/completed` with `terminal: completed|failed|cancelled`. There is no final content on
  the completion — the authoritative text is the `item/completed` agentMessage object, which
  replaces the span its deltas contributed.
- `item/delta` frames carry **no kind** — the client learns `itemId → kind` from `item/started`
  and falls back to the `field` name (`summary.*` → thought, `output` → tool output).
- Tool output streams through `field: 'output'` deltas; `fallbackText` shows only when no
  output arrived. `item/readOutput` is **not served** by 1.3.0 — never depend on it.
- Approvals arrive as **both** a server-initiated `approval/request` (answer `{}` receipt
  immediately; the decision travels separately as `approval/decide`) **and** an
  `approval/requested` notification. The client mounts exactly one card for the pair.
- `session/resume` returns history in the RESULT (no wire replay); `excludeItems: true` keeps
  it lean since we keep our own transcript.
- Login state surfaces as turn/RPC failures matching `not logged in` — there is no dedicated
  code. `muse login` is a device-code flow that cannot be completed over the socket.
- `model/list` is the model advertisement; the reasoning tiers are the schema's closed
  vocabulary (`none|minimal|low|medium|high|xhigh|max|ultra`). Export the exact schema for
  this binary any time with `muse schema generate-json-schema`.
- UI modes resolve onto the closed ApprovalMode vocabulary: `always→allowAll`,
  `normal→promptUnmatched`, `plan→denyUnmatched`. Mode changes apply live via
  `session/setApprovalMode` — no respawn exists on this path.

## Machine-local runtime notes

- Right after a session opens (new or resume), `MspClient.applySessionConfig()` pushes the
  configured model + reasoning effort via `session/setModel` / `session/setReasoningEffort`.
  Defaults come from `MUSE_DESKTOP_MODEL` / `MUSE_DESKTOP_EFFORT` (fallbacks: null = the
  binary decides). It is advisory like the mode set: an unadvertised value is skipped with a
  stderr note, never a session failure.
- `MspClient.spawnEnv()` falls back to the local PAC proxy (`SCB_PAC_PROXY`, default
  `http://127.0.0.1:39080`) **on macOS only** (`defaultPacProxy`): Finder/Dock launches strip
  the shell env. Linux/Guix has no PAC bridge, so the fallback there is direct connection.
  An explicitly exported env always wins over the fallback on both platforms.
- Agent sandboxes: a `muse serve` child started from inside a sandboxed agent session can
  fail its MCP startup audit (turns die with `MCP startup audit failed`). That is an
  environment artifact, not a product bug — the deployed app runs as the user, unsandboxed,
  where the same binary serves turns fine. `npm run test:msp` documents what it observes.

## Testing

`npm test` runs the unit suites plus an end-to-end suite — the live list is the SUITES
array in `scripts/unit-test-all.mjs` (count it there; do not hardcode a number here). The E2E starts a **real host process**
and drives it over real HTTP/SSE; only the agent is replaced, by `scripts/mock-msp-agent.mjs`.
That mock exists because `muse serve` needs a login and a full MCP audit, which makes the turn pipeline
otherwise untestable on a fresh machine or in CI.

Anything that touches turn timing must get an E2E case, not just a unit test. Every ordering bug
in this family passed its unit tests.

## Conventions

- Two-space indent, single quotes, semicolons; ES modules everywhere.
- Comments explain *why*, especially where the obvious implementation is the wrong one.
- UI strings are Thai; identifiers and comments are English.
- Colours live in the token block at the top of `style.css`. Nothing below it hardcodes a hex.
- The `?v=` token in `index.html` and the `package.json` version are ONE number — bump them
  together when any linked renderer asset changes: WKWebView otherwise serves a stale bundle
  and the change looks like it did nothing, and the version badge lies about the serving build
  (the css-guards suite fails when the two drift, BUG-078).

## Guix / Linux shell

`linux/gtk-shell/main.c` is the C shell (GTK4 + WebKitGTK); `muse_desktop_shell.py`
is the fallback/reference. Same contracts as the mac shell: reload bypasses the
cache, restart goes through `POST /api/host/shutdown {killAgents:false}`, the
Inspector is on. Guix stack modelled on grok-desktop `deploy/v0.8.9-guix`.

- **Launch path.** `build.sh` links the binary against `/gnu/store`, so
  `native-launch.sh` execs it directly. Never wrap that exec in
  `guix shell -m manifest.scm` (re-realizes ~105 MB per launch, no output —
  reads as "the app won't open"). The slow path stays behind
  `MUSE_DESKTOP_FORCE_GUIX_SHELL=1`. Guarded by `npm run test:guix-shell`.
- **`bin/muse-desktop` resolves itself through symlinks** (`~/.local/bin`
  points at it). Without that, ROOT becomes `~/.local` and the built binary is
  "not found" (HAZ-10). Guarded by the same suite.
- **Reload is renderer-only.** After a server-side change, ↻ Restart host (or
  `deploy.sh --stop` + `--start`) — Ctrl+R alone repaints the new bundle
  against the old node process.
- **No PAC on Guix** (see above). No `chrome-shell.js` SoT — the Chrome
  fallback uses minimal inline `--app` flags.
- **Thai clip trap.** Sarabun's raised tone marks paint outside the line box;
  never ship a bare `overflow: hidden` + tight `line-height` on one-line
  elements (see `GUIX.md`).
- The `cardDrag` bridge is registered but **dormant** — no sender exists yet.
  `diagramSave` stays macOS-only; the renderer falls back to in-page download.

## Things deliberately not built

- Windows. (`docs/attic/` has two sketches from the original scaffold; neither runs.
  Linux is implemented now — this section used to say otherwise.)
- Electron. The shell is Swift; there is no `electron-builder` path.
- Multi-question / multi-select / free-text agent questions. The card posts a single optionId
  and `userInput/answer` requires every question answered, so shapes that do not fit are
  auto-cancelled with a visible `msp:user_input_unsupported` trace instead of stranding the
  turn. The single-question single-select shape covers the common case.
- MCP parity with the TUI. Sessions run with the binary's own MCP audit; the desktop adds no
  servers of its own (same as the kimi lineage, which passed `mcpServers: []`).
- Image/audio prompt blocks. We send text only.
