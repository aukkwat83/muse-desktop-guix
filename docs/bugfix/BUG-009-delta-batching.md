# BUG-009 — ทุก token chunk กลายเป็น SSE frame ของตัวเอง (ไม่มี delta batching)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

คำตอบยาว ๆ ที่สตรีมหลายพัน chunk ทำ host เปลือง CPU (serialize + write ทุก
chunk) และ — ร้ายกว่า — frame เดลต้าไหลเข้า replay ring ขนาด 2000 จน event
สำคัญก่อนหน้า (เช่น `turn_started` ของเทิร์นอื่น) ถูก evict หมด ทำ client ที่
reconnect พลาด event เหล่านั้น

## สาเหตุ (file:line)

- `src/server/sessions.js` `_onUpdate` (ก่อนแก้) — case
  `agent_message_chunk`/`agent_thought_chunk` เรียก `wire.emit` ทุก chunk
  1 RPC frame = 1 SSE frame ตรง ๆ ไม่มีการ batch

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/sessions.js:3140-3183` — batch `assistant_delta`
  ด้วย `DELTA_FLUSH_MS = 16` / `DELTA_FLUSH_CHARS = 768`: สะสม buffer แล้ว
  flush ด้วย timer 16ms หรือทันทีเมื่อ buffer ≥ 768 ตัวอักษร
- `grok-desktop/AGENTS.md` ("Long streams, v0.3.4+") — deltas may be batched;
  UI ใช้ Text node เดียว ไม่ rewrite DOM ต่อ token

## วิธีแก้ไข

- เพิ่ม `DELTA_FLUSH_MS` (default 16) / `DELTA_FLUSH_CHARS` (default 768) ปรับได้ผ่าน
  env `KIMI_DESKTOP_DELTA_FLUSH_MS` / `KIMI_DESKTOP_DELTA_FLUSH_CHARS`
  (`0` = flush ทุก chunk เหมือนเดิม)
- `SessionManager._queueDelta()` สะสม delta ต่อ chat แยก `message`/`thought`;
  frame ที่ออกไปแบก `text` เป็น running-total ณ ตอน queue — renderer เชื่อ
  `data.text` อยู่แล้ว (app.js:436) batching จึงไม่เสียข้อมูล
- `_flushDelta()` ถูกเรียกจาก timer / threshold และ **จาก `settleTurn` ก่อน
  emit terminal frame เสมอ** — ข้อความที่ค้างใน buffer ต้องลงก่อน
  `turn_done`/`turn_error` เสมอ ห้ามลงหลัง
- chunk ที่มาตอนไม่มี live turn ยัง emit ทันทีเหมือนเดิม (ไม่มี turn ให้ batch)

## ไฟล์ที่เปลี่ยน

- `src/server/sessions.js` — constants + `_queueDelta`/`_flushDelta` + flush ใน
  `settleTurn` + batching ใน `_onUpdate` ทั้ง `agent_message_chunk` และ
  `agent_thought_chunk`
- `scripts/unit-test-turn-core.mjs` — ปรับ test running-total เดิมให้รอ flush
  window + 2 tests ใหม่ (flush ตาม threshold, settle flush ก่อน terminal)
- `scripts/mock-acp-agent.mjs` — trigger `"long"`: 120 chunks แบบ burst
  (ไม่มี await) + final content ที่ประกอบจาก stream ทั้งหมด
- `scripts/e2e-mock-agent.mjs` — host env `KIMI_DESKTOP_DELTA_FLUSH_MS=2`
  (test clock ตาม pattern BUG-003) + E2E case: คำตอบยาว 120 chunks ได้
  `turn_done` ครั้งเดียว, frame เดลต้าน้อยกว่า chunk มาก, content ครบทุกตัวอักษร

## การทดสอบ

- `node scripts/unit-test-turn-core.mjs` — 31/31 ผ่าน
- `node scripts/e2e-mock-agent.mjs` — 25/25 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-009\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
