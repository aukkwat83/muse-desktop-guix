# BUG-073 — คำตอบยาวมากแล้ว transcript ไม่มี scrollbar, composer หายไปใต้จอ

ความรุนแรง: major (ผู้ใช้รายงานจากการใช้งานจริง)

## อาการที่ผู้ใช้เห็น

เมื่อผลลัพธ์ของ assistant ยาวมาก หน้า transcript ไม่มี scrollbar เลื่อนไม่ได้
และแถบ composer (กล่องพิมพ์ prompt) หายไปใต้ขอบ viewport — พิมพ์ต่อไม่ได้จนกว่า
จะเปิดแชทใหม่

## สาเหตุ (file:line)

hazard คลาสเดียวกันสองชั้นซ้อนกัน — flex/grid child มี default `min-height: auto`
จึงปฏิเสธที่จะหดต่ำกว่าความสูงของ content:

- `#main` (`src/renderer/style.css:776`) เป็น grid child ของ `#app`
  (`height: 100vh`) แต่ไม่มี `min-height: 0` → เมื่อเนื้อ transcript ยาวเกิน
  100vh, `#main` ยืดทะลุ viewport และเพราะ `body { overflow: hidden }`
  (style.css:123) ส่วนที่ล้นจึงเข้าถึงไม่ได้เลย → composer ถูกดันหายไปใต้จอ
  (อาการที่รายงาน)
- `.transcript` (style.css:944) เป็น flex child ที่ `flex: 1; overflow-y: auto`
  แต่ไม่มี `min-height: 0` → หดต่ำกว่า content ไม่ได้ เลยไม่เคย overflow
  → scrollbar ไม่เคยโผล่ (อาการ "เลื่อนไม่ได้")
- hazard คลาสเดียวกันในฝั่ง sidebar: `#sidebar` (grid child, flex column) และ
  `.sidebar-nav` (`flex: 1; overflow-y: auto`) ก็ขาด `min-height: 0` เช่นกัน —
  รายการ group/session ที่ยาวมากจะพังแบบเดียวกัน จึงปิดทั้งคลาสใน fix เดียว

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/style.css:768-772` — comment "Grid items default
  min-height:auto → refuse to shrink below content" + guard รวมของ grid
  children
- `grok-desktop/src/renderer/style.css:2163` — `.main-col { min-height: 0 }`
- `grok-desktop/src/renderer/style.css:850` — `.sidebar { min-height: 0 /*
  grid child: allow .sidebar-nav to scroll */ }`
- `grok-desktop/src/renderer/style.css:1101,1758` — scroll containers ที่เป็น
  flex child ก็มี guard เช่นกัน

## วิธีแก้ไข

เพิ่ม `min-height: 0` พร้อม comment สั้น ๆ อธิบายเหตุ (อังกฤษ, อ้าง grok refs)
ให้ 4 selector ใน `src/renderer/style.css` เท่านั้น — ไม่แตะโครง layout, ไม่แตะ
JS, ไม่เปลี่ยนค่า height/overflow เดิม:

1. `#main` — grid child ของ `#app`
2. `.transcript` — flex child ของ `#main`
3. `#sidebar` — grid child ของ `#app`
4. `.sidebar-nav` — flex child ของ `#sidebar`

ตรวจสอบ scroll container อื่นใน style.css แล้ว (`overflow-y/auto` ทุกจุด):
tool output block, ix-card bodies และ list ที่มี `max-height` ชัดเจนใช้กลไก
คนละแบบ (cap ความสูงตายตัว ไม่ต้อง shrink) จึงไม่เพิ่ม guard ให้ — รวมถึง
`overflow-x: auto` ของ table wrap ซึ่งเป็นแกนนอน นอกขอบเขต hazard นี้

นอกจากนี้เพิ่ม static guard ใน `scripts/unit-test-css-guards.mjs` (check ข้อ 6):
parse style.css แล้ว assert ว่า 4 selector ข้างต้นประกาศ `min-height: 0` —
กันการถูกถอดออกเงียบ ๆ ในอนาคต (hazard นี้มองไม่เห็นใน review)

## ไฟล์ที่เปลี่ยน

- `src/renderer/style.css` — `min-height: 0` × 4 selector + comments
- `src/renderer/index.html` — bump `?v=` 0.4.44→0.4.45 ทั้ง 6 asset
  (style.css เปลี่ยน และ css-guards บังคับให้ token ตรงกันหมด)
- `scripts/unit-test-css-guards.mjs` — เพิ่ม check ข้อ 6 + ปรับ header comment

## การทดสอบ

- `node scripts/unit-test-css-guards.mjs` → 12/12 (รวม guard ใหม่ "flex/grid
  scroll containers declare min-height: 0 (BUG-073)")
- `npm test` เขียวครบ 20 suites (รวม e2e 38/38)
- ตรวจ live หลัง deploy: `curl -s http://127.0.0.1:3849/style.css | grep -c
  'min-height: 0'` พบ guard จริงใน CSS ที่เสิร์ฟ
- ข้อจำกัด: การ scroll จริงในหน้าต่างแอปไม่ได้ทดสอบด้วยมือจากสภาพแวดล้อมนี้ —
  ยืนยันด้วย static guard + CSS ที่เสิร์ฟจริง; กลไกเป็น standard CSS
  (min-height:0 บน flex/grid child) ตรงกับที่ grok-desktop ใช้ปิด hazard
  เดียวกัน

## วิธี revert

```bash
git log --grep='\[BUG-073\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
