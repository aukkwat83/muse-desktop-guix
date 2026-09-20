# BUG-003 — watchdog ตัดเทิร์นที่ยังมีชีวิตอยู่ (ไม่มี liveness guard / ไม่แช่แข็งตอนรอคนกด)

ความรุนแรง: CRITICAL

## อาการที่ผู้ใช้เห็น

- tool ที่รันเงียบ ๆ นานกว่า 15 นาที (build ที่ไม่พิมพ์อะไรเลย ฯลฯ) โดนตัดด้วย
  `turn_error` ทั้งที่ agent ยังทำงานอยู่ — เมื่อ `session/prompt` จริงตอบกลับมา
  ทีหลัง `settleTurn` คืน false และคำตอบหายไปเฉย ๆ
- หลังโดนตัด `slot.turn` เป็น null จึงกด prompt ใหม่ได้ ทั้งที่ RPC เดิมยังค้าง —
  เกิด `session/prompt` สองอันซ้อนกันบน ACP session เดียวกัน
- การ์ดขออนุญาตที่ค้างไว้รอคนกด ทำให้ stall clock เดินต่อ จน watchdog เผลอตัด
  เทิร์นที่แค่รอมนุษย์

## สาเหตุ (file:line)

- `src/server/sessions.js:520-538` (ก่อนแก้) — `_checkWatchdog` ตัดเทิร์นด้วย
  reason `'watchdog'` เมื่อไม่มี activity เกิน 180s หรือสตรีมเงียบเกิน 900s
  **โดยไม่เงื่อนไข** — ไม่เช็คว่า process ยังอยู่และ `session/prompt` ยัง in-flight
- `src/server/sessions.js:636-658` (ก่อนแก้) — `_touch` เฉพาะ kind
  chunk/tool/plan; update kind อื่น (thought, unknown) ไม่นับเป็น activity
- kimi ใช้ `timeoutMs: 0` กับ session/prompt (`src/server/acp-client.js:539-543`)
  จึงสังเกต in-flight ได้จาก `client._pending` เหมือน grok พอดี

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/sessions.js:1149-1196` — tick ของ watchdog:
  แช่แข็ง stall clock เมื่อมี `slot.pendingInteraction` (:1163-1166) และข้าม
  settle ทั้งหมดขณะ `_clientLively(slot)` (:1170-1174)
- `grok-desktop/src/server/sessions.js:1444-1460` — `_clientLively`: process
  มีชีวิต AND (`_pending` มี method `session/prompt` OR `status==='running'`)
- `grok-desktop/src/server/sessions.js:1427-1433` — hard cap 65 นาที
  (`watchdogHardMs`) เป็นตัวกันสุดท้ายสำหรับ RPC ที่ค้างจริง

## วิธีแก้ไข

ใน `src/server/sessions.js`:

- เพิ่ม `_clientLively(slot)` — `isClientAlive(client)` (import จาก
  acp-client.js) + มี `session/prompt` ใน `client._pending` หรือ
  `client.status === 'running'`
- `_checkWatchdog` ใหม่:
  1. ถ้ามี pending interaction ของ chat นี้ → แช่แข็งนาฬิกา
     (rearm lastActivity/startedAt) แล้ว return
  2. ถ้า client ยัง lively → ไม่ตัด; ยกเว้นเงียบเกิน `WATCHDOG_HARD_MS`
     (default 65 นาที, env `KIMI_DESKTOP_WATCHDOG_HARD_MS`) จึงตัดด้วย
     ข้อความ hard cap
  3. นอกนั้นใช้เกณฑ์ no-activity/stall เดิม
- `_onUpdate` เรียก `_touch` ทุก kind (ย้ายไปไว้บนสุดของฟังก์ชัน) —
  frame ใด ๆ จาก agent คือสัญญาณมีชีวิต
- tick interval อ่านจาก env `KIMI_DESKTOP_WATCHDOG_TICK_MS` (default 15s)
  เพื่อให้ E2E ใช้นาฬิกาเร็วได้ (เดิม hardcode 15s)

ใน `scripts/mock-acp-agent.mjs` (จำเป็นสำหรับ E2E ให้พิสูจน์ได้จริง):

- เพิ่มพฤติกรรม `"hang"` — เงียบสนิท ค้าง session/prompt ไว้จนกว่าจะโดน cancel
- แก้ cancellation ให้เป็น prompt-scoped (`cancelledPromptId`/`activePromptId`)
  แทน flag กลาง: เดิม prompt ใหม่ reset flag ทำให้ลูป 'slow' ที่โดน cancel ไปแล้ว
  หลุดมาสตรีม chunk เข้าเทิร์นถัดไป — negative control จึงเคยผ่านทั้งที่ไม่มี guard
  (เทิร์น hang มี activity ปลอม)

## ไฟล์ที่เปลี่ยน

- `src/server/sessions.js` — liveness guard + freeze + hard cap + touch ทุก kind
- `scripts/mock-acp-agent.mjs` — `"hang"` + cancellation แบบ prompt-scoped
- `scripts/e2e-mock-agent.mjs` — env นาฬิกาทดสอบ + step ใหม่ที่ assert ด้วย
  turnId ตัวเอง (กัน vacuous pass จาก event เก่าค้างใน list)
- `scripts/unit-test-turn-core.mjs` — +4 tests: lively ไม่ตัด, hard cap ตัด,
  permission card แช่แข็งนาฬิกา, ทุก kind นับเป็น activity

## การทดสอบ

- `node scripts/unit-test-turn-core.mjs` — 22/22 ผ่าน
- `node scripts/e2e-mock-agent.mjs` — 23/23 ผ่าน (step ใหม่: เทิร์นเงียบเกิน
  threshold แต่ prompt ยัง in-flight ต้องไม่โดนตัด)
- Negative control: ปิด `_clientLively` ชั่วคราว → step เดียวกัน FAIL ตามคาด
  (ตัดที่ ~1.6s ด้วย turn_error) — ยืนยันว่า E2E จับ regression ได้จริง
- `npm test` — เขียวทั้ง 8 suites

## วิธี revert

```
git log --grep='\[BUG-003\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
