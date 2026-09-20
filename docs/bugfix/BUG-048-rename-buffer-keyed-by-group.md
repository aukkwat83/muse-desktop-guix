# BUG-048 — buffer ข้อความ rename group ไม่ผูกกับ group id

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

เปิดกล่อง rename ของ group A พิมพ์ค้างไว้ แล้วไปเปิด rename ของ group B
(โดยไม่ได้ commit/ยกเลิก A ให้เรียบร้อย เช่นมี re-render จาก SSE แทรกกลาง)
— กล่องของ B ถูกเติมข้อความค้างของ A แทนชื่อของ B

## สาเหตุ (file:line)

- `src/renderer/sidebar.js` `beginRename()` (ก่อนแก้):
  - :529 ตั้ง `this.renameId = group.id` **ก่อน** ตัดสินใจ reuse buffer
  - :535 ทดสอบ `this.renameId === group.id ? this.renameValue …` — เป็น true
    เสมอเพราะเพิ่งเขียนทับไปเอง ทำให้ `renameValue` ที่ค้างจาก rename ของ
    group อื่น (buffer ถูกเก็บข้าม re-render โดยเจตนา) รั่วไปเติมกล่องของ
    group ใหม่

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:6506-6514` — คำนวณ `startVal` ด้วย guard
  `groupRenameId === id && groupRenameValue` **ก่อน** บรรทัด
  `groupRenameId = id` — reuse เฉพาะ buffer ที่พิมพ์ไว้กับ group เดียวกัน
  เท่านั้น

## วิธีแก้ไข

- จับค่า reuse ก่อนเขียนทับ id:
  `const reuse = this.renameId === group.id && this.renameValue ? this.renameValue : group.name;`
  แล้วค่อย `this.renameId = group.id; this.renameValue = reuse;`
- ใช้ `reuse` เป็น `input.value` โดยตรง แทน expression ที่ guard ตาย
- guard `commitOnRealBlur` (commit เฉพาะ blur จริง ไม่ใช่ blur จาก re-render)
  คงไว้เหมือนเดิมทุกประการ

## ไฟล์ที่เปลี่ยน

- `src/renderer/sidebar.js` — `beginRename()` ผูก buffer กับ group id
- `src/renderer/app.js` — bump import token sidebar.js 0.4.2 → 0.4.3
- `src/renderer/index.html` — bump `?v=` 0.4.26 → 0.4.27

## การทดสอบ

- `npm test` เขียวทุก suite — sidebar.js ผูก DOM โดยตรง (constructor รับ
  mount element) ไม่มี pure logic ให้แยก suite; การเปลี่ยนเป็นลำดับการอ่าน/
  เขียนตัวแปรสองบรรทัดภายใต้ guard เดิม
- ตรวจด้วยมือ: rename A ค้าง → ให้ SSE re-render → เปิด rename B → กล่อง B
  แสดงชื่อของ B

## วิธี revert

```
git log --grep='\[BUG-048\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
