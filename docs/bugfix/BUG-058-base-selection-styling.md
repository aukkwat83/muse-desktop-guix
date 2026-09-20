# BUG-058 — ข้อความที่ select ได้สี default ของระบบนอกธีม Claude Light

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ลาก select ข้อความบนธีม moonlight/daylight ได้พื้นหลัง selection สีฟ้าหม่น
default ของ WebKit — ไม่เข้ากับ palette ของธีม; มีแค่ Claude Light ที่ทาสี
selection ของตัวเอง

## สาเหตุ (file:line)

- `src/renderer/theme-claude-light.css:84-86` — มี rule
  `html[data-theme='claude-light'] ::selection` ธีมเดียว
- `src/renderer/style.css` (ก่อนแก้) — ไม่มี `::selection` พื้นฐานเลย ธีมที่
  เหลือจึงตกไปใช้ UA default

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/theme-claude-light.css:991-994` และ
  `grok-desktop/src/renderer/theme-claude-dark.css:952-955` — ทุกธีมประกาศ
  `::selection` ของตัวเอง (accent 28% + ตัวหนังสือสีเข้มของธีม)

## วิธีแก้ไข

- `src/renderer/style.css` — เพิ่ม base rule `::selection { background:
  var(--accent-soft) }` หลัง block `body` — ทุกธีมได้ selection โทน accent
  ของตัวเองผ่าน token; Claude Light คง override เดิม (rust 22%) ไว้เพราะ
  specificity ของ `html[data-theme=…]` สูงกว่า
- ไม่ใส่ `color` ใน rule — ตัวหนังสือคง `--ink` เดิม เหมือนที่ Claude Light
  ทำอยู่ก่อนแล้ว
- เพิ่มคู่ `['selected text on page', '--ink', '--accent-soft', '--bg']` ใน
  PAIRS ของ `scripts/unit-test-theme-contrast.mjs` ตามกฎ AGENTS.md (คู่สีที่
  แบกข้อความต้องเข้า audit) — วัด wash ที่ flatten ลงบนหน้ากระดาษ

## ไฟล์ที่เปลี่ยน

- `src/renderer/style.css` — base ::selection rule
- `scripts/unit-test-theme-contrast.mjs` — PAIRS เพิ่ม 1 คู่
- `src/renderer/index.html` — bump `?v=` 0.4.36 → 0.4.37 (ทุก ref)

## การทดสอบ

- `npm run test:contrast` — คู่ selected text ผ่าน AA ทั้งสามธีม: moonlight
  12.87, daylight 13.38, claude-light 12.18
- `npm test` เขียวทุก suite (17 suites: unit 16 + e2e 38/38)
- ตรวจด้วยมือ: select ข้อความใน transcript บนทั้งสามธีม → ได้ wash โทน accent

## วิธี revert

```
git log --grep='\[BUG-058\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
