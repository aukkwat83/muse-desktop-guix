# BUG-064 — sidebar ตายตัว 264px ไม่สัดส่วนกับหน้าต่าง

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

หน้าต่างแคบ (แย่งพื้นที่ครึ่งจอ/ต่อจอเล็ก) sidebar กว้าง 264px เท่าเดิมกินสัดส่วน
เกินควร ส่วนหน้าต่างกว้าง ๆ ก็ได้แค่ 264px ทั้งที่มีที่เหลือ — ไม่ scale ตามจอ

## สาเหตุ (file:line)

- `src/renderer/style.css` (ก่อนแก้) `#app` :115 —
  `grid-template-columns: 264px 1fr` ค่าคงที่ไม่มี token

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/style.css:133` — token
  `--sidebar-w: clamp(12rem, 18%, 16rem)` ในบล็อก token
- `grok-desktop/src/renderer/style.css:751` — grid ใช้ `var(--sidebar-w)`

## วิธีแก้ไข

- `src/renderer/style.css`
  - token `--sidebar-w: clamp(12rem, 18%, 16rem)` ในบล็อก base (ถัดจาก
    `--duration-theme`; ไม่ใช่สี ไม่เข้า contrast audit) — ใช้ค่าของ grok
    ตรง ๆ: ยืดตาม 18% ของหน้าต่าง ล็อกไว้ที่ 192-256px (หน้าต่างกว้างมาก
    sidebar จะแคบลงจาก 264 เหลือสูงสุด 256px ตาม geometry ที่ grok audit ไว้)
  - `#app` เปลี่ยนเป็น `grid-template-columns: var(--sidebar-w) 1fr`
- ไม่พอร์ต `--sidebar-w-narrow` (โหมด overlay ของ grok) — kimi ไม่มีโหมดนั้น

## ไฟล์ที่เปลี่ยน

- `src/renderer/style.css` — token + grid column
- `src/renderer/index.html` — bump `?v=` 0.4.40 → 0.4.41 (ทุก ref)

## การทดสอบ

- `npm test` เขียวทุก suite (18 suites: unit 17 + e2e 38/38) รวม css-guards
- ตรวจด้วยมือ: ยืด/หดหน้าต่าง → sidebar ไหลตาม 18% และหยุดที่ 192/256px

## วิธี revert

```
git log --grep='\[BUG-064\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
