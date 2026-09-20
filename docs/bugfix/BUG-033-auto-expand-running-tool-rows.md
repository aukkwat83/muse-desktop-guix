# BUG-033 — แถว tool ที่กำลังรันพับมิดอยู่ตลอด ไม่เห็น output จนกว่าจะคลิก

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ขณะ tool กำลังทำงาน (โดยเฉพาะ Bash/execute ที่ output ไหลเรื่อย ๆ) แถว tool
พับมิดตลอด — ผู้ใช้ไม่เห็นว่าเกิดอะไรขึ้นจนกว่าจะคลิกเปิดเองทีละแถว

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) — `toolNode()` สร้างแถวด้วย
  `class 'tool-row collapsed'` เสมอ และไม่มีโค้ดไหนเปิดให้ — ทั้ง live path
  (`paintLiveTurn`) และ history path เหมือนกันหมด

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:3514-3550` — `paintToolOutput()`
  auto-expand แถว bash/execute/running ขณะสตรีม (`body.hidden = false`,
  `dataset.autoExpand`)
- `grok-desktop/src/renderer/app.js:2764-2798` — `fillToolRowBody()` เติม
  output ลง body ที่เปิดอยู่

## วิธีแก้ไข

- `src/renderer/turn-view.js` —
  - `createTurnView()` เพิ่ม `userToggledTools: Set` (ต่อ tool id, ต่อเทิร์น)
  - pure helper `shouldAutoExpandTool(tv, tool)`: เปิดถ้า status เป็น
    in_progress/running หรือ kind เป็น execute/bash/shell/command —
    **ยกเว้น**แถวที่ผู้ใช้ toggle เองในเทิร์นนี้ (manual collapse ชนะเสมอ)
- `src/renderer/app.js` —
  - `toolNode(tool, existing, onUserToggle)`: click ที่หัวแถวเรียก
    `setToolRowCollapsed()` (จุดเดียวที่เปลี่ยน class + glyph ▸/▾ ให้ตรงกัน)
    แล้วแจ้ง callback; live path ส่ง callback ที่บันทึก id ลง
    `userToggledTools` ของ turn view แชทที่กำลังดู; history path ไม่ส่ง —
    แถว history พับเหมือนเดิม
  - `paintLiveTurn()` upsert loop: `shouldAutoExpandTool(tv, tool)` เป็น
    true → `setToolRowCollapsed(node, false)` ทุก paint (idempotent; ผู้ใช้
    พับเองแล้วจะไม่ถูกเปิดคืนเพราะ guard)
  - `turn_started` reset `tv.userToggledTools` พร้อม field อื่น — การพับเอง
    ของเทิร์นก่อนไม่รั่วมาเทิร์นนี้

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `userToggledTools` + `shouldAutoExpandTool()`
- `src/renderer/app.js` — onUserToggle + auto-expand ใน paintLiveTurn +
  reset ตอน turn_started; import token `turn-view.js` 0.4.15 → 0.4.16
- `src/renderer/index.html` — bump `?v=` 0.4.19 → 0.4.20
- `scripts/unit-test-turn-view.mjs` — เคส helper + guard

## การทดสอบ

- unit (`turn-view`): running/in_progress → เปิด; kind execute/bash pending
  → เปิด; read ที่ pending → พับ; terminal status → ไม่เปิดเอง;
  user-toggled → ไม่ถูกเปิดคืน และไม่กระทบแถวอื่น/เทิร์นถัดไป
- `npm test` เขียวทุก suite (การขยาย DOM จริงทดสอบไม่ได้ใน harness —
  เงื่อนไขถูก unit-test ครบ; ไม่แตะ turn timing)

## วิธี revert

```
git log --grep='\[BUG-033\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
