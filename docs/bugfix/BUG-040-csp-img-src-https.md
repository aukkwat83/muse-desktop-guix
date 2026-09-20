# BUG-040 — CSP บล็อกรูป https ที่ sanitizer อนุญาต

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

assistant ใส่รูปจาก URL https (เช่น badge, diagram จากเว็บ) ในคำตอบ —
ผู้ใช้เห็นไอคอนรูปแตก (broken image) ทั้งที่ markdown ถูกต้อง

## สาเหตุ (file:line)

- `src/renderer/index.html` (ก่อนแก้) :8 — CSP `img-src 'self' data:` ไม่มี
  `https:` ขณะที่ `src/renderer/markdown.js:40-45` `safeImgSrc()` อนุญาต
  `^https:` — สองชั้นขัดกัน: sanitizer ผ่าน แต่เบราว์เซอร์บล็อกตอนโหลด

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/index.html:10` — `img-src 'self' data: https:`

## วิธีแก้ไข

- `src/renderer/index.html` — เพิ่ม `https:` เข้า `img-src` ตาม reference;
  ส่วนอื่นของ CSP คงเดิมทุกประการ (ไม่เปิด `http:` — mixed content ยังถูกบล็อก)

## ไฟล์ที่เปลี่ยน

- `src/renderer/index.html` — CSP img-src
- `scripts/unit-test-markdown.mjs` — pin ว่า img-src มี https: (และไม่มี http:)
  ให้ตรงกับสิ่งที่ safeImgSrc อนุญาต

## การทดสอบ

- unit (`markdown`): CSP img-src ต้องมี `https:` และไม่มี `http:`
- `npm test` เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-040\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
