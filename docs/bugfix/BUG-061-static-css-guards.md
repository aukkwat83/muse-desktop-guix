# BUG-061 — ไม่มี static guard ป้องกัน CSS/ธีม/cache-bust พังเงียบ ๆ

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ไม่มีอาการปัจจุบัน — เป็นช่องว่างของการป้องกัน: บั๊ก CSS แบบที่รีวิวมองไม่เห็น
(ปีกกาเกินทำ rule หลังจากนั้นหลุดหมด, selector ธีมรั่วไปทั้งแอป, ลืม bump
`?v=` จน WKWebView เสิร์ฟ bundle เก่า, selector ตายใน reduced-motion อย่าง
BUG-056) ผ่านเข้ามาได้โดยไม่มีตัวไหนดัก

## สาเหตุ (file:line)

- ไม่มีไฟล์ทดสอบเลย — grok-desktop มี `scripts/unit-test-css-balance.mjs` และ
  `scripts/unit-test-theme-r11.mjs` แต่ kimi ไม่เคยพอร์ต guards ชุดนี้มา

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/scripts/unit-test-css-balance.mjs:65-180` — walker วัด
  brace/comment/string balance (depth ติดลบ = ปีกกาเกิน, comment ไม่ปิด)
- `grok-desktop/scripts/unit-test-theme-r11.mjs:115-144` — `assertFullyScoped()`:
  ทุก top-level selector ของ theme file ต้องอยู่ใต้ `html[data-theme=…]` ของ
  ตัวเอง (@keyframes/@font-face ห้ามเพราะ scope ไม่ได้)
- `grok-desktop/scripts/unit-test-theme-r11.mjs:255-264` — boot script ต้อง
  โหลดก่อน stylesheet
- `grok-desktop/scripts/unit-test-theme-r11.mjs:293-323` — ทุก asset ต้องมี
  cache-bust token

## วิธีแก้ไข

สคริปต์ใหม่ `scripts/unit-test-css-guards.mjs` (8 เคส) ปรับให้เข้ากับ kimi:

1. **balance** ของ `style.css` + ทุกไฟล์ `theme-*.css` (glob — ธีมใหม่เข้า
   guard อัตโนมัติ): depth จบที่ 0, ไม่มีช่วงติดลบ, comment/string ปิดครบ —
   walker ตัวเดียวกับ grok แต่เก็บ top-level selectors มาด้วย (รวมเนื้อ string
   ใน attribute selector ไว้ ไม่งั้น `html[data-theme='x']` กลายเป็น
   `html[data-theme=]` แล้ว scoping check พัง)
2. **scoping**: ทุก top-level selector ของ theme file ต้องมี
   `[data-theme='<ชื่อธีมจากชื่อไฟล์>']` (ยกเว้น wrapper @media/@supports)
3. **boot order**: `theme-boot.js` อยู่ก่อน `<link rel="stylesheet">` แรกใน
   index.html
4. **cache-bust**: ทุก `src/href` ที่ชี้ asset `.js`/`.css` ใน renderer ต้องมี
   `?v=` ที่ไม่ว่างและเท่ากันทุกตัว (icon.png ไม่อยู่ในขอบเขต — ไฟล์ binary
   ไม่ได้เปลี่ยนตาม commit)
5. **reduced-motion sanity**: ทุก class ที่ถูกชี้ใน `@media
   (prefers-reduced-motion)` ของ style.css ต้องมีอยู่จริงใน JS/HTML ของ
   renderer — ปิดช่อง selector ตายแบบ BUG-056 (ทดสอบเส้นทางลบแล้ว: ใส่
   `.chat-row.running .dot` กลับเข้าไป guard fail ทันที)

ลงทะเบียน suite `css-guards` ใน `scripts/unit-test-all.mjs` และอัปเดตจำนวน
suite ใน AGENTS.md (16 → 17 unit + e2e)

## ไฟล์ที่เปลี่ยน

- `scripts/unit-test-css-guards.mjs` — suite ใหม่ (8 เคส)
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite
- `AGENTS.md` — อัปเดตจำนวน suite

## การทดสอบ

- suite ใหม่ผ่าน 8/8; ทดสอบ negative path โดยยัด selector ตายของ BUG-056 กลับ
  เข้า style.css ชั่วคราว → guard fail ตามคาด แล้ว revert กลับเขียว
- `npm test` เขียวทุก suite (18 suites: unit 17 + e2e 38/38)

## วิธี revert

```
git log --grep='\[BUG-061\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
