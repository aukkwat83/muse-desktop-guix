# Changelog

## 1.1.27 — 2026-10-07

Hotfix for the 1.1.26 overview/history code, caught by live screenshot
verify on Guix: it called a `subKindOf` helper that exists nowhere, so
every transcript with tool history painted
"Can't find variable: subKindOf" and the thread-overview agent rows
could never open. Agent classification now goes through
`agentToolMeta(tool)` directly and overview status words mirror the
tool rows (`ทำงานเบื้องหลัง` for background agents, else the shared
wire-status label). Settled text-only turns keep their `ทำไป Xs`
header (the live `กำลังทำ…` no longer vanishes on reload).
Regression cover: new `renderer-contracts` suite (renderer no-undef
scan + import resolution + helper shapes).
Full note: [docs/releases/v1.1.27-overview-hotfix.md](docs/releases/v1.1.27-overview-hotfix.md).

## 1.1.26 — 2026-10-07

ChatGPT Desktop parity: live + settled turn headers (`กำลังทำ Xs` /
`ทำไป Xs`), persisted `durationMs`, thread overview popup (`▦`:
Subagents / Tasks / Goal), composer goal strip with pause/resume.
Full note: [docs/releases/v1.1.26-thread-overview.md](docs/releases/v1.1.26-thread-overview.md).

## 1.1.25 — 2026-10-07

Result-stack dividers actually reach history: the history wrap holds one
assistant wrap per message (not blocks), so it gets a
`.msg-assistant-turn` hook and the rule scopes to
`.turn.live-turn` + `.msg-assistant-turn`. Caught by pixel scan of a
WebKit snapshot (the 1.1.23 rule only divided live turns and drew
between messages instead).

## 1.1.24 — 2026-10-07

Result-stack dividers use the standard `--line` separator token —
`--line-soft` proved nearly invisible on the paper theme (verified by
window screenshot on Guix).

## 1.1.23 — 2026-10-07

ChatGPT-desktop-like result stack: assistant turns render as sections
going down with a quiet divider line between each block (activity group,
answer, cards). One CSS rule covers live + history (same DOM order).
Full note: [docs/releases/v1.1.23-result-stack.md](docs/releases/v1.1.23-result-stack.md).

## 1.1.22 — 2026-10-07

Inline child activity in transcript agent rows (ChatGPT-desktop-like nested
delegate view): an agent tool row that names a durable child inlines the
child's status + step rows above its console, live while it runs, via the
existing drill endpoint. Server resolves `tool.agentLink` per row; rows
without a child id keep the old console-only body. Full note:
[docs/releases/v1.1.22-child-activity.md](docs/releases/v1.1.22-child-activity.md).

## 1.1.21-guix-sync — 2026-10-07

Forward-port of mac `muse-desktop` v1.1.1–v1.1.21 (`8541024`→`83f5e73`)
onto the Guix stack from v1.1.0. 58 mac files taken wholesale; 8 overlap
files 3-way merged (both sides kept); `?v=` bumped to 1.1.21 with the
version; `test:guix` now accepts any version ≥ 1.1.0. Full note:
[docs/releases/v1.1.21-guix-sync.md](docs/releases/v1.1.21-guix-sync.md).

## 1.1.21 — 2026-10-05

แถว reminder โชว์หัวเรื่องงานแทนบรรทัดกลาง (`gen 3 ·
remind: …` จากคำตัดสินใน child session) drill มี state ย่อ
ของงานที่กำลังทำ และปุ่ม ⧉ เปิด child session ในหน้าต่าง live ใหม่

### Added

- **หัวเรื่องแถว reminder**: server สกัด `submit_reminder_decision`
  จาก child session พับเป็นหัวข้อแถว (`gen N · decision: reason`)
  ทั้งตอนจบ (live-fold ครั้งเดียว) และตอน drill (สำรอง) —
  บรรทัดกลาง `Reminder child session` ไม่โชว์อีก
- **state ย่อใน session details**: drill เปิดด้วยการ์ดสรุปคำตัดสิน
  (reminder) และเวลา elapsed + หาง live stream (native ที่กำลังรัน) —
  คำตัดสินที่พับไว้ยังอยู่แม้ session เก่าถูกลบแล้ว (โหมด gone)
