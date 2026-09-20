# BUG-070 — ไม่มี notranslate guard กัน Chrome translate banner

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

เมื่อเปิด UI ผ่าน default browser (host ทำ `open <url>` เมื่อไม่ได้ตั้ง
NO_OPEN — `src/server/index.js:474-476`) หน้าแอปมี `lang="th"` แต่เนื้อหา
ปนอังกฤษ/ไทย Chrome จะเด้ง translate banner แทรก chrome ของตัวเองเข้ามาใน
หน้าต่างแอป บางทีแปล DOM ทับทำ renderer state เพี้ยน

## สาเหตุ (file:line)

- `src/renderer/index.html:2` — `<html lang="th">` ไม่มี `translate="no"` /
  `class="notranslate"` และไม่มี meta notranslate ใน `<head>`

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/index.html:2` — `<html lang="th" translate="no"
  class="notranslate">`
- `grok-desktop/src/renderer/index.html:5-7` — comment +
  `<meta name="google" content="notranslate">` +
  `<meta name="googlebot" content="notranslate">`

## วิธีแก้ไข

- เพิ่ม `translate="no"` และ `class="notranslate"` บน `<html>` (คง
  `lang="th"` และ `data-theme="moonlight"` ไว้ครบ)
- เพิ่ม meta `google`/`googlebot` notranslate หลัง charset พร้อม comment
  อธิบายเหตุ
- ขยาย `scripts/unit-test-css-guards.mjs` (shell-contract assertions ของ
  BUG-061) เพิ่ม 1 เคสปักทั้ง 4 ชิ้น — ถอดอันหนึ่งออก guard fail ทันที

ไม่ bump `?v=` — เปลี่ยนเฉพาะ index.html (เสิร์ฟ no-store เสมอ) ไม่ได้แตะ
app.js/style.css

## ไฟล์ที่เปลี่ยน

- `src/renderer/index.html` — attribute + class + meta ×2
- `scripts/unit-test-css-guards.mjs` — เพิ่ม 1 เคส (รวม 11 เคส)

## การทดสอบ

- `node scripts/unit-test-css-guards.mjs` → 11/11
- `npm test` เขียว 19 suites — e2e 38/38
- ระหว่างแก้เผลอตัด `data-theme="moonlight"` หลุดจาก `<html>` — guard
  reduced-motion/boot-order ไม่จับได้ แต่ตรวจด้วยตาแล้วใส่คืนก่อน commit;
  เป็นบทเรียนว่า attribute บน `<html>` ยังไม่มี guard — เคสใหม่นี้ช่วยปิด
  ส่วนที่เกี่ยวกับ notranslate แล้ว

## วิธี revert

```bash
git log --grep='\[BUG-070\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
