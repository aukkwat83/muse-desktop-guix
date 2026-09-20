# BUG-002 — tool row ไม่แสดง diff (Edit/Write เห็นแต่ args JSON ดิบ) และ rawOutput ถูกเมิน

ความรุนแรง: CRITICAL

## อาการที่ผู้ใช้เห็น

- แถว tool ของ Edit/Write แสดง JSON args ดิบ (`{"file_path":...,"old_string":...}`)
  แทนที่จะเป็น diff ของการเปลี่ยนแปลง — อ่านไม่รู้เรื่อง
- output จริงของ tool ที่ agent ส่งมาใน `rawOutput` ไม่เคยถูกใช้

## สาเหตุ (file:line)

- `src/server/sessions.js:619` (ก่อนแก้) — record ของ tool ตั้ง
  `output: extractText(update.content)`
- `extractText` (`src/server/sessions.js:30-38` ก่อนแก้) คืน `''` สำหรับ block
  `{type:'diff', path, oldText, newText}` เพราะไม่มี `.text`/`.content`
- CLI จริง unshift diff block ไว้หน้าสุดของ content ในทุก Edit/Write tool_call
  (`displayBlockToAcpContent` + `toolCallStartToSessionUpdate` ใน
  `@moonshot-ai/kimi-code` `dist/main.mjs` บรรทัด ~341241/~341452)
  และ block text ถัดมาคือ args ที่ stringify แล้ว — extractText เจอแต่ block
  หลัง เลยแสดง JSON ดิบ
- `update.rawOutput` ที่ CLI แนบมากับ tool_call_update ตอนจบ
  (`toolResultToSessionUpdate` บรรทัด ~341641: "`rawOutput` preserves the SDK's
  raw output") ไม่มีใครอ่านเลย

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/sessions.js:4809-4831` — `extractToolOutput(update)`
  เช็ค `rawOutput`/`raw_output`/`output`/`result` ก่อนเสมอ แล้วค่อย fallback
  ไปที่ content blocks

## วิธีแก้ไข

- เพิ่ม `extractToolOutput(update)` ใน `src/server/sessions.js` (export):
  1. ถ้ามี `rawOutput`/`raw_output` ที่ไม่ว่าง → ใช้ค่านั้น (ตาม grok)
  2. ถ้า content มี diff block → render ด้วย `formatDiffPreview()`
     (path + บรรทัด `-old`/`+new`, helper เดียวกับที่ BUG-001 เพิ่มใน hosts.js)
     และไม่เอา block text ที่เป็น args JSON มาปน — เป็นข้อมูลเดียวกันในรูปดิบ
  3. นอกนั้นใช้ `extractText(update.content)` เหมือนเดิม
- เปลี่ยนจุดสร้าง record ใน `_onUpdate` จาก `extractText(update.content)`
  เป็น `extractToolOutput(update)` จุดเดียว — ไม่เปลี่ยน semantics อื่น

## ไฟล์ที่เปลี่ยน

- `src/server/sessions.js` — เพิ่ม `extractToolOutput()` + import
  `formatDiffPreview` จาก `./hosts.js` + ใช้ใน tool_call/tool_call_update branch
- `scripts/unit-test-turn-core.mjs` — เพิ่ม 2 tests:
  rawOutput ชนะ content, Edit-shaped tool_call ที่มี diff block

## การทดสอบ

- `node scripts/unit-test-turn-core.mjs` — 18/18 ผ่าน (รวม 2 tests ใหม่)
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-002\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
