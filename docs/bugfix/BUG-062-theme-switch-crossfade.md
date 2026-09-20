# BUG-062 — สลับธีมเป็น flash-cut ดิบ ๆ ไม่มี crossfade

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

เลือกธีมจากเมนู (หรือ macOS สลับ dark/light ตอน pref เป็น Auto) แล้วทั้งหน้าต่าง
เปลี่ยนสีทันทีแบบตัดภาพ — สว่างวาบ/มืดวาบในพริบตา โดยเฉพาะกับธีมที่ต่างกันมาก

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) `applyTheme()` :1478-1490 — พลิก
  `data-theme` ทันทีโดยไม่มี transition ใด ๆ ห่อไว้
- `src/renderer/style.css` — ไม่มี token ระยะเวลา และไม่มี rule transition
  สำหรับการสลับธีมเลย (transition ที่มีเป็นของ hover ปุ่มเท่านั้น)

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/style.css:96` — token `--duration-theme: 250ms`
- `grok-desktop/src/renderer/style.css:5689-5705` — rule `html.theme-switching …`
  transition `background-color/color/border-color/box-shadow` บน shell surfaces
  พร้อม `!important` ให้ชนะ transition เฉพาะ element ช่วงสลับ
- `grok-desktop/src/renderer/app.js:7642-7656` — `applyTheme()` ใส่ class
  `theme-switching` ที่ `<html>` แล้วถอดหลัง 280ms
- `grok-desktop/src/renderer/style.css:5765-5777` — ทางหนีภายใต้
  prefers-reduced-motion: `transition: none !important` ทั้งกลุ่ม

## วิธีแก้ไข

- `src/renderer/style.css`
  - token `--duration-theme: 250ms` ในบล็อก base (ไม่ใช่สี ไม่เข้า contrast
    audit; ค่าเดียวใช้ทุกธีม)
  - rule `html.theme-switching` ครอบ shell surfaces ของ kimi (body, #app,
    #sidebar, #main, .side-head, .side-foot, #chat-head, .transcript,
    .composer, .pop, .jump-latest) transition สี 4 คุณสมบัติแบบ grok
  - เพิ่ม escape `transition: none !important` ของ selector ชุดเดียวกันในบล็อก
    `@media (prefers-reduced-motion: reduce)` เดิม
- `src/renderer/app.js` — `applyTheme()` ใส่ `theme-switching` ก่อนพลิก
  `data-theme` และถอดหลัง 280ms (timer ตัวเดียว ยกเลิกตัวเก่าก่อนตั้งใหม่ —
  กดสลับรัว ๆ ไม่ค้าง); listener OS-flip ผ่าน applyTheme จึง crossfade ด้วย
- class `theme-switching` ถูกใช้จริงใน app.js ทำให้ผ่าน reduced-motion guard
  ของ css-guards (BUG-061) โดยไม่ต้องแก้อะไรเพิ่ม

## ไฟล์ที่เปลี่ยน

- `src/renderer/style.css` — token + rule crossfade + reduced-motion escape
- `src/renderer/app.js` — theme-switching class + timer ใน applyTheme
- `src/renderer/index.html` — bump `?v=` 0.4.38 → 0.4.39 (ทุก ref)

## การทดสอบ

- `npm test` เขียวทุก suite (18 suites: unit 17 + e2e 38/38) รวม css-guards
  (balance ของ rule ใหม่, class ใน reduced-motion block มีจริง)
- ตรวจด้วยมือ: สลับ Moonlight ↔ Claude Light จากเมนู → สีไหลนุ่ม ~250ms;
  เปิด Reduce Motion แล้วสลับ → ตัดทันทีเหมือนเดิม

## วิธี revert

```
git log --grep='\[BUG-062\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