- **ปุ่ม ⧉ เปิดหน้าต่าง live ใหม่**: หัว drill เปิด `child.html`
  หน้า standalone ที่ poll drill endpoint ทุก 2.5s ขณะรัน —
  shell เปิดเป็น NSWindow จริงผ่าน `createWebViewWith`
  (same-origin เท่านั้น นอกนั้นไปเบราว์เซอร์จริง)

### Fixed

- **การ์ดคำตัดสินโชว์ครั้งเดียว**: หน้า `child.html` ไม่วาดแถว
  `สรุป:` ซ้ำซ้อนกับการ์ดในรายการ items (เท่ากับ drill ใน rail)
- **เปิดแชทแล้วเห็น subagents ทันที**: ดึง registry ครั้งเดียวตอน
  เปิดแชท (แบบเดียวกับ goal/ctx) — เดิมโหลดหน้าใหม่แล้วแผง
  ขึ้น 0/0 จนกว่าเทิร์นใหม่จะส่ง event มา

## 1.1.20 — 2026-10-05

แถวแชทที่กำลังรันมี effect แบบ grok-desktop: ทั้งแถบ
label กระพริบ shimmer กวาดผ่านพร้อมแถบสี warn

### Added

- **แถว session รันมี shimmer ทั้งแถบ**: พอร์ต
  `is-processing` จาก grok-desktop มาเป็น
  `.session-item.is-running` (warn wash + แถบซ้าย +
  shimmer กวาด 1.6s) จุด pulse เปลี่ยนเป็นสี warn
  ให้เข้าชุด — `prefers-reduced-motion` ปิด sweep ให้

## 1.1.19 — 2026-10-05

progress group อ่านเป็นหัวข้อเรื่องแทนคำสั่งดิบ: ชื่อ tool
หยิบหัวข้อภาษาคน (`description`/`objective`/`task_name` ฯลฯ)
ก่อนคำสั่ง/path, แถวโชว์หัวข้อ + ชนิด tool ตัวจาง, หัวกลุ่ม
โชว์ขั้น plan ที่กำลังทำ (ไม่มี plan ค่อยใช้หัวข้อ tool ที่รันอยู่)

### Added

- **หัวข้อ progress group ไลฟ์**: หัวกลุ่มโชว์ขั้น plan
  `in_progress` (เช่น `ลงมือทำ · 3 tools · plan 2/4`) —
  ไม่มี plan ค่อยถอยไปหัวข้อ tool ตัวที่รันอยู่ แล้วค่อยจำนวน
  agent — ประวัติที่จบแล้วคงหัว `Progress Bar` เดิม

### Fixed

- **`toolTitle` หยิบหัวข้อก่อนคำสั่ง**: args ที่มี
  `description/summary/topic/objective/task_name` ได้ชื่อนั้น
  ล้วนๆ ไม่ต่อท้ายชื่อ tool; ไม่มีหัวข้อค่อยถอยไปป้ายสั้น
  (basename ของ path, บรรทัดแรกของคำสั่ง) — เลิกดัมพ์ JSON
  ดิบ 120 ตัวอักษรลงชื่อแถว
- **แถว tool + สถานะเลิกชื่อซ้ำ**: `กำลังใช้ Bash ls …`
  เหลือ `กำลังใช้ ls …` (หัวข้อใหม่ที่ไม่มี prefix เหลือแค่
  หัวข้อล้วน), ชนิด tool ย้ายไป subtitle ตัวจาง, ชื่อเต็มเดิม
  อยู่ต่อใน tooltip + การคัดลอก transcript

## 1.1.18 — 2026-10-02

ต่อจาก 1.1.17 ที่ tracker เห็นแค่เทิร์นใหม่: ประวัติเก่า (spawn
ก่อน tracker เกิด ซึ่ง output หายเพราะบั๊ก `visibleOutput` เดิม)
กู้คืนจาก parent history ตอน boot — และ drill ของ child ที่
session โดนล้างไปแล้วไม่จอ error เปล่าอีก

### Added

- **backfill native ย้อนหลังจาก parent history**: ตอน agent boot
  อ่าน parent session ครั้งเดียว พับ spawn/wait เก่าเป็นแถว
  รายเรื่อง (merge ตาม key ไม่ซ้ำแถว) — งาน parallel เก่าๆ
  (AP1962 recall, redis-bg, dmsbot-ramc ฯลฯ) กลับมาเห็นใน rail
  ทันทีที่เปิดแชทครั้งถัดไป

