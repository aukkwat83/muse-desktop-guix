# BUG-021 — ปุ่ม Stop ไม่มีสถานะ "กำลังหยุด" (fire-and-forget, double-Esc ยิง cancel ซ้ำ)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

กด Stop (หรือ Esc) แล้วปุ่มยังเป็น "■" กดได้เหมือนเดิมจนกว่า turn_done จะมา —
ไม่มี feedback ว่าคำขอ cancel ถูกส่งไปแล้ว; ผู้ใช้กด Esc รัว ๆ เพราะคิดว่า
ไม่ติด ทำให้ cancel ซ้ำหลายครั้ง

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้, `stopTurn()` ~:853-855) — fire-and-forget:
  POST /cancel แล้วลืม; ไม่มี state "cancel อยู่ระหว่างทาง" ใน turn view และ
  `updateRunningChrome()` ไม่มีสาขาสำหรับสถานะนั้น

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/turn-view.js:335-341` — `setCancelInFlight()`
  เก็บ `cancelInFlight` ใน store
- `grok-desktop/src/renderer/turn-view.js:1052-1063` — `composerMorph()` คืน
  `{ role: 'stop', cancelling }` → ปุ่ม morph เป็น disabled "กำลังหยุด…"

## วิธีแก้ไข

- `stopTurn()` — ตั้ง `tv.cancelling = true` แล้ว `updateRunningChrome()`
  ทันที; ถ้ามี flag อยู่แล้ว return (กัน double-cancel); ถ้า POST ไม่ถึง host
  (network ล่ม) คืน flag เพราะเทิร์นยังรันอยู่ — ส่วน settle ปกติ flag ถูก
  เคลียร์พร้อมทั้ง view เมื่อ terminal event ลบ `turnViews[chatId]`
  (ครอบแชทที่ไม่ active ด้วยโดยอัตโนมัติ)
- `updateRunningChrome()` — เมื่อ cancelling: ปุ่มเป็น "…", `disabled`,
  title "กำลังหยุด…" (สไตล์ disabled มีอยู่แล้วที่ `.btn.send:disabled`
  style.css:1240 — ไม่ต้องเพิ่ม CSS)
- `turn_started` handler reset `tv.cancelling = false` เป็นสุขาภิบาล (view
  ที่เหลือจาก placeholder 'pending' อาจอุด flag เก่า)

## ไฟล์ที่เปลี่ยน

- `src/renderer/app.js` — stopTurn guard + flag, chrome morph, reset ตอนเปิดเทิร์น
- `src/renderer/index.html` — bump `?v=` 0.4.7 → 0.4.8

## การทดสอบ

- `npm test` — เขียวทุก suite (9 suites; e2e 33/33) — การ morph ปุ่มเป็น DOM
  behavior ที่ harness ไม่มี browser ให้ทดสอบ; state flag อยู่ใน
  `createTurnView()` ที่ unit test ครอบแล้ว (เริ่มต้น false เสมอ)
- ไม่แตะ turn timing จึงไม่เพิ่ม E2E case (ตามเกณฑ์ AGENTS.md)

## วิธี revert

```
git log --grep='\[BUG-021\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
