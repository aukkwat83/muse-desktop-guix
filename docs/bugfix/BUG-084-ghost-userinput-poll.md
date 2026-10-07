# BUG-084 — เทิร์นค้างตลอดกาลบน request_user_input ที่ live frame มาไม่ถึง

ความรุนแรง: major (wedged turn — spinner ไม่จบ, ต้องกด Stop เอง, เกิดซ้ำ)

## อาการที่ผู้ใช้เห็น

แชทถามคำถามแล้วเงียบไปเลย ไม่มีอะไรกลับมา — spinner หมุนค้างเป็นชั่วโมง
(chat f381a7e1 ค้าง 2 ชม. บนคำถาม 2 ข้อ UseCase/Platform; repro chat
ยืนยันอาการเดียวกัน) host.log มีแต่ `sticky-hold … lively=true` ทุกนาที
ไม่มีการ์ดคำถาม ไม่มีการแจ้งเตือน ไม่มี error

## หลักฐาน (2026-10-01)

- session log ของ agent (`01a0f5cc…`) จบที่ `user_input_prompt_requested`
  (multi-question `request_user_input`) แล้วไม่มี record ต่อ — agent
  จอดรอคำตอบ
- `command_intake` มีแค่ `session_start` + `turn_queue_submit` — desktop
  ไม่เคยส่ง `userInput/answer` หรือ `userInput/cancel`
- `chats.json` ของแชทนั้นมีแค่ 1 user message — ไม่มี trace
  `msp:user_input_unsupported`, ไม่มี pendingInteraction
- repro สดกับ binary จริง (1.4.2): prompt บังคับ 2 คำถาม → tool
  `request_user_input` ค้าง `in_progress`, interactions ว่าง, เทิร์นเข้า
  lively-hold — ได้ wedge เดียวกัน 100%
- mock เดิมพิสูจน์แค่ "trace โผล่บน SSE" — branch `quizmulti` ไม่ได้ block
  รอ cancel จริง (`userInput/cancel` handler ตอบ `{}` แล้วทิ้ง ไม่ resolve
  waiter) เลยไม่เคยจับ wedge นี้ได้

## สาเหตุ

สาเหตุจริง (เจอจาก `diag` บรรทัดแรกหลัง deploy 1.1.15): **`userInput/cancel`
ที่ desktop ส่งถูก binary 1.4.2 reject ทุกครั้ง — `Invalid params: missing
field 'reason'`** ทั้งที่ schema export บอกว่า `reason` เป็น optional
(schema/reality mismatch) — live frame มาถึงปกติ แต่ cancel ตายตั้งแต่
RPC แรก และความเงียบ 3 ชั้นทำให้ไม่มีใครรู้:

1. **cancel ล้มแบบเงียบ** — `userInput/cancel` ทุกจุดลง `.catch(() => {})`
   (host.log เงียบ, UI เงียบ) — นี่คือชั้นที่ซ่อน root cause มานาน
2. **ไม่มี recovery** — ไม่มีโค้ด re-check ว่า cancel landing หรือไม่;
   agent รอตลอดไป ขณะที่ watchdog เห็น agent ยัง alive เลย hold ตลอดไป
   (design 1.1.6) = wedge ถาวร
3. **trace หายเมื่อ reload** — `msp:user_input_unsupported` ส่งแค่ SSE
   (`agent_update_other` ซึ่ง renderer ไม่มี case รองรับ = มองไม่เห็น
   แม้ตอนมัน fire) ไม่ persist ลง transcript
4. **cancel path ไม่ dedupe** — request + notification คู่กันยิง cancel
   ซ้ำ 2 RPC + notice ซ้ำ 2 ข้อความ (waiter มีแค่ card path)

## วิธีแก้ไข

- `src/server/msp-client.js` — **`userInput/cancel` ทุกจุดส่ง `reason`**
  (root cause: binary 1.4.2 reject ที่ไม่มี reason), cancel path dedupe
  ผ่าน `_cancelledIds` (request + notification = 1 RPC + 1 notice),
  `listPending()` (pull dual ของ push frames), `recoverUserInput()`
  (mount-or-cancel รวมทาง live + poll), `recoverApproval()`,
  `interrupt()` (ยิง turn/interrupt โดยไม่แตะ waiter),
  cancel/answer/decide ล้ม → `stderr` (ดัง) สำเร็จ → `diag` (log อย่างเดียว,
  ไม่ spam UI), rx frame ทุก interactive event ลง `diag`
- `src/server/sessions.js` — watchdog poll `approval/listPending` เมื่อ lively
  แต่เงียบเกิน `MUSE_DESKTOP_PENDING_POLL_MS` (default 45s): mount การ์ดที่
  แสดงได้, auto-cancel ทรงที่แสดงไม่ได้ + persist notice ภาษาไทย,
  cancel แล้วยัง pending เกิน `MUSE_DESKTOP_CANCEL_GRACE_MS` (default 30s)
  → interrupt run + settle ดัง (`request_user_input` อยู่ใน error) +
  release host (prompt หน้าบูตใหม่) — wedge ยาวสุด ~75s ไม่มีค้างตลอดกาล
- `src/server/hosts.js` — `classifyPendingUserInputs()` pure helper
  (mount/cancel/escalate) + unit tests
- `scripts/mock-msp-agent.mjs` — `approval/listPending` handler,
  `userInput/cancel` resolve waiter ตาม schema (wire-true),
  branch `ghostquiz` (multi เงียบ, cancel แล้วหาย) และ `stubbornquiz`
  (multi เงียบ, กลืน cancel — ต้อง escalate)
- `scripts/e2e-mock-agent.mjs` — 2 steps ใหม่ + แปลง long-answer assertion
  จากนับ `turn_done` เป็น match turnId (กันเลขวิ่งเมื่อเพิ่ม step)
- `scripts/unit-test-msp-client.mjs` — recover/listPending/interrupt/loud-cancel

## ไฟล์ที่เปลี่ยน

- `src/server/msp-client.js`, `src/server/sessions.js`, `src/server/hosts.js`
- `scripts/mock-msp-agent.mjs`, `scripts/e2e-mock-agent.mjs`
- `scripts/unit-test-msp-client.mjs`, `scripts/unit-test-permission-host.mjs`
- `docs/bugfix/BUG-084-ghost-userinput-poll.md`, `CHANGELOG.md`
- `package.json` + `src/renderer/index.html` (?v= 1.1.14→1.1.15)

## Verify

- `npm test` เขียวทั้งหมด (e2e 61/61 รวม 2 steps ใหม่)
- 2 steps ใหม่ FAIL บนโค้ดเก่า (stash src แล้วรัน — ghost timeout)
- live repro บน binary จริงรอบแรก (1.1.15 ยังไม่มี reason): poll/escalate
  ทำงานตาม design (interrupt + settle ดังใน ~75s) และ `diag` เผยสาเหตุจริง
  (`missing field 'reason'`) — จากนั้นเติม reason + dedupe + mock enforce
- live repro รอบสอง (มี reason): cancel สำเร็จ → เทิร์นจบปกติ
  (รอ deploy รอบสอง + restart host)
