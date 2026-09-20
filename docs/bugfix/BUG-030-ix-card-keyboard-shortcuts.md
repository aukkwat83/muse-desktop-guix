# BUG-030 — การ์ดขออนุญาตไม่มี keyboard shortcut

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

การ์ดขออนุญาต/คำถามตอบได้ด้วยเมาส์เท่านั้น — กดตัวเลขหรือ Esc ไม่มีผล
(ใน grok-desktop กด 1/2/3 เลือกตัวเลือกและ Esc ปฏิเสธได้)

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) — document keydown handler มีแค่ Esc →
  stopTurn และ ⌘N — ไม่มี binding สำหรับการ์ด interaction เลย

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:8867-8908` — `handlePermissionKey()` /
  `handlePlanKey()`: เลข 1..N เลือกตัวเลือก, Esc ปฏิเสธ, ไม่แย่งปุ่มขณะ
  พิมพ์ใน textarea

## วิธีแก้ไข

- `src/renderer/turn-view.js` — เพิ่ม pure helper `ixKeyToOptionId(options,
  key)`: `'1'..'9'` เลือกตามตำแหน่ง, `'Escape'` เลือกตัวเลือกฝั่ง reject/skip
  (ดู `kind` ก่อน แล้วค่อยสะกด optionId); คืน null สำหรับปุ่มที่ไม่ map —
  และคืน null สำหรับ Esc เมื่อการ์ดไม่มีตัวเลือก reject เลย เพื่อไม่กลืน Esc
  ที่ global handler ใช้หยุดเทิร์น
- `src/renderer/app.js` —
  - keydown handler ใหม่ (ก่อน Esc→stopTurn เดิม): ทำงานเฉพาะเมื่อแชทที่กำลัง
    ดูมีการ์ดที่ยังไม่ resolved และ focus ไม่ได้อยู่ใน input/textarea ใด ๆ
    (composer, ช่อง rename ใน sidebar) และไม่มี modifier; map ปุ่มแล้ว
    `.click()` ปุ่มจริงในการ์ด — เส้นทาง submit เดียวกับเมาส์เป๊ะ (รวมถึง
    BUG-025 re-arm และกัน double-submit)
  - ปุ่มในการ์ดมี `data-option-id` ให้ค้นหา; ลิสต์ fallback ย้ายไปเป็น
    `DEFAULT_IX_OPTIONS` กลาง เพื่อให้ shortcut กับปุ่มบนการ์ดชุดเดียวกันเสมอ

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `ixKeyToOptionId()`
- `src/renderer/app.js` — keydown handler + `data-option-id` +
  `DEFAULT_IX_OPTIONS`; import token `turn-view.js` 0.4.13 → 0.4.14
- `src/renderer/index.html` — bump `?v=` 0.4.16 → 0.4.17
- `scripts/unit-test-turn-view.mjs` — เคส key→option mapping

## การทดสอบ

- unit (`turn-view`): เลขตามตำแหน่ง (canonical + q0_opt_*), Esc → reject/
  q0_skip/reject-once, ปุ่มนอกขอบ (9/0/ตัวอักษร) → null, การ์ดไม่มี reject →
  Esc ไม่ถูกกลืน, options ว่าง/undefined → null
- `npm test` เขียวทุก suite (พฤติกรรม keydown เป็น DOM-level — harness ไม่มี
  browser; ตัว map ถูก unit-test ครบ)

## วิธี revert

```
git log --grep='\[BUG-030\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
