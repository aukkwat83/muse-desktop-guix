# BUG-017 — เทิร์นที่ error/ถูกยกเลิกไม่ทิ้งร่องรองใน live path (ไม่มี marker "หยุดโดยผู้ใช้")

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

- กด Stop (Esc) กลางเทิร์น: ถ้า agent ยังไม่พิมพ์อะไรเลย หน้าจอกลับมาเงียบ
  เหมือนไม่เคยมีเทิร์น — ไม่มีบรรทัดบอกว่าเทิร์นถูกหยุด
- ถ้าเทิร์น error กลางทาง: ข้อความที่สตรีมค้างไว้ดูเหมือนคำตอบปกติจนกว่า
  transcript จะ reload — ไม่มี error row บอกว่าเทิร์นพัง

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้, case `turn_done`/`turn_error`) — handler
  เมิน `data.reason` และ `data.error` ที่ server ส่งมาใน terminal frame
  (`src/server/sessions.js:701-709` — settleTurn emit `{turnId, reason,
  content, error, ...}`) ทั้ง ๆ ที่ server persist ข้อมูลนี้ไว้แล้วหลัง
  BUG-005 (notice message + `meta.reason` บน assistant message)

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:6917-6932` — ตอน error วาด final answer +
  error bubble; ตอน cancel วาด interrupted marker
- `grok-desktop/src/renderer/transcript-model.js:168-176` —
  `interruptedMarkerText()` แยก label "หยุดโดยผู้ใช้" vs "ระบบหยุดให้
  (watchdog)" เพื่อไม่ให้ผู้ใช้เข้าใจว่าตัวเองเป็นคนกด

## วิธีแก้ไข

- `src/renderer/turn-view.js` — เพิ่ม `interruptedMarkerText(reason)` (pure,
  Thai UI strings เดียวกับ grok)
- `src/renderer/app.js`:
  - `interruptedMarkerNode(reason)` สร้าง `div.turn-interrupted-marker`
  - terminal handler (เฉพาะแชท active): `reason === 'cancelled'/'watchdog'`
    → วาด marker ใต้ live turn ทันที; `data.error` → `showError()` วาด
    error row ภาษาไทย (`เทิร์นจบแบบไม่สำเร็จ: …` — ข้อความเดียวกับ notice
    ที่ server persist) ก่อน transcript reload
  - `messageNode()` — assistant message ที่มี `meta.reason` เป็น
    cancelled/watchdog วาด marker ท้ายข้อความเสมอ → marker **คงอยู่ข้าม
    reload** เพราะ render จากข้อมูลที่ persist (live paint เป็นแค่ของชั่วคราว
    จนกว่า reload จะมาแทนด้วยสำเนาจาก server — ไม่ซ้ำกันเพราะ
    `renderTranscript()` ล้างทั้งก้อน)
- `src/renderer/style.css` — `.turn-interrupted-marker` (muted, centered,
  small; ใช้ token `--muted` ที่มี audit อยู่แล้ว ไม่เพิ่ม colour pair)

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `interruptedMarkerText()`
- `src/renderer/app.js` — marker node, live paint ใน terminal handler,
  durable marker ใน `messageNode()`
- `src/renderer/style.css` — `.turn-interrupted-marker`
- `src/renderer/index.html` — bump `?v=` 0.4.3 → 0.4.4
- `scripts/unit-test-turn-view.mjs` — +1 test (label แยก user/watchdog)
- `scripts/e2e-mock-agent.mjs` — cancel step: assert partial text + `meta.reason
  === 'cancelled'` persist; +1 case: prompt "boom" → `turn_error` มี error
  message และ transcript มี notice ที่ persist

## การทดสอบ

- `node scripts/unit-test-turn-view.mjs` — 7/7 ผ่าน
- `node scripts/unit-test-theme-contrast.mjs` — ผ่าน (ไม่มี pair ใหม่)
- `node scripts/e2e-mock-agent.mjs` — 31/31 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-017\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
