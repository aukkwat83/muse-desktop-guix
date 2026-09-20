# BUG-036 — ตารางกว้างล้นคอลัมน์ transcript

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

assistant ตอบเป็นตารางที่มีหลายคอลัมน์/ข้อความยาว → ตารางดันกว้างเกินคอลัมน์
แชท ทั้งข้อความก้อนอื่นต้องเลื่อนตามหรือ layout แตก อ่านยาก

## สาเหตุ (file:line)

- `src/renderer/style.css` (ก่อนแก้) :933-937 — `.msg-assistant table
  { width:100% }` เปล่า ๆ ไม่มี wrapper; `.msg-assistant` เอง (:867-870) ก็ไม่มี
  `overflow-x` — ตารางที่ content ดันกว้างกว่าคอลัมน์จึงล้นออกไป

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/markdown.js:182-191` — sanitizer ห่อทุก
  `<table>` ด้วย `.md-table-wrap`
- `grok-desktop/src/renderer/style.css:3872-3887` — `.md-table-wrap
  { overflow-x: auto; max-width: 100% }`

## วิธีแก้ไข

- `src/renderer/markdown.js` — หลัง sanitize walk ให้ห่อทุก `<table>` ด้วย
  `<div class="md-table-wrap">` (div+class ผ่าน allowlist เดิมอยู่แล้ว);
  guard กันห่อซ้ำถ้า parent เป็น wrap อยู่แล้ว
- `src/renderer/style.css` — เพิ่ม `.msg-assistant .md-table-wrap` แบบ grok
  (block, max-width 100%, overflow-x auto, overscroll-behavior-x contain);
  สไตล์ตารางเดิม (border เซลล์, width 100%) คงไว้ — ตารางแคบหน้าตาเหมือนเดิม
  ตารางกว้างเลื่อนแนวนอนเฉพาะใน wrap

## ไฟล์ที่เปลี่ยน

- `src/renderer/markdown.js` — table wrap ใน sanitizeHtml
- `src/renderer/style.css` — บล็อก `.md-table-wrap`
- `scripts/unit-test-markdown.mjs` — source-level guard (walk ต้องการ DOM
  จริง ทดสอบใน harness ไม่ได้)

## การทดสอบ

- unit (`markdown`): pin ว่า sanitize ห่อ table และ CSS มี overflow-x: auto
- `npm test` เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-036\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
