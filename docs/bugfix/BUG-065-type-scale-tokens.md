# BUG-065 — ไม่มี type-scale token: ขนาดตัวอักษร hardcode กระจาย ~20 จุด

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ไม่มีอาการที่มองเห็น (และตั้งใจให้ไม่มี) — เป็นหนี้โครงสร้าง: อยากปรับขนาด
ตัวอักษรทีเดียวทั้งแอปทำไม่ได้ ต้องไล่แก้ทีละ rule และขนาดที่ "ควรเท่ากัน"
ค่อย ๆ คลาดเคลื่อนกันเอง

## สาเหตุ (file:line)

- `src/renderer/style.css` (ก่อนแก้) — body ใช้ `font: 14px/1.6 …` (:120)
  และมี `font-size: <N>px` แบบ hardcode 51 จุด 12 ขนาด (10, 10.5, 11, 11.5,
  12, 12.5, 13, 14, 15, 17, 18, 34) ไม่มี token ใด ๆ

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/style.css:161-177` — บันได `--fs-caption …
  --fs-display` คำนวณจาก `--type-step` (เลื่อนทั้งบันไดทีเดียว)
- `grok-desktop/src/renderer/style.css:155-159` — line-height token แยก
  (`--line-ui/--line-chat/--line-md/…`)

## วิธีแก้ไข

- `src/renderer/style.css` — เพิ่มบันได `--fs-*` 12 ขั้นในบล็อก base โดยใช้
  **ค่า px เดิมเป๊ะ** ทุกขั้น (rendering ไม่เปลี่ยน; ยังไม่มี prefs UI จึงไม่
  พอร์ต `--type-step` แบบ grok — คอมเมนต์ในไฟล์บอกไว้ว่าค่าคงที่จะค่อยกลายเป็น
  calc เมื่อมี preference ให้ป้อน):
  `--fs-caption-2:10px` `--fs-caption-1:10.5px` `--fs-footnote:11px`
  `--fs-subhead:11.5px` `--fs-callout:12px` `--fs-body-sm:12.5px`
  `--fs-lead:13px` `--fs-body:14px` `--fs-headline:15px`
  `--fs-title-3:17px` `--fs-title-2:18px` `--fs-display:34px`
- แปลง `font-size` ทั้ง 51 จุด + shorthand ของ body (`font: var(--fs-body)/1.6
  …`) ให้ใช้ token — heading ของ markdown ที่เป็น em (1.55em-0.92em) คงไว้
  เพราะเป็นสเกลสัมพัทธ์กับ body อยู่แล้ว ไม่ใช่ px ตายตัว
- line-height tokens ของ grok ไม่ได้พอร์ต (อยู่นอกขอบเขต Fix ที่ระบุ —
  ค่า line-height ของ kimi ปัจจุบันกระจายน้อยและผูกกับแต่ละ component)

## ไฟล์ที่เปลี่ยน

- `src/renderer/style.css` — token บันได + แปลงทุก font-size
- `src/renderer/index.html` — bump `?v=` 0.4.41 → 0.4.42 (ทุก ref)

## การทดสอบ

- `npm test` เขียวทุก suite (18 suites: unit 17 + e2e 38/38) รวม css-guards
  (balance หลังแก้ครั้งใหญ่)
- ตรวจ diff: บรรทัดที่เปลี่ยนเป็นเฉพาะ font-size/font shorthand + บล็อก token
  เท่านั้น — ค่าที่คำนวณได้เหมือนเดิมทุกพิกเซล

## วิธี revert

```
git log --grep='\[BUG-065\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
