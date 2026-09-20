# BUG-045 — ไม่มี wheel-up unpin; เลื่อนขึ้นนิดเดียวแล้วถูกดึงกลับลงล่าง

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ระหว่างที่คำตอบกำลังสตรีม ผู้ใช้หมุน wheel (หรือปาดนิ้ว) ขึ้นเพื่ออ่านข้างบน
เล็กน้อย — ถ้าระยะยังไม่ถึง 120px สถานะ pinned ไม่ถูกปลด และ delta ถัดไป
ดึงหน้าจอกลับลงล่างสุดทันที เลื่อนขึ้นเท่าไรก็สู้สตรีมไม่ได้

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) :1194-1196 — scroll listener ทำแค่
  `state.pinned = nearBottom()` (threshold 120px ที่ :140-143):
  1. เลื่อนขึ้นน้อยกว่า threshold → `nearBottom()` ยังจริง → pinned ค้างไว้
     → `scrollToBottom()` จาก delta ถัดไปดึงกลับ
  2. โครงสร้างนี้แยกไม่ได้ว่า scroll event มาจากผู้ใช้หรือจากเนื้อหาที่โตขึ้น
     เอง (ตอน pinned อยู่ ถ้า scrollHeight โต scroll event จะยิงพร้อม
     nearBottom=false → pinned หลุดเองทั้งที่ผู้ใช้ไม่ได้แตะ)

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/scroll-pin.js:18-27` — `computePin()`:
  `userScrolled` ปลด pin เสมอ (แม้ยัง near); `nearBottom && !userScrolled`
  ค่อย re-pin; scroll event เปล่า ๆ ไม่เคย unpin
- `grok-desktop/src/renderer/app.js:2006-2022` — wheel listener:
  `deltaY < 0` → `computePin({userScrolled:true})` ปลด pin ทันที
- `grok-desktop/src/renderer/app.js:2023-2043` — touch: pan ขึ้นเกิน 8px
  ปลด pin; `grok-desktop/src/renderer/app.js:1985-2005` — scroll listener
  ผ่าน computePin เช่นกัน

## วิธีแก้ไข

- `src/renderer/scroll-pin.js` (ใหม่, pure) — พอร์ต `computePin()` แบบ verbatim
  พร้อม field `showJump` สำหรับ jump pill (ต่อใน BUG-047)
- `src/renderer/app.js`:
  - scroll listener เปลี่ยนเป็น `computePin({pinned, nearBottom: nearBottom(),
    userScrolled: false, ...})` — re-pin ที่ก้นเท่านั้น ไม่เคย unpin เอง
    (เนื้อหาโตใต้ผู้อ่านที่ pinned จึงไม่หลุด pin อีก)
  - เพิ่ม wheel listener: `deltaY < 0` → unpin ทันทีผ่าน computePin
  - เพิ่ม touchstart/touchmove: pan ขึ้นเกิน 8px → unpin
  - listener ทั้งหมด passive เพื่อไม่บล็อก scroll

## ไฟล์ที่เปลี่ยน

- `src/renderer/scroll-pin.js` — โมดูล pure ใหม่ (computePin)
- `src/renderer/app.js` — import + ผูก scroll/wheel/touch ใน `wireUi()`
- `src/renderer/index.html` — bump `?v=` 0.4.23 → 0.4.24
- `scripts/unit-test-scroll-pin.mjs` — suite ใหม่ (7 เคส)
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite scroll-pin

## การทดสอบ

- unit (`scroll-pin`): userScrolled ปลด pin แม้ nearBottom; scroll event เปล่า
  ไม่ unpin; re-pin ที่ก้น; showJump เฉพาะ unpinned+newContent; input ว่าง
  degrade เป็น unpinned/no-scroll ที่ปลอดภัย
- `npm test` เขียวทุก suite (11 suites: unit 10 + e2e 37/37)

## วิธี revert

```
git log --grep='\[BUG-045\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
