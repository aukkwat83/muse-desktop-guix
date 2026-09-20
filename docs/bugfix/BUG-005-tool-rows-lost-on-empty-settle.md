# BUG-005 — กิจกรรม tool หายไปเมื่อเทิร์นจบโดยไม่มีข้อความ assistant

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

กด cancel หลัง tool รันเสร็จแต่ก่อน agent เริ่มพิมพ์คำตอบ — ตอนดูสดเห็นแถว tool
อยู่ แต่พอ reload transcript กลับมาเห็นแค่ข้อความของผู้ใช้ แถว tool หายหมด
(เทิร์นดูเหมือนไม่เคยทำอะไรเลย)

## สาเหตุ (file:line)

- `src/server/sessions.js` `settleTurn` (ก่อนแก้ บรรทัด ~527-542) — persist
  `toolCalls` เฉพาะผ่าน `setAssistantMessage` ซึ่งถูกเรียกเฉพาะเมื่อ
  `finalText` ไม่ว่างเท่านั้น; เทิร์นที่จบโดยไม่มีข้อความ (cancel ก่อน agent
  พิมพ์) จึงไม่ persist อะไรเลย — มีแค่ notice กรณี error เท่านั้น

## อ้างอิง grok-desktop (file:line)

- กฎใน `grok-desktop/AGENTS.md` ("Tool stdout (from v0.3.2+): must surface in
  the bottom result; **never blank a turn after tools ran**") — และพฤติกรรมใน
  `grok-desktop/src/server/sessions.js:1253-1261` ที่ settle activity items
  เสมอไม่ว่า turn จะมี text หรือไม่

## วิธีแก้ไข

- ใน `settleTurn` แยกกรณี `finalText` ว่างออกเป็น else block: ถ้า
  `turn.toolCalls.size > 0` ให้ persist assistant message ที่ text ว่างแต่แนบ
  `toolCalls` (และ plan ถ้ามี) — renderer `messageNode`
  (`src/renderer/app.js:145-170`) render แถว tool จาก `meta.toolCalls` อยู่แล้ว
  และ `.msg-assistant` ว่างไม่มีกรอบ/พื้นหลัง (`style.css:867-870`)
  จึงมองไม่เห็นฟองว่าง — ไม่ต้องแตะ renderer
- notice แจ้งเทิร์นล้มเหลว (`เทิร์นจบแบบไม่สำเร็จ: …`) ยังถูกเพิ่มต่อท้ายเหมือนเดิม
  เมื่อมี error — ทั้งแถว tool และ notice อยู่ครบใน transcript
- สถานะ tool ที่ค้างถูก normalize ก่อนหน้านั้นแล้วโดย BUG-004 ใน funnel เดียวกัน

## ไฟล์ที่เปลี่ยน

- `src/server/sessions.js` — โครง if/else ใน `settleTurn` ให้ persist toolCalls
  เมื่อไม่มี text แต่มี tool; notice ยังทำงานในทุกกรณีที่มี error
- `scripts/unit-test-turn-core.mjs` — +3 tests: cancel หลัง tool จบโดยไม่มี text
  แล้ว tool rows อยู่ครบ, error+tools+no-text ได้ทั้ง rows และ notice,
  เทิร์นว่างจริง (no text/tools/error) ยังไม่ persist อะไรเหมือนเดิม

## การทดสอบ

- `node scripts/unit-test-turn-core.mjs` — 27/27 ผ่าน
- `node scripts/e2e-mock-agent.mjs` — 23/23 ผ่าน (funnel เดิมไม่พัง)
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-005\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
