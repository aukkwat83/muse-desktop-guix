# BUG-057 — moonlight/daylight ไม่ประกาศ color-scheme

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

บนธีมมืด (moonlight) scrollbar แบบ overlay ของ WKWebView และ form chrome
ของ UA (เช่น กรอบ focus เริ่มต้น, control พื้นระบบ) ออกโทนสว่าง ขัดกับพื้นหลัง
มืด — ธีม claude-light ไม่เป็นเพราะประกาศ `color-scheme: light` ไว้

## สาเหตุ (file:line)

- `src/renderer/style.css` (ก่อนแก้) — บล็อก token ของ moonlight (:5-43) และ
  daylight (:45-71) ไม่มี `color-scheme` เลย; มีแค่
  `src/renderer/theme-claude-light.css:28` ที่ประกาศไว้ธีมเดียว
- WKWebView ใช้ค่านี้ตัดสินสี overlay scrollbar และ UA form chrome — เมื่อไม่
  ประกาศ ค่า default คือ light ธีมมืดจึงได้ chrome สว่าง

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/theme-claude-dark.css:11` — `color-scheme: dark`
  ในบล็อก token ของธีมมืด
- `grok-desktop/src/renderer/platform-boot.js:85` — boot ยังเขียน
  `root.style.colorScheme` inline ตามธีมที่ resolve ได้อีกชั้น

## วิธีแก้ไข

- `src/renderer/style.css` — เพิ่ม `color-scheme: dark` ในบล็อก
  `:root, html[data-theme='moonlight']` และ `color-scheme: light` ในบล็อก
  `html[data-theme='daylight']` (claude-light มีอยู่แล้วในไฟล์ของตัวเอง)
- ไม่พอร์ตการเขียน inline จาก platform-boot — ของ kimi ทุกธีมประกาศใน CSS
  ครบแล้ว ค่าตาม stylesheet ทำงานทันทีโดยไม่ต้องรอ JS

## ไฟล์ที่เปลี่ยน

- `src/renderer/style.css` — เพิ่ม color-scheme สองบล็อก token
- `src/renderer/index.html` — bump `?v=` 0.4.35 → 0.4.36 (ทุก ref)

## การทดสอบ

- `npm test` เขียวทุก suite (17 suites: unit 16 + e2e 38/38) — color-scheme
  ไม่ใช่คู่สีที่ contrast audit วัด จึงไม่กระทบ test:contrast
- ตรวจด้วยมือ: ธีม moonlight แล้วดู scrollbar/form chrome ออกโทนมืด

## วิธี revert

```
git log --grep='\[BUG-057\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
