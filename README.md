# Muse Desktop

A native macOS client for [Muse CLI](https://www.meta.ai/code), driving it
over MSP — the Muse Session Protocol (`muse serve`, JSON-RPC 2.0 over stdio).

Same shape as its siblings `kimi-desktop` / `grok-desktop`, from which it was
forked: a long-lived Node host owns the agents, a small SwiftUI + WKWebView
shell is the window. Closing the window does not kill a running task.

```
┌── MuseDesktop.app (SwiftUI) ──┐      ┌── Node host :3850 ──┐      ┌── muse serve ──┐
│  WKWebView → 127.0.0.1:3850   │ ───▶ │  sessions · SSE     │ ───▶ │  JSON-RPC      │
│  Host menu: log / restart     │ ◀─── │  chat store (JSON)  │ ◀─── │  over stdio    │
└───────────────────────────────┘  SSE └─────────────────────┘      └────────────────┘
```

## Requirements

- macOS 14+, Swift toolchain (Xcode or command line tools)
- Node.js 20+
- Muse CLI, logged in (`muse login` is a device-code flow and **must** run in
  a real terminal — the app cannot do it for you). Until it is done, turns
  fail with `not logged in` and the app shows a login card with the exact
  command (plus a button that opens Terminal with it).

Check where you stand at any time:

```bash
npm run test:msp
```

## Run

```bash
git clone https://github.com/aukkwat83/muse-desktop.git ~/Applications/muse-desktop
cd ~/Applications/muse-desktop
npm install
npm run mac
```

That builds the Swift shell, wraps `dist/MuseDesktop.app`, and opens it. After the first build,
launching is just `open dist/MuseDesktop.app` (or Spotlight → *Muse Desktop*).

To run only the host and use a browser instead:

```bash
npm run dev        # http://127.0.0.1:3850
```

## What it does

- **Groups and sessions.** Chats live in named, reorderable groups. Drag the ⋮⋮ handle to reorder
  a group, drag a chat onto another group to move it, double-click a group name to rename it in
  place. Each row has ＋ (new session here), − (delete, with an anchored confirm) and a ⋯ menu.
- **Multi-chat.** Each chat is its own agent process with its own working directory. Idle agents
  are released after 30 minutes; a chat with a running turn is never evicted.
- **Streaming transcript** with markdown, code blocks (copy button), tool rows that stream their
  output, and the agent's plan (todo list).
- **Tool approvals inline.** A pending approval is stored server-side, shows a badge in the chat
  list, and can be answered from any window — including one opened after the request arrived.
  Questions the agent asks also arrive as cards.
- **Modes** — `ask` → `plan` → `yolo`, cycled with the chip or ⇧⇥. They resolve onto the MSP
  approval modes (`promptUnmatched` / `denyUnmatched` / `allowAll`) via
  `MspClient.resolveModeId()`; never hardcode a wire id.
- **Send ⇄ Stop** is one morphing button; Esc cancels.
- **Sessions survive restarts.** The agent-side session id is resumed with `session/resume`
  (`excludeItems: true`) — we keep our own transcript, so a replay would duplicate it.
- **Three themes** on the ◐ button — Moonlight (dark), Claude Light (warm paper/terracotta),
  Daylight, plus Auto. Every colour is a token, and `npm run test:contrast` holds all three to
  WCAG AA.

## Keyboard

| Key | Action |
|---|---|
| ⏎ | send |
| ⇧⏎ | newline |
| ⇧⇥ | cycle mode |
| Esc | stop the running turn |
| ⌘N | new session |
| ⇧⌘N | new group |
| ⌘R | reload the UI (shell) |

## Layout

```
src/server/     msp-client.js     JSON-RPC over stdio to `muse serve`
                hosts.js          permission-card builders (approvals, questions)
                sessions.js       session pool + turn core (single settleTurn funnel)
                session-store.js  durable groups + chats (JSON, XDG state dir)
                sse-wire.js       SSE with ids + Last-Event-ID replay
                index.js          HTTP host: static, REST, SSE
src/renderer/   app.js            state, SSE, transcript
                sidebar.js        group tree: drag, rename, ＋/−/⋯
                popover.js        anchored menus and confirms
                markdown.js       marked + an allowlist sanitiser
                theme-boot.js     applies the saved theme before first paint
                style.css         tokens + layout (moonlight, daylight)
                theme-claude-light.css
                (vanilla ES modules — no framework, no build step)
macos/          MuseDesktopShell — SwiftUI + WKWebView + HostSupervisor
scripts/        launch, tests, mock agent, icon
```

State lives in `~/.local/state/muse-desktop/` (`chats.json`, `host.log`, `host.pid`).

## Testing

```bash
npm test          # all suites, incl. end-to-end against a mock MSP agent
npm run test:msp  # probe the real `muse serve`: handshake, session, streaming turn
```

See [docs/TESTING.md](docs/TESTING.md).

## Status

Working on macOS. Linux and Windows are **not** implemented — [docs/attic/](docs/attic/) holds two
non-functional sketches kept from the original scaffold.

## License

MIT
