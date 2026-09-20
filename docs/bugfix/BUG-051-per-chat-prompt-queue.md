# BUG-051 — ไม่มีคิว prompt ต่อแชท: Enter กลางเทิร์นถูกกลืน / 409 กลายเป็น error

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

พิมพ์คำถามถัดไปขณะที่เทิร์นกำลังรัน แล้วกด Enter — ไม่มีอะไรเกิดขึ้นเลย
(ข้อความค้างใน composer เฉย ๆ เหมือนปุ่มตาย) หรือถ้าส่งผ่าน path อื่นจะเจอ
ข้อความผิดพลาด "ยังมีเทิร์นค้างอยู่" ทั้งที่ควรเข้าคิวรอส่งอัตโนมัติ

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้):
  - keydown Enter (:1149-1154) — `if (!isRunning(...)) void submitPrompt()`
    → Enter กลางเทิร์นถูก swallow
  - `submitPrompt()` (:1144-1156) — ไม่มีคิว; 409 จาก server แสดงเป็น error
    line แล้วคืนข้อความเข้า composer

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/prompt-queue.js:37-196` — `createPromptQueue()`
  (FIFO ต่อ chatId, in-memory) + `shouldDispatch(phase, len)` (dispatch เฉพาะ
  phase ที่ settle แล้ว)
- `grok-desktop/src/renderer/app.js:7282-7289` — enqueue-on-busy ใน submit
- `grok-desktop/src/renderer/app.js:6997-7050` — chip "⏳ รอส่ง N ข้อความ"
  + รายการพร้อม ✕ ลบทีละรายการ; markup ที่ `index.html:339-348`
- `grok-desktop/src/renderer/app.js:7059-7089` — `scheduleQueueDispatch()`
  (setTimeout 0 — macrotask ไม่ใช่ microtask, comment R14b :7052-7056)
  + `maybeDispatchQueue()` มี guard `queueDispatching` ทีละ 1 POST ต่อ chat
- `grok-desktop/src/renderer/app.js:7184-7191` — 409 จาก queue dispatch →
  `requeueFront()` คืนหัวคิว (ไม่สูญหาย ไม่สลับลำดับ)

## วิธีแก้ไข

- `src/renderer/prompt-queue.js` (ใหม่, pure) — พอร์ตเกือบ verbatim;
  kimi ไม่มี `view.phase` จึง derive `'running' | 'idle'` จาก `isRunning()`
  ตอนเรียก shouldDispatch (คอมเมนต์ใน app.js อธิบายไว้)
- `src/renderer/app.js`:
  - `submitPrompt()` — ล้าง composer + draft แล้ว ถ้า `isRunning(chatId)` →
    `promptQueue.enqueue()` + อัปเดต chip; ไม่งั้นส่งผ่าน `sendPromptText()`
  - `sendPromptText(chatId, text, {queueItem})` — funnel เดียวของ
    POST /prompt (คงกฎ 202-and-SSE-only: response ไม่ paint อะไร); 409 →
    `requeueFront` (ทั้ง direct submit และ queue dispatch); error จริงของ
    direct submit คืนข้อความเข้า composer เหมือนเดิม, ของ queue เก็บกลับหัวคิว
  - `turn_done`/`turn_error` — แชทที่กำลังดู: dispatch หลัง settle paint เสร็จ
    (`selectChat(...).finally(scheduleQueueDispatch)`) เพื่อไม่ให้ turn_started
    ของ prompt ถัดไปชน refetch; แชทพื้นหลัง: schedule ได้ทันที
  - Enter keydown เรียก submitPrompt เสมอ (ปุ่ม send ยังเป็น Stop morph ตอนรัน)
  - chip "⏳ รอส่ง N ข้อความ" เหนือ composer (index.html + style.css,
    token `--muted` บน `--panel`/`--panel-2` ที่ผ่าน contrast audit แล้ว),
    คลิกขยายรายการพร้อม ✕ ลบทีละรายการ; `selectChat()` อัปเดต chip ตามแชท;
    `deleteChat()` ล้างคิวของแชทนั้น

## ไฟล์ที่เปลี่ยน

- `src/renderer/prompt-queue.js` — โมดูล pure ใหม่
- `src/renderer/app.js` — queue wiring, submitPrompt/sendPromptText, settle
  dispatch, chip render
- `src/renderer/index.html` — markup chip + bump `?v=` 0.4.29 → 0.4.30
- `src/renderer/style.css` — .prompt-queue*
- `scripts/unit-test-prompt-queue.mjs` — suite ใหม่ (8 เคส)
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite prompt-queue
- `scripts/e2e-mock-agent.mjs` — เคส queue contract (409 กลางเทิร์น, ส่งตาม
  ลำดับหลัง settle, user message หนึ่งเดียวต่อข้อความ)

## การทดสอบ

- unit (`prompt-queue`): FIFO ต่อแชท, trim/reject ว่าง, peek ไม่ consume,
  removeAt ทำความสะอาด bucket, requeueFront คืนหัวคิวพร้อม identity เดิม,
  clear/clearAll, shouldDispatch เฉพาะ settled+non-empty
- e2e (เคสใหม่, turn-timing): prompt กลางเทิร์น → 409 ทั้งสอง; หลัง settle
  POST ผ่าน 202; ข้อความที่สองรอจนกว่าข้อแรกจบ (ลำดับคิว); transcript มี user
  message หนึ่งเดียวต่อ prompt และ assistant turn หนึ่งเดียวต่อ turnId
- `npm test` เขียวทุก suite (13 suites: unit 12 + e2e 38/38)

## วิธี revert

```
git log --grep='\[BUG-051\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