### Fixed

- **drill session หายแสดง record detail**: child ที่ session โดน
  prune (เช่น reminder ที่ cancel) เจาะแล้วได้ agent/gen/task/
  status/result ที่เหลืออยู่ + บรรทัดเตือนสาเหตุ แทนหน้า
  `sessionNotFound` เปล่าๆ

## 1.1.17 — 2026-10-02

แก้แผง subagent ให้เห็นงาน parallel จริง: probe เจอว่า child ที่
spawn ผ่าน `subagent_spawn` ไม่ได้มาเป็น item `subagent` แต่เป็น
toolCall ธรรมดาที่ output มาทาง `visibleOutput` (ไม่มี delta เลย)
ซึ่ง client เดิมทำหล่นทั้งหมด — ต่อ tracker ใหม่ + พับ system
reminder ที่เคยกลบจอเข้ากลุ่มเดียว

### Added

- **แถว native subagent รายเรื่อง**: ชื่อ task/objective/role จาก
  spawn args, สถานะ running/completed จาก wait, เจาะดู detail
  (brief + ผล + evidence refs) — native child ไม่มี MSP session
  (`session/read` ปฏิเสธ id) เลยไม่มีปุ่ม stop/resume/send
  (server ตอบ 409 ตรงๆ แทนยิง RPC ที่ไม่เคย probe)
- **พับ system reminders**: `reminderChild` ไปอยู่กลุ่ม collapsed
  `system reminders · N` ท้ายรายการ พร้อมชื่อ agent
  (skill/memory/goal/verify-reminder) + gen — แถวของจริงลอยขึ้น
  บน ไม่โดน 41 แถวกลบอีก

### Fixed

- **toolCall completion อ่าน `visibleOutput`**: instant tool ทุกตัว
  (spawn/wait/read ฯลฯ) เคยโชว์ output ว่างใน transcript เพราะ
  client ดูแค่ delta stream — streamed tool ยังให้ stream ชนะ
  เหมือนเดิม แถวเดิมไม่หด

## 1.1.16 — 2026-10-02

แผงขวาดู subagent ได้เหมือน CLI/Codex: ใต้ตัวเลขนับมีรายชื่อ child
รายตัว (สถานะ + ข้อความสด) กดแถวไหนเจาะดู session ของ child นั้น
inline พร้อมข้อความสดและ poll 2.5s ขณะรัน — popover เก่า
(`subagents-panel.js`, dead ตั้งแต่ย้ายมา rail) retired แล้ว

### Added

- **รายชื่อ subagent + drill inline ในแผงขวา**: แถวละ child
  (role/objective, สถานะ, ระยะเวลา, ผลลัพธ์/ข้อความสด) กดเจาะดู
  transcript ของ child + ซ้อนชั้นลึกได้อีก 1 ระดับ; delta แพตช์
  ตรงจุด ไม่ render รายการใหม่ทับใต้ cursor
- **สั่ง child รายตัว**: child ที่รันอยู่มีปุ่ม ⏹ หยุด (ถามยืนยัน)
  กับ ✉ ส่งข้อความ (ฟอร์ม inline, draft ไม่หายตอน poll);
  child ที่จบแล้วมี ▶ ทำต่อ — repaint มาจาก item SSE
  เสมอ ไม่ได้ paint จาก POST reply
- **registry รอด restart**: mirror sanitized records ลง chats.json
  (ตัด liveText, cap 50/แชท, ไม่ดัน queue order) — เปิด rail
  หลัง restart เห็นแถวเดิมทันทีโดยไม่ต้อง prompt

### Fixed

