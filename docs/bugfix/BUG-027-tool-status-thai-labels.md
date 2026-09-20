# BUG-027 — แถว tool พิมพ์สถานะ protocol ดิบ ๆ ("in_progress") ใน UI ภาษาไทย

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

แถว tool ใน transcript แสดงสถานะเป็นสตริง protocol ตรง ๆ — "in_progress",
"completed" — ทั้งที่ UI ทั้งแอปเป็นภาษาไทย และไม่มีสัญลักษณ์ใด ๆ บอกว่า tool
กำลังรันอยู่ (ต้องรออ่านสถานะอย่างเดียว)

## สาเหตุ (file:line)

- `src/renderer/app.js:208` (ก่อนแก้) — `toolNode()` ใส่ `tool.status`
  ลง `.status` ตรง ๆ โดยไม่ผ่าน mapping; CSS class สีสำหรับ
  failed/completed มีอยู่แล้ว (`style.css:1016-1027`) แต่ไม่มี label ที่
  อ่านรู้เรื่องและไม่มี spinner

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:2916-2923` — map สถานะเป็น label ที่อ่าน
  ออก (Pending/Running/Done/Stopped/Failed)
- `grok-desktop/src/renderer/app.js:2732-2756` — `setToolRowGlyph()` ใส่
  CSS spinner ให้แถวที่กำลังรัน

## วิธีแก้ไข

- `src/renderer/turn-view.js` — เพิ่ม pure helper `toolStatusLabel(status)`:
  pending→รอดำเนินการ, in_progress/running→กำลังทำงาน, completed→เสร็จแล้ว,
  failed→ล้มเหลว, cancelled→ถูกยกเลิก (case-insensitive ตามการ flip ของ
  settleTurn); สถานะที่ไม่รู้จักส่งผ่านตรง ๆ — ห้ามเรนเดอร์ว่าง
- `src/renderer/app.js` — `toolNode()` ใช้ `toolStatusLabel()` และเพิ่ม
  `<span class="tool-spin">` ในหัวแถว
- `src/renderer/style.css` — spinner CSS เล็ก ๆ ที่แสดงเฉพาะเมื่อ
  `data-status` เป็น pending/in_progress/running (หมุนด้วย
  `@keyframes tool-spin`; `@media (prefers-reduced-motion: reduce)` ปิด
  animation) — ใช้ token สีเดิม (`--line-soft`/`--accent-text`) ไม่เพิ่ม pair

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `toolStatusLabel()`
- `src/renderer/app.js` — toolNode ใช้ label + spinner span; import token
  `turn-view.js` 0.4.10 → 0.4.11
- `src/renderer/style.css` — spinner + keyframes + reduced-motion guard
- `src/renderer/index.html` — bump `?v=` 0.4.13 → 0.4.14
- `scripts/unit-test-turn-view.mjs` — เคส mapping

## การทดสอบ

- unit (`turn-view`): mapping ครบทุกสถานะ + case-insensitive + unknown ผ่าน
  ตรง + undefined → ว่าง
- `npm test` เขียวทุก suite (ไม่แตะ turn timing จึงไม่เพิ่ม e2e; การแสดงผล
  spinner เป็น DOM/CSS ที่ harness ไม่มี browser ให้ทดสอบ)

## วิธี revert

```
git log --grep='\[BUG-027\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
