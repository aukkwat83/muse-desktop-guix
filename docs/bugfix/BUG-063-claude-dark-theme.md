# BUG-063 — ไม่มีธีม Claude Dark (auto-dark ตกไป moonlight เย็น ๆ)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ผู้ใช้ที่ชอบโทนอบอุ่นของ Claude Light ไม่มีธีมมืดคู่กัน — ตอน pref เป็น Auto
และ macOS อยู่ dark mode แอปตกไป moonlight (โทนเย็น blue-grey) ทั้งที่
grok-desktop จับคู่ warm dark ให้

## สาเหตุ (file:line)

- `src/renderer/theme-boot.js` (ก่อนแก้) :12 `THEMES = ['moonlight',
  'daylight', 'claude-light']` — ไม่มี claude-dark; `resolve()` :23 map
  auto-dark → `'moonlight'`
- `src/renderer/app.js` THEME_OPTIONS :1466-1471 — ไม่มีตัวเลือก Claude Dark
- ไม่มีไฟล์ `theme-claude-dark.css` และไม่ได้ link ใน index.html

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/theme-claude-dark.css:10-99` — บล็อก token
  warm charcoal (#262624 page, #1f1e1b sidebar, cream #f0eee6, terracotta)
  พร้อมบันทึกผล audit ของมันเอง (placeholder ต้องผ่านบน --input-bg)
- `grok-desktop/src/renderer/index.html:262-265` — ตัวเลือก "Claude Dark
  (warm charcoal)" ใน switcher
- `grok-desktop/src/renderer/platform-boot.js:44-53` — `systemTheme()` map
  ระบบมืด → claude-dark

## วิธีแก้ไข

- **`src/renderer/theme-claude-dark.css` ใหม่** — พอร์ต palette ของ grok มาบน
  token set ของ kimi (ไม่ได้ก๊อปทั้ง 1111 บรรทัด; ใช้ theme-claude-light.css
  เป็นแบบรูป — base style.css เป็นธีมมืดอยู่แล้วจึงแทบไม่ต้อง override
  component) การ map token และการปรับที่ audit บังคับ (จดไว้ในหัวไฟล์):
  - kimi มี `--panel` ตัวเดียว (grok แยก `--panel`/`--sidebar`) → ใช้ค่า
    `--sidebar` #1f1e1b ของ grok เพราะ audit ของ kimi วัด muted บน
    raised/panel-2 ด้วย — ถ้าใช้ #30302e ของ grok ค่า muted #8a877e จะตก 3.68
  - `--accent` (fill ที่มี glyph ขาว): #da7756 ของ grok วัดกับขาวได้ ~3.1 →
    ใช้ #b5573a (4.78) ตามการตัดสินใจเดียวกันของ Claude Light
  - `--muted`: #8a877e → #a19e95 (3.68 บน raised → 4.93)
  - `--danger` ใช้ text danger #d0887e ของ grok + dark ink #2e0709 (6.52)
    รูปแบบเดียวกับ moonlight
- `theme-boot.js` — THEMES เพิ่ม `'claude-dark'`; auto-dark map เป็น
  claude-dark ตาม grok (app.js OS-flip listener ผ่าน resolve() ตัวเดียวกัน
  จึงไม่ต้องแกะเพิ่ม)
- `app.js` — THEME_OPTIONS เพิ่ม Claude Dark (icon 🌘) ไว้ถัดจาก Moonlight
- `index.html` — link stylesheet ใหม่พร้อม token `?v=` เดียวกับทุก ref
- `scripts/unit-test-theme-contrast.mjs` — เพิ่ม claude-dark เข้า themes map
  และ token coverage: ผ่าน AA ทั้ง 27 คู่ (ตึงสุด: accent type on active row
  4.53, muted on raised 4.94, placeholder 4.87)
- `scripts/unit-test-theme-boot.mjs` — อัปเดต expectation auto-dark เป็น
  claude-dark + เคส normalize('claude-dark')

## ไฟล์ที่เปลี่ยน

- `src/renderer/theme-claude-dark.css` — ธีมใหม่ (token + override 2 rule)
- `src/renderer/theme-boot.js` — THEMES + auto-dark mapping
- `src/renderer/app.js` — THEME_OPTIONS เพิ่ม 1 รายการ
- `src/renderer/index.html` — link ธีมใหม่ + bump `?v=` 0.4.39 → 0.4.40
- `scripts/unit-test-theme-contrast.mjs` — ธีมที่สี่ใน audit
- `scripts/unit-test-theme-boot.mjs` — expectation ตาม mapping ใหม่

## การทดสอบ

- `npm run test:contrast` — claude-dark ผ่าน AA ทุกคู่; css-guards (BUG-061)
  หยิบไฟล์ใหม่เข้า balance/scoping check อัตโนมัติผ่าน glob `theme-*.css`
- `npm test` เขียวทุก suite (18 suites: unit 17 + e2e 38/38)
- ตรวจด้วยมือ: เลือก Claude Dark จากเมนู → ได้ warm charcoal; ตั้ง Auto บน
  macOS dark mode → เปิดมาเป็น Claude Dark

## วิธี revert

```
git log --grep='\[BUG-063\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
