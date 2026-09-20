# BUG-078 — version badge ค้างที่ 0.4.0 ตลอด ไม่เปลี่ยนตามงานที่ทำ

ความรุนแรง: minor (ผู้ใช้รายงานจากการใช้งานจริง)

## อาการที่ผู้ใช้เห็น

badge เลข version ใน sidebar แสดง `v0.4.0` ตลอด ทั้งที่มีงานแก้/เพิ่มฟีเจอร์
เข้าไปแล้วหลายสิบบั๊ก — ดูเหมือนแอปไม่เคยอัปเดต (ทั้งที่ cache-bust token
ของ renderer เดินไปถึง 0.4.48 แล้ว)

## สาเหตุ (file:line)

- badge `#version-badge` (`src/renderer/index.html:36`) ถูก paint โดย
  `version-boot.js` จาก `GET /api/version` → `pkg.version`
  (`src/server/index.js:206-207`) — เลขมาจาก `package.json` ซึ่งยังเป็น
  `0.4.0` ไม่เคยถูก bump ตั้งแต่ BUG-001 ถึง BUG-077
- รากจริง: convention ใน AGENTS.md สั่ง bump เฉพาะ `?v=` token ของ
  index.html — ไม่มีอะไรผูก `package.json` version เข้ากับ token นั้น เลข
  จึงแยกทางกันเงียบ ๆ (badge แสดงเลขที่ "ซื่อสัตย์" แต่เก่า)

## วิธีแก้ไข

1. **`package.json` + `package-lock.json`**: bump version 0.4.0 → 0.4.48
   (ตรงกับ `?v=` token ปัจจุบัน — เลขเดียว ความหมายเดียว) ด้วย
   `npm version 0.4.48 --no-git-tag-version`
2. **guard ถาวรกัน drift**: เพิ่ม check ข้อ 7 ใน
   `scripts/unit-test-css-guards.mjs` — parse `?v=` token จาก index.html
   (วิธีเดียวกับ check ข้อ 4) แล้ว assert ว่าเท่ากับ `package.json` version;
   รันใน `npm test` และ fail ทันทีที่เลขแยกทางกัน (อัปเดต header comment
   ของไฟล์ด้วย)
3. **อัปเดต convention**: AGENTS.md หัวข้อ conventions — กฎ bump `?v=` เดิม
   ถูกเขียนใหม่เป็น "token ใน index.html กับ package.json version เป็นเลข
   เดียวกัน ต้อง bump คู่กัน" พร้อมบอกเหตุ (badge จะโกหกถ้าแยกทาง)
4. ตรวจจุดอื่นที่ hardcode/แสดง version แล้ว: ทุกจุดไหลจาก package.json อยู่
   แล้ว (`scripts/mac-launch.sh:93` อ่านตอน build bundle, `/api/version`,
   `/api/debug`, version-boot) — `?v=0.4.0` ที่ค้างใน import ของ module ที่
   ไม่ได้แก้ (scroll-pin/composer-draft/ฯลฯ) เป็น per-module cache token คนละ
   กลไกกับเลข version แอป ไม่แตะ; CHANGELOG.md เป็นบันทึกประวัติ ไม่แตะ

## ไฟล์ที่เปลี่ยน

- `package.json` / `package-lock.json` — version 0.4.0 → 0.4.48
- `scripts/unit-test-css-guards.mjs` — check ข้อ 7 + header comment
- `AGENTS.md` — convention บรรทัด bump ให้ครอบคลุม package.json

## การทดสอบ

- `node scripts/unit-test-css-guards.mjs` → 13/13 (รวม guard ใหม่
  "package.json version matches the shared ?v= token (BUG-078)")
- `npm test` เขียวครบ 21 suites (e2e 38/38)
- หลัง deploy ตรวจ live: `npm run deploy:status` รายงาน version 0.4.48 และ
  `curl -s http://127.0.0.1:3849/api/version` ตอบ 0.4.48 — badge ในแอปจะ
  แสดงเลขเดียวกันหลัง reload

## วิธี revert

```bash
git log --grep='\[BUG-078\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