- **mock `session/resume` adopt id ที่ขอ**: ของเดิมเสก id ใหม่ทุก
  boot ทำให้ host/mock fork id กันหลัง rotation — verb ไหนเช็ค
  sessionId (subagent/* ทั้งหมด) จะ 502 หมด; binary จริง resume
  แล้วคง id เดิม (BUG-082 pin ไว้) mock เลยต้องทำตาม
- **e2e `void req` มี catch**: teardown ฆ่า socket กลางทางแล้ว
  rejection ลอย — step ไหนวิ่งต่อท้าย (restart persistence)
  จะโดน crash ทับ

## 1.1.15 — 2026-10-01

เทิร์นที่ agent เรียก `request_user_input` แล้ว live frame มาไม่ถึงค้างตลอดกาล
(แชท f381a7e1 ค้าง 2 ชม. ไม่มีการ์ด ไม่มี trace ไม่มี cancel — repro ยืนยัน
บน binary จริง): ตอนนี้ watchdog อ่าน `approval/listPending` ซ้ำเมื่อเทิร์น
เงียบนาน แล้ว mount/cancel/escalate เอง — wedge ยาวสุด ~75s ไม่มีค้างตลอดกาล
([BUG-084](docs/bugfix/BUG-084-ghost-userinput-poll.md))

### Fixed

- **Poll กู้ prompt ที่ live frame หาย**: lively แต่เงียบเกิน 45s
  (`MUSE_DESKTOP_PENDING_POLL_MS`) → อ่าน pending แบบ point-in-time —
  คำถามเดียว mount การ์ด, หลายคำถาม auto-cancel + notice ภาษาไทย
  ที่ persist ลง transcript (ของเดิมมีแค่ SSE ซึ่ง renderer ไม่แสดง)
- **Cancel ที่ agent เมินไม่ค้างอีก**: cancel แล้วยัง pending เกิน 30s
  (`MUSE_DESKTOP_CANCEL_GRACE_MS`) → interrupt run + settle ดังพร้อม
  สาเหตุ + release host ให้ prompt หน้าบูตใหม่
- **Interactive RPC ไม่ล้มเงียบอีก**: answer/cancel/decide ที่ถูก reject
  ลง stderr (host.log + transient notice) ทุกจุด — ของเดิมกลืนหมด
  ด้วย `.catch(() => {})`; rx frame + ผลสำเร็จลง `diag` (log อย่างเดียว)
- **Mock ตรง schema**: `userInput/cancel` resolve waiter จริง
  (ของเดิมตอบ `{}` แล้วทิ้ง — e2e เลยไม่เคยจับ wedge นี้ได้)
- **สาเหตุจริง: cancel ไม่มี `reason` ถูก reject**: binary 1.4.2
  ต้องการ field `reason` (ทั้งที่ schema บอก optional) — live frame
  มาถึงปกติแต่ cancel ตายตั้งแต่ RPC แรก; ทุกจุดส่ง `reason` แล้ว +
  cancel path dedupe (คู่ request+notification = 1 RPC + 1 notice) +
  mock enforce `reason` กันถดถอย

## 1.1.14 — 2026-10-01

### Changed

- **ESC ถามก่อนหยุด**: กด ESC ระหว่างเทิร์นรันอยู่จะไม่หยุดทันทีอีกต่อไป —
  เปิด confirm "หยุดเทิร์นนี้ใช่หรือไม่?" ใต้ปุ่ม Stop (pattern เดียวกับ
  confirm ลบ session) ตอบ "หยุด" ถึงหยุด; "ทำต่อ"/คลิกข้างนอก/ESC ซ้ำ =
  เทิร์นรันต่อ ถ้าเทิร์นจบหรือย้ายแชทไปแล้วตอนตอบตกลง จะไม่หยุดอะไรเลย

## 1.1.13 — 2026-10-01

### Fixed

- **เทสไม่ล้าง search index จริงอีกต่อไป**: `SessionManager`
  รับ `searchDbPath` ได้แล้ว 3 suites (groups/goal-tasks/turn-core)
  ผูก index ไว้ที่ temp db — `npm test` ไม่เขียนทับ index ของ
  ผู้ใช้ ([BUG-083](docs/bugfix/BUG-083-test-suite-wipes-live-search-index.md))
- **bump `?v=` cache-buster เป็น 1.1.12** (ตกค้างจาก release ที่แล้ว)

## 1.1.12 — 2026-09-30

เทิร์นที่ตายด้วย `MCP startup audit failed` จะไม่ค้างแชทอีกต่อไป:
host ที่ poisoned จะถูกปล่อยทิ้ง เปิด agent ใหม่ resume เซสชันเดิม
โดยอัตโนมัติ แล้วลองส่ง prompt เดิมอีกครั้ง — context ไม่หาย
([BUG-082](docs/bugfix/BUG-082-mcp-audit-failed-rotation.md))

### Fixed

- **หมุน agent ใหม่เมื่อเจอ MCP audit failure**: matcher
  `isMcpAuditFailedError` จับ reason ตรง production, settle เทิร์น
  ที่ล้มเป็น `rotated` พร้อม notice ภาษาไทย, `releaseClient` ทิ้ง
  host ที่ poisoned แล้ว retry ครั้งเดียวบน agent ใหม่ —
  session เดิมอยู่ครบ (ต่างจาก history-incompatible ที่ต้องทิ้ง
  session) ถ้า host ใหม่ยังล้มซ้ำจะ surface เป็น turn_error
  ตามปกติ ไม่ retry วน

## 1.1.11 — 2026-09-30

กดเมนู Host แล้วแอป crash ทันที (SIGTRAP ใน `NSMenuItem._description`
ทุกครั้งที่ highlight): title ภาษาไทยที่เป็น Swift-native string ไปตก
หลุม bridging bug ระหว่าง Swift stdlib กับ Foundation บน macOS 26
([BUG-081](docs/bugfix/BUG-081-host-menu-thai-title-trap.md)).

### Fixed

- **Host menu ย้ายเป็น AppKit ล้วน**: สร้างเมนูใน
  `AppDelegate.installHostMenu` แทน SwiftUI `CommandMenu`; ทุก title
  ผ่าน `NSString` (Foundation-owned storage) — เมนูไทย 4 รายการเดิม
  เปิด/hover ได้ปกติ
- **Regression probe ใหม่**: `npm run test:menutitle` ยิง
  `NSMenuItem.description` ตรงๆ บน title ที่ ship จริง + pin ใน
  `test:mac-app` กันย้ายเมนูกลับไป SwiftUI

## 1.1.10 — 2026-09-29

A chat whose agent session resumed with a failed `view/subscribe` hung every
turn forever: the agent answered and completed (proven in its own session
log) but the desktop never received a single frame, and the watchdog held
the dead turn open because the client looked lively. Three gaps closed
([BUG-080](docs/bugfix/BUG-080-deaf-client.md)).

### Fixed

- **Deaf clients fail loud at spawn**: `view/subscribe` retries 3×, then
  throws `SUBSCRIBE_FAILED` instead of serving turns no completion could
  ever reach; `prompt()` additionally refuses to run unsubscribed.
- **Watchdog cuts lively-but-never-active turns**: zero frames past the
  180s no-activity window settles with a human-readable error and releases
  the deaf agent, so the next prompt boots fresh. Turns that produced any
  activity still hold forever (74f04882 preserved).
- **Agent diagnostics are visible**: `agent_stderr` renders as a transient
  notice (it previously had no renderer handler), dropped completions log
  their turn ids, and host.log lines carry timestamps.

## 1.1.9 — 2026-09-29

The group's ▸/▾ button was disabled for whichever group held the session on
screen — with a single group it could never be pressed at all. Any group now
collapses, including the active one.

### Changed

- **Collapse works on every group**: dropped the lock-open rule (and its
  `disabled` button + menu item) — `toggleExpanded` no longer refuses the
  active group.
- A real session switch still re-expands the incoming group, but a same-chat
  refetch (turn_done repaint) leaves a deliberate collapse alone.

## 1.1.8 — 2026-09-29

Selecting a session to look at it no longer pushes it to the top of its
group. Queue order is conversation activity only: a prompt sent, or a run
settled.

### Changed

- **Viewing never reorders**: `selectChat` no longer `POST`s `/touch`, and
  the `touch` route plus both `touchChat()` layers are gone — opening an old
  session leaves the sidebar exactly where it was.
- **`SessionStore.update()` is metadata-only**: mode/model/effort/title edits
  and agent spawn/rotation ids no longer bump `updatedAt` (merely warming an
  agent used to reshuffle the list). Only `addMessage`/`setAssistantMessage`
  move a chat to the top.

## 1.1.7 — 2026-09-21

Usage snapshot for Übersicht: weekly + 5h limits land in
`usage.json` next to `chats.json` so ai-limits shows a Muse row.
Goal/tasks rail follows Mcode; SCB rail section removed.
Covered by `npm test` (34 suites green, e2e 57/57).

### Added

- **`usage.json` cache next to `chats.json`**: every usage update
  (live `usage/changed` events, `/api/usage` refreshes, and a
  fire-and-forget refresh whenever a new session boots) persists the
  sanitized `{ tier, observedAtMs, window, weekly }` snapshot via an
  atomic tmp+rename write that never throws into the turn.
- ai-limits-ubersicht reads the file first (fresh < 10 min), falls
  back to the socket probe, and shows the Muse row again; a stale or
  missing file shows "รอข้อมูล" instead of guessing.
- **Goal pause/resume in the right rail** (Mcode
  ConversationStatusPanel parity): the goal header carries ⏸/▶/✓ for
  `goal/pause` + `goal/resume` (`POST /api/chats/:id/goal`, 404/400/
  409 guarded); the repaint rides the `goalChanged` SSE the verb
  triggers. Disabled while the chat is cold.

### Changed

- **Goal + tasks rail follows Mcode**: one section each; per-todo
  status glyphs (✓/→/○/✕), 2-line clamp with full text on hover,
  done rows struck through, the running row shows `activeForm` when
  the wire carries it, and past 6 items only the 3 around the focus
  stay visible while the rest fold into native `<details>` groups
  ("เสร็จแล้ว n รายการ" / "รอทำ n รายการ" / …).
- Real Model API rates in the cost table: standard $1.25/$4.25,
  contributor $0.10/$0.20 per 1M in/out (was a uniform {1.0, 4.0}
  placeholder, so contributor cost the same as standard).

### Removed

- **SCB tags+insights rail section**, its `/api/chats/:id/ap-context`
  endpoint, `scb-insights.js` and its suite. Sidebar `[APxxxx]`
  chips and title prefixes are untouched.

### Fixed

- **Running todos painted as "waiting"**: the wire sends camelCase
  `inProgress` (97 real stored entries) but the rail/chips matched
  snake_case. Statuses now normalize at the MSP boundary, like tool
  rows already did — and the mock sends the wire-true
  `{ text, inProgress, activeForm? }` shape.
- **Goal chip never lit busy**: the real running state is `active`,
  not `running` (probed against the binary).
- **`Meta/Muse-Spark` fell back to the default rate row**: suffix
  kept its case while lowercase kept the prefix — the matcher now
  also tries the lowercase suffix.

## 1.1.6 — 2026-09-21

Long turns survive like the CLI; no turn ever ends without a trace.
Covered by `npm test` (33 suites green, e2e 55/55).

### Changed

- **Lively turns are never auto-settled by default** (chat 74f04882 ran
  3h09m and the old 65 min default cut it): while the agent process is
  alive and the turn is in flight, the desktop holds like `muse` CLI —
  the stop button is the Ctrl-C. `MUSE_DESKTOP_WATCHDOG_HARD_MS` is now
  an opt-in ceiling (finite ms ≥ 60000); unset/0/false/garbage all hold.
  Non-lively stalls (3 min no-activity / 15 min stall) still settle fast.

### Fixed

- **Settling never blanks a turn** (chat bcb3975b collected two orphan
  user messages with zero replies): no text + no tools + no error now
  persists a stub notice instead of nothing. 'rotated' keeps its own
  recovery notice and stays quiet.
- **Shutdown settles live turns with a trace**: deploy/restart used to
  evaporate in-flight turns silently (user message, no reply, no error).
  The `interrupted` notice names the restart and the stored session id is
  kept, so the next prompt resumes where it left off.

## 1.1.5 — 2026-09-21

Emoji-safe truncation. Covered by `npm test`
(33 suites green, e2e 55/55).

### Fixed

- **Titles, previews, AP titles and notification caps no longer split
  emoji**: `String.slice` counts UTF-16 units and orphaned lone
  surrogates (� in the sidebar/title/banner) when the cut landed
  mid-emoji. All user-visible truncation now goes through the shared
  `cutText`/`cutEllipsis` (`src/server/text.js`).
- Proven NOT a bug: prompt text with quotes, backslashes, newlines, HTML,
  `${}` or emoji round-trips byte-identical end to end (16-payload repro
  against a temp host: stored message + agent wire text all exact).

## 1.1.4 — 2026-09-21

Session identity in the right rail. Covered by `npm test`
(32 suites green, e2e 55/55).

### Fixed

- **Chat summaries expose `mspSessionId`** (live client first, stored copy
  when cold): the id was persisted on disk but never reached the API, so
  the rail could not show it.

### Added

- **Session section** (top of the right rail): Desktop chat ID, MSP agent
  session ID (usable with `muse export`/`trace`/`resume`) and the live
  turn ID, each with a copy button. Cold chats show "ยังไม่ spawn";
  idle chats show no turn.

## 1.1.3 — 2026-09-21

Cost follows the selected model. Covered by `npm test`
(30 suites green, e2e 54/54).

### Fixed

- **Rate table knows the real model ids** (`muse-spark-1.3[-contributor]`,
  `muse-spark-1.2[-contributor]`): previously every model silently fell
  back to the `default` row, so contributor cost exactly the same as
  normal. The rail now also shows which row prices the session ("ใช้เรท").
  Rates stay built-in estimates until pinned via
  `MUSE_DESKTOP_PRICE_JSON` — same estimate for all four ids for now.

## 1.1.2 — 2026-09-21

Group creation lands where its button sits. Covered by `npm test`
(30 suites green, e2e 54/54).

### Changed

- **Creation position follows the button**: the header ▤ drafts at the top
  and lands on top; the bottom "＋ group" tab drafts at the bottom and lands
  at the bottom (`POST /api/groups` takes `position: top|bottom`, default
  top). Previously the draft always sat at the bottom while the group
  always landed on top.

## 1.1.1 — 2026-09-21

Long-session survival, rail resize, and cost hardening. Covered by
`npm test` (30 suites green, e2e 54/54).

### Changed

- **Watchdog holds while any tool is live** (grok-desktop parity): a long
  shell / MCP call no longer trips the 65 min hard cap, so 2h+ sessions are
  never cut mid-tool. The cap still catches a stuck RPC with every tool
  terminal, and `MUSE_DESKTOP_WATCHDOG_HARD_MS=0`/`false` switches it off
  entirely. Holds log one line per minute per turn.
- **Right rail resizes** like the left sidebar: drag gutter, double-click
  reset, arrow keys, persisted width (room guard accounts for the live
  sidebar width).
- **Subagents rail section is counts-only**: running/done/failed/cancelled +
  total — the per-agent list is gone.
- **Progress group header renamed to "Progress Bar"**.
- **Cost never computes on {0,0} rates**: the rail falls back to the
  built-in estimate table while `/api/pricing` loads or when the host is
  too old to serve it (flagged ประมาณการ).

## 1.1.0 — 2026-09-21

Queue-order sidebar, hide-by-default progress, macOS question alerts, and a
right rail (cost · goal/tasks · subagents · SCB). Covered by `npm test`
(29 suites green, e2e 54/54).

### Added

- **Right rail** (Codex Desktop parity, hidden by default): ☰ hamburger in
  the head bar opens cost / goal+tasks / subagents / SCB sections; the
  goal/tasks/agents chips jump straight to their section. Replaces the old
  floating subagents/tasks popovers.
- **Session cost in THB**: cumulative MSP tokens × a static model rate table
  (`GET /api/pricing`, effective date + source shown; pin real rates with
  `MUSE_DESKTOP_PRICE_JSON`, THB/USD with `MUSE_DESKTOP_THB_PER_USD`).
- **SCB project tags + insights**: `[APxxxx]` title prefixes (grok-desktop
  detector, ported) paint as chips in the sidebar, chat title and right
  rail; the rail matches short insights from the scb-search facts DB
  (read-only) for every detected `APxxxx-Project`.
- **macOS alerts for agent questions**: AskUserQuestion / plan / approval
  cards fire a Web Notification plus a host `osascript` banner
  (`POST /api/notify`), once per card — replays never re-alert.

### Changed

- **Queue order**: opening/resuming a session touches it to the top of its
  group (`POST /api/chats/:id/touch`, SSE-broadcast, sync-flushed); new
  groups land on top instead of at the bottom.
- **Progress hides by default** (Codex Desktop parity): tools + plan ride
  inside one collapsed group per turn with live counts; each console keeps
  its own `explain` button; console text is 3:4 of the answer (10.5/14px).
  Streaming never pops rows open; search deep-links open their targets.
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
