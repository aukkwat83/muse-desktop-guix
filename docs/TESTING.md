# Testing

```bash
npm test          # everything
npm run test:msp  # probe the real `muse serve` (needs the CLI installed)
```

## Suites

| Command | What it covers |
|---|---|
| `npm run test:mode` | mode vocabulary, the ask→plan→yolo cycle, MSP approval-mode round-trip |
| `npm run test:store` | write-through vs debounce, one-assistant-message-per-turn, reload, corrupt file |
| `npm run test:groups` | v1→v2 migration, ordering, last-group rule, cascade delete, chat membership |
| `npm run test:contrast` | WCAG AA for 21 colour pairs × 3 themes, read from the CSS token blocks |
| `npm run test:wire` | SSE ids, replay via `Last-Event-ID`, subscription filtering, terminal-event delivery |
| `npm run test:turn` | `settleTurn` idempotency and staleness, chunk accumulation, watchdogs, mode resolution |
| `npm run test:e2e` | a real host process driven over real HTTP + SSE |

## Why there is a mock agent

`muse serve` needs a login and runs a full MCP startup audit, which makes every interesting
path — streaming, tool calls, approvals, cancellation — untestable unattended.

`scripts/mock-msp-agent.mjs` speaks the same dialect and is selected with `MUSE_BIN`. It
reproduces the shapes the host actually depends on: the initialize handshake, `model/list`,
streamed `item/delta`s, a tool call with streamed output, an `approval/request` round-trip, a
`userInput` question card, a todo-list plan, and an authoritative final `item/completed` object.
Its behaviour is driven by keywords in the prompt (`tool`, `ask`, `quiz`, `plan`, `slow`,
`boom`), and `MOCK_MSP_MODE=authwall` makes it refuse `session/start` with a login error so
the login gate can be tested.

The E2E suite starts the **real** `src/server/index.js` as a child process and talks to it over
real HTTP and a real SSE stream. Only the agent is substituted.

```bash
MUSE_BIN=$PWD/scripts/mock-msp-agent.mjs npm run dev   # drive the mock by hand in a browser
```

## What the E2E asserts

- `POST /prompt` returns 202 quickly and does not block for the turn
- deltas stream, then **exactly one** `turn_done`
- the agent's final content overrides the accumulated chunks
- a completed turn leaves exactly one user + one assistant message (no echo duplicate)
- tool calls stream and reach `completed` with their output
- an approval surfaces, is listable via `GET /api/interactions`, and the answer reaches the agent
- a second prompt during a live turn is rejected `409 TURN_IN_FLIGHT`
- cancel settles the turn with `reason: "cancelled"`
- no approval is left stranded after the turns end
- a mode change is applied and echoed with the agent's own mode id
- `mspSessionId` is on disk for the next resume
- SSE replay after reconnect delivers missed ids, in order
- groups create / select / rename / reorder / delete over the wire, each broadcast on SSE
- a chat lands in the group it was created in, and moving it updates both groups' counts
- reorder is applied by the server *and* survives on disk
- deleting a group removes its chats; deleting the last group is refused with `409 LAST_GROUP`
- an unauthenticated agent raises `auth_required` carrying a terminal command

## Adding tests

Anything touching turn timing needs an E2E case. Every ordering bug in this codebase's family —
double-settled turns, duplicated answers, spinners that never stop — passed its unit tests.
