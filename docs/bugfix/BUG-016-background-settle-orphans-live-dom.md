# BUG-016 — turn_done ของแชทพื้นหลังทำ live DOM ของแชทที่กำลังดูกลายเป็น orphan

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

เปิดแชท A ที่กำลังสตรีมอยู่ ขณะที่แชท B (พื้นหลัง) จบเทิร์นของมัน: ข้อความ
ที่สตรีมอยู่ในแชท A "ค้าง" ไว้กลางจอ แล้วสตรีมต่อเนื่องถูกวาดเป็น bubble
ใหม่แยกลงมาข้างล่าง — เห็นข้อความตอนต้นซ้ำสองก้อน (ก้อนแช่แข็ง + ก้อนที่ยัง
ไหลต่อ)

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้, case `turn_done`/`turn_error` ~:488-500) —
  handler สั่ง `liveWrap = null; liveText = null;` **โดยไม่เช็ก chatId** —
  เมื่อ event เป็นของแชทพื้นหลัง node `.live-turn` ของแชทที่กำลังดูยังต่อ
  อยู่กับ DOM แต่ถูกตัดการอ้างอิง; delta ถัดไปของแชท active เข้าเงื่อนไข
  `!liveWrap` ที่ :299-304 จึงสร้าง live wrap ที่สอง

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:6883-6886` — terminal event ของแชทที่ไม่
  active ทำแค่ bump epoch + อัปเดตปุ่ม stop — ไม่แตะ pointer ของ live DOM
  ของแชท active เลย

## วิธีแก้ไข

- ย้าย `liveWrap = null; liveText = null;` เข้าไปใน branch
  `chatId === state.activeId` เท่านั้น — เทิร์นที่จบของแชทอื่นอัปเดตแค่
  running chrome/sidebar (`updateRunningChrome()` + `refreshChats()` ยัง
  ทำงานเหมือนเดิมสำหรับทุกแชท)

## ไฟล์ที่เปลี่ยน

- `src/renderer/app.js` — guard การ deref live nodes ด้วย active chatId
- `src/renderer/index.html` — bump `?v=` 0.4.2 → 0.4.3
- `scripts/e2e-mock-agent.mjs` — +1 case: แชท A สตรีมช้า + แชท B จบเร็ว
  กลางสตรีมของ A — wire ต้อง scope chatId ถูกตลอด (turn_done ของ B มี chatId
  ของ B, delta ของ A ไหลต่อหลัง B settle) — นี่คือ contract ที่ renderer
  พึ่งพา; การ assert ระดับ DOM (live wrap เดียว) ทำใน harness นี้ไม่ได้เพราะ
  ไม่มี browser

## การทดสอบ

- `node scripts/e2e-mock-agent.mjs` — 30/30 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-016\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
