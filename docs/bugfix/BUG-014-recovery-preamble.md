# BUG-014 — agent session ใหม่หลัง rotation เริ่มจากศูนย์ (ไม่มี recovery preamble)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

หลัง agent เดิมตอบ load_miss (resume ไม่สำเร็จ) หรือหลัง rotation ของ BUG-012
prompt ถัดไปไปหา agent ที่ **จำบริบทเดิมไม่ได้เลย** — agent เริ่มทำงานซ้ำตั้งแต่
ต้น ทั้งที่ transcript ฝั่ง desktop มีทุกอย่างอยู่แล้ว

## สาเหตุ (file:line)

- `src/server/sessions.js` `load_miss` handler (ก่อนแก้) — ล้าง
  `acpSessionId` + โพสต์ notice ไทย แล้วจบ; prompt ถัดไปเปิด `session/new`
  โดยไม่แนบบริบทอะไรเลย
- rotation ของ BUG-012 ก็ stash เฉพาะ flag ไว้ ยังไม่มีโค้ด consume

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/turn-recovery.js:221-304` — `buildRecoveryPreamble`
  สร้าง `[SESSION RECOVERY]` recap (user/assistant ล่าสุด + เหตุ rotation)
  และ `expandRotatedPrompt` แนบ preamble เข้ากับ **wire text เท่านั้น** —
  user message ที่ store ไว้ยังเป็นข้อความดิบ
- `grok-desktop/src/server/turn-recovery.js:309` เป็นต้นไป — heal preamble ที่
  รั่วลง transcript ตอน restore

## วิธีแก้ไข

- `_rotated` map (chatId → {reason, message}) ถูก set ทั้งจาก `load_miss`
  handler และจาก rotation branch ของ BUG-012
- `SessionManager._buildRecoveryWireText(chatId, body, excludeMessageId)`:
  ถ้ามี flag → ประกอบ preamble แบบ lean (marker + เหตุ + "user message ล่าสุด"
  + "assistant output ล่าสุด" ตัดที่ 4,000 ตัวอักษรต่อ section) แล้วต่อท้าย
  ด้วย body; consume flag ทันที (ยิงครั้งเดียว). ไม่มี flag → คืน body เดิม
- `prompt()` ส่ง `wireText` เข้า `client.prompt()` แต่ store user message เป็น
  body ดิบเหมือนเดิม; `excludeMessageId` กัน recap อ้าง prompt ที่เพิ่ง store
  ไปเอง (recap ควรอ้าง exchange ก่อนหน้า)
- mock agent: trigger words เปลี่ยนเป็น word-boundary (`\bword\b`) — preamble
  มีคำว่า "task" ซึ่งเคยไป trigger `includes('ask')` จน retry ค้างบนการ์ด
  permission ผี (regression ที่เจอระหว่างทดสอบ bug นี้เอง); เพิ่ม
  `MOCK_ACP_PROMPT_LOG` บันทึก raw wire text ทุก prompt เป็น JSONL ให้ e2e
  ตรวจ preamble ได้

## ไฟล์ที่เปลี่ยน

- `src/server/sessions.js` — `RECOVERY_MAX_CHARS`, `_buildRecoveryWireText`,
  `prompt()` ใช้ wireText, `load_miss` handler stash `_rotated`
- `scripts/mock-acp-agent.mjs` — word-boundary triggers + `MOCK_ACP_PROMPT_LOG`
- `scripts/unit-test-turn-core.mjs` — +2 tests: preamble ครบถ้วนและยิงครั้งเดียว;
  trim context เกินขนาด + ข้าม prompt ที่เพิ่ง store
- `scripts/e2e-mock-agent.mjs` — env prompt log + E2E case: retry หลัง rotation
  เปิดด้วย `[SESSION RECOVERY` มีเหตุ + recap ผู้ใช้/assistant + user text ต่อ
  ท้าย; prompt ถัดไปออกไปแบบดิบ (ยิงครั้งเดียว)

## การทดสอบ

- `node scripts/unit-test-turn-core.mjs` — 34/34 ผ่าน
- `node scripts/e2e-mock-agent.mjs` — 28/28 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-014\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
