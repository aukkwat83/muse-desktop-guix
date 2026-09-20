# BUG-004 — แถว tool ที่ค้างอยู่ไม่ถูกปิดตอนจบเทิร์น (pending/in_progress อยู่ใน transcript ตลอดกาล)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

เทิร์นที่จบแล้ว (โดยเฉพาะ cancel กลางคัน หรือ error) ยังแสดงแถว tool เป็นสถานะ
`pending`/`in_progress` ค้างไว้ — หลัง reload transcript แถวเหล่านั้นก็ยังดูเหมือน
กำลังรันอยู่ ทั้งที่เทิร์นจบไปแล้ว

## สาเหตุ (file:line)

- `src/server/sessions.js:466-518` (ก่อนแก้) — `settleTurn` persist
  `[...turn.toolCalls.values()]` ตามสถานะเดิมทุกประการ และส่งชุดเดียวกันออก
  wire `turn_done`/`turn_error`; tool ที่ยังไม่ได้ `tool_call_update` ปลายทาง
  (เช่นโดน cancel ก่อนจบ) จึงค้าง `pending`/`in_progress` ใน transcript

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/turn-view.js:230-241` — ตอน turn_done ปิดแถว tool
  ที่ยัง open ตาม stop reason: cancelled → `cancelled`, error → `failed`,
  อื่น ๆ → `completed`
- `grok-desktop/src/server/sessions.js:1253-1261` — ฝั่ง server ทำแบบเดียวกันกับ
  activity items ก่อน emit

## วิธีแก้ไข

- ปิดสถานะ tool ที่ยัง open **ภายใน `SessionManager.settleTurn()`** (funnel เดียว
  ตาม AGENTS.md) ก่อนขั้นตอน persist/emit ทั้งหมด: map สถานะ
  `pending`/`in_progress`/`running` ตามเหตุจบเทิร์น —
  - `done`/จบปกติ → `completed` (ปกติ tool ควร completed อยู่แล้ว ตัวที่ค้างเข้าข่าย interrupted แต่เทิร์นจบดี)
  - `error` → `failed`
  - `cancelled`/`watchdog` → `cancelled`
- ทำก่อนสร้าง finalText/persist และก่อน `wire.emit` ทำให้ทั้ง transcript บนดิสก์
  และ payload สดบน SSE ได้สถานะปลายทางชุดเดียวกัน

## ไฟล์ที่เปลี่ยน

- `src/server/sessions.js` — block ปิดสถานะ tool ใน `settleTurn`
- `scripts/unit-test-turn-core.mjs` — +2 tests: ปิดสถานะทั้งใน persist และใน
  wire payload; mapping ตาม stop reason (error→failed, cancelled→cancelled,
  watchdog→cancelled)

## การทดสอบ

- `node scripts/unit-test-turn-core.mjs` — 24/24 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-004\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
