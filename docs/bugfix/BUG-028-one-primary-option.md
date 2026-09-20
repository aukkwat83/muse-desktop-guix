# BUG-028 — ปุ่มตัวเลือกทุกปุ่มที่ไม่ใช่ reject ถูกแต่งเป็น primary

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

การ์ดขออนุญาตมีปุ่ม primary (สีเด่น) หลายปุ่มพร้อมกัน: ชุด canonical ทั้ง
"Approve once" และ "Approve for this session" ดูเด่นเท่ากัน; การ์ด
AskUserQuestion มีคำตอบ N ปุ่มก็เด่นทั้ง N ปุ่ม — ผู้ใช้ไม่รู้ว่าปุ่มไหนคือ
action หลัก

## สาเหตุ (file:line)

- `src/renderer/app.js:260` (ก่อนแก้) — เงื่อนไข `/reject|deny/i.test(
  opt.optionId) ? 'btn' : 'btn primary'`: ทุกปุ่มที่ไม่ใช่ reject ได้ primary
  หมด

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:8196-8198` — primary เดียวต่อการ์ด:
  Allow once ธรรมดา / **Allow always primary** / Deny ธรรมดา

## วิธีแก้ไข

- `src/renderer/turn-view.js` — เพิ่ม pure helper `ixPrimaryOptionId(options)`:
  เลือก `allow_always` ถ้ามี ไม่งั้นตัวเลือก allow ตัวแรก; reject/skip ไม่มี
  วันเป็น primary — ใช้ `kind` ที่ server map มาให้ผ่าน
  `extractPermissionOptions()` (hosts.js) เป็นหลัก สะกด optionId เดิม
  (`allow-always` ฯลฯ) เป็น fallback สำหรับ agent เก่า/ลิสต์ default
- `src/renderer/app.js` — `interactionNode()` ให้ class `btn primary` เฉพาะ
  ปุ่มที่ optionId ตรงกับ `ixPrimaryOptionId(options)`

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `ixPrimaryOptionId()`
- `src/renderer/app.js` — เงื่อนไข class ปุ่ม; import token `turn-view.js`
  0.4.11 → 0.4.12
- `src/renderer/index.html` — bump `?v=` 0.4.14 → 0.4.15
- `scripts/unit-test-turn-view.mjs` — เคส helper

## การทดสอบ

- unit (`turn-view`): canonical options → approve_always; ชุด q0_opt_*
  → ตัวแรกเท่านั้นและ q0_skip ไม่ใช่ primary; ชุด plan_* → plan_approve;
  ลิสต์ไม่มี kind → ใช้สะกด id; all-reject/ว่าง → null
- `npm test` เขียวทุก suite (การแต่งปุ่มเป็น DOM visual — harness ไม่มี
  browser; helper ที่ตัดสินถูก unit-test ครบ)

## วิธี revert

```
git log --grep='\[BUG-028\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
