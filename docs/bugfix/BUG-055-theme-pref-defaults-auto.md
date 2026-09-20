# BUG-055 — เครื่องใหม่บันทึก theme pref เป็น 'moonlight' ทั้งที่ควรเป็น 'auto'

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

เปิดแอปครั้งแรก (ยังไม่เคยเลือกธีม) หน้าจอถูกทาสีตามระบบถูกต้อง แต่เมนูธีม
ติ๊กที่ "Moonlight" แทนที่จะเป็น "Auto (ตามระบบ)" และเมื่อ macOS สลับ
dark/light หน้าต่างไม่ตามระบบอีกเลย — เงียบ ๆ จนกว่าผู้ใช้จะกดเลือก Auto เอง

## สาเหตุ (file:line)

- `src/renderer/theme-boot.js` (ก่อนแก้) :30-31 — `resolve(pref)` ตีความ pref
  ที่หายไปถูกต้อง (ทาสีตาม OS) แต่บันทึก `dataset.themePref = pref || 'moonlight'`
  — pref ที่เป็น null ถูกแปลงเป็น 'moonlight' ไม่ใช่ 'auto'
- `src/renderer/app.js` (ก่อนแก้) `currentThemePref()` :1473-1475 — fallback
  เดียวกัน: `dataset.themePref || 'moonlight'`
- ผลลัพธ์: listener สลับตาม OS (`app.js` :1507-1509) ถูก gate ด้วย
  `currentThemePref() === 'auto'` จึงไม่มีวันทำงานสำหรับเครื่องที่เพิ่งติดตั้ง

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/platform-boot.js:37-42` — `migratePref()`: ค่าที่
  ไม่รู้จัก → `'auto'`; :55-72 `readPref()` คืน `'auto'` เมื่อไม่มีค่า และ
  persist ค่าที่ migrate แล้วกลับลง localStorage
- `grok-desktop/src/renderer/platform-boot.js:82` — เขียน pref ที่ normalize
  แล้วลง `data-theme-pref` เสมอ
- `grok-desktop/src/renderer/app.js:7618` — ฝั่ง app อ่าน pref ผ่าน
  `boot.readPref()` (ฟังก์ชัน normalize ตัวเดียวกับ boot)

## วิธีแก้ไข

- `src/renderer/theme-boot.js` — เพิ่ม `normalize(pref)` ตัวเดียว: ค่าว่าง/ไม่รู้จัก
  → `'auto'`; `resolve()` เรียกผ่าน `normalize()`; boot เขียน pref ที่ normalize
  แล้วลงทั้ง `dataset.themePref` และ localStorage (เป็นการ migrate ค่าเก่าใน
  ตัว); เปิด `normalize` บน `window.__kimiTheme` ให้ app.js ใช้ตัวเดียวกัน
- `src/renderer/app.js` — `currentThemePref()` ผ่าน `THEME_BOOT.normalize()`
  (fallback `'auto'` แทน `'moonlight'`); `applyTheme()` normalize ก่อนเขียน
  dataset/localStorage ทุกครั้ง
- suite ใหม่ `scripts/unit-test-theme-boot.mjs` รัน theme-boot.js จริงใน vm
  sandbox (มันเป็น classic script ที่ห้าม import โดยตั้งใจ) แล้วตรวจผลที่ boot
  เขียนลง dataset/localStorage

## ไฟล์ที่เปลี่ยน

- `src/renderer/theme-boot.js` — normalize + persist migration + expose API
- `src/renderer/app.js` — currentThemePref/applyTheme ใช้ normalize ตัวเดียวกัน
- `src/renderer/index.html` — bump `?v=` 0.4.33 → 0.4.34 (ทุก ref)
- `scripts/unit-test-theme-boot.mjs` — suite ใหม่ (7 เคส)
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite theme-boot
- `AGENTS.md` — อัปเดตจำนวน suite (15 → 16 unit + e2e)

## การทดสอบ

- unit (`theme-boot`): เครื่องใหม่ได้ pref 'auto' + persist + ทาสีตาม OS
  (dark→moonlight, light→claude-light), pref ปกติอยู่ครบ, pref แปลก migrate เป็น
  'auto' ทั้ง dataset และ localStorage, localStorage throw ก็ยัง boot เป็น auto,
  normalize/resolve ที่ expose ใช้กฎเดียวกัน
- `npm test` เขียวทุก suite (17 suites: unit 16 + e2e 38/38)
- ตรวจด้วยมือ: ลบ key `kimi-desktop.theme` แล้ว reload → เมนูธีมติ๊ก Auto และ
  สลับธีมระบบแล้วหน้าต่างตาม

## วิธี revert

```
git log --grep='\[BUG-055\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
