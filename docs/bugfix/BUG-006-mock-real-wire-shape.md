# BUG-006 — mock agent ส่ง wire shape ไม่เหมือน CLI จริง (E2E มองไม่เห็นบั๊กระดับ BUG-001/002)

ความรุนแรง: major (test-infra)

## อาการที่ผู้ใช้เห็น

ไม่มีผลต่อผู้ใช้โดยตรง — แต่ E2E ทั้งชุดผ่านสบายทั้งที่ permission card ว่าง
(BUG-001) และ tool row ไม่มี diff (BUG-002) เพราะ mock ส่ง shape ที่ host
เวอร์ชันบั๊กกี้ "รองรับ" อยู่พอดี ทำให้ regression ระดับ CRITICAL รอดการทดสอบ

## สาเหตุ (file:line)

- `scripts/mock-acp-agent.mjs:125-133` (ก่อนแก้) — permission request ใช้
  `toolCall: { title, kind, rawInput: { command } }` + option ids
  `allow-once`/`allow-always`/`reject-once` ซึ่งไม่ตรงกับ CLI จริง
- CLI จริง (`@moonshot-ai/kimi-code` `dist/main.mjs`):
  - `buildPermissionToolCallUpdate` (~341987): toolCall = `{ toolCallId, title,
    content: [diff?, "Requesting approval to <action>"] }` — **ไม่มี rawInput/kind**
  - options มาตรฐาน (~341810-341822): `approve_once` / `approve_always` /
    `reject` (kind: allow_once / allow_always / reject_once)
  - `toolCallStartToSessionUpdate` (~341452): Edit/Write unshift
    `{type:'diff', path, oldText, newText}` เข้า content หน้า text block ที่เป็น
    args stringify
  - `toolResultToSessionUpdate` (~341641): update ปลายทางมี `rawOutput` เสมอ

## อ้างอิง grok-desktop (file:line)

- ไม่มีตรง ๆ — grok-desktop ทดสอบกับ agent จริงผ่านชุด automate; ที่นี่อ้างอิง
  shape จาก CLI จริงโดยตรง (ดูด้านบน) ตามที่ BUG-001/BUG-002 ตรวจไว้

## วิธีแก้ไข

- mock: permission request เปลี่ยนเป็น shape จริง (content text block,
  ไม่มี rawInput/kind, canonical option ids + ชื่อจริง "Approve once" /
  "Approve for this session" / "Reject"); ค่า default เมื่อถูกปฏิเสธเป็น `reject`
- mock: เพิ่ม trigger `"edit"` — tool_call แบบ Edit จริง (rawInput + diff block
  นำหน้า args text) และ update ปลายทางที่มี `rawOutput`; เติม `rawOutput` ให้
  flow `"tool"` เดิมด้วย
- e2e: step permission assert `toolName === 'Bash'`, `summary` ต้องมี
  `rm -rf /tmp/demo`, optionIds ตรง canonical, ตอบด้วย `approve_once` และคำตอบ
  สุดท้ายต้องลง `permission → approve_once`
- e2e: step ใหม่ "an Edit tool_call renders its diff block, then rawOutput on
  completion" — assert แถว tool มี path + บรรทัด `-old`/`+new` และ **ไม่มี**
  args JSON ดิบ จากนั้น output ตอนจบต้องเป็น rawOutput
- ปรับเลขนับ turn_done ของ step ถัด ๆ ไปให้ตรงลำดับใหม่ (step edit แทรกก่อน
  permission)

## ไฟล์ที่เปลี่ยน

- `scripts/mock-acp-agent.mjs` — wire shape จริง + trigger `"edit"` + header comment
- `scripts/e2e-mock-agent.mjs` — step permission ใหม่ + step edit ใหม่

(หมายเหตุ: cancellation แบบ prompt-scoped ของ mock ถูกแก้ไปแล้วใน commit
BUG-003 เพราะ E2E ของ watchdog ต้องใช้)

## การทดสอบ

- `node scripts/e2e-mock-agent.mjs` — 24/24 ผ่าน (24 จาก 23 เพราะ step edit ใหม่)
- ชุดนี้จะ fail ทันทีถ้าย้อน fix BUG-001 (summary ว่าง) หรือ BUG-002
  (ไม่มี diff / rawOutput) — คือจุดประสงค์ของบั๊กนี้
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-006\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
