# BUG-015 — event ที่ผูกกับเทิร์นไม่เคย bind turnId (หน้าต่างที่พลาด turn_started เห็นว่างทั้งเทิร์น)

ความรุนแรง: CRITICAL

## อาการที่ผู้ใช้เห็น

reload หน้าต่าง (หรือเปิดหน้าต่างที่สอง) กลางเทิร์นที่ agent กำลังสตรีม:
SSE ยังส่ง message_delta / tool_call / plan เข้ามาตลอด แต่หน้าจอไม่แสดง
อะไรเลย — ไม่มี spinner, ไม่มีปุ่ม Stop, ไม่มีข้อความที่ไหลอยู่ — แล้วคำตอบ
ก็ "ปรากฏทีเดียว" ตอน turn_done กด Send ระหว่างนั้นเจอ 409 โดยไม่มีสาเหตุบอก

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้, case `message_delta` :440, `tool_call` :452,
  `plan` :463, `interaction` :470) — ทุก event ที่ผูกกับเทิร์นมี `data.turnId`
  จาก server (`src/server/sessions.js:856,917,925`) แต่ renderer ไม่เคยเก็บ
  turnId นั้นไว้ — `paintLiveTurn()` bail เมื่อ `!tv.turnId` (:292) และ
  `isRunning()` เป็น false ตลอด → chrome ไม่เคยตื่น
- `src/server/sessions.js` (ก่อนแก้, `_onPermission`) — payload ของ
  `interaction` ไม่มี turnId เลย ทั้ง ๆ ที่เป็น event ที่ผูกกับเทิร์น
  (การ์ด permission มักมาเป็น event แรกของเทิร์น — หน้าต่างที่พลาด
  turn_started จึงไม่เห็นแม้แต่การ์ดขออนุญาต)

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/turn-view.js:179-184` — `maybeBindTurnId()` bind
  turnId จาก scoped event แรกที่เห็น
- `grok-desktop/src/renderer/turn-view.js:672-691` — delta แรกเปิดเทิร์นได้
  เองเมื่อ wire ส่ง turnId มา (missed local begin)

## วิธีแก้ไข

- สร้าง `src/renderer/turn-view.js` (pure module ไม่แตะ DOM — ทดสอบใน Node
  ได้): `createTurnView()` กับ `bindTurnId(tv, data)` ที่คืน
  `'open' | 'ok' | 'drop'` — bind turnId เมื่อ view ยังว่าง (หรือเป็น
  placeholder `'pending'` จากการ rehydrate การ์ด permission), ทิ้ง frame
  ที่ turnId ไม่ตรงกับเทิร์น live (frame ค้างจากเทิร์นที่ถูกแทนที่)
- `app.js` — ทุก case ที่ผูกกับเทิร์น (`message_delta`, `tool_call`,
  `tool_call_update`, `plan`, `interaction`) เรียก `bindTurnId` ก่อน;
  เมื่อ bind เพิ่งเปิดเทิร์น (`'open'`) สั่ง `updateRunningChrome()` ทันที
  เพื่อให้ spinner/ปุ่ม Stop โผล่ แม้แชทนั้นไม่ใช่แชทที่กำลังเปิด
- `src/server/sessions.js` — `_onPermission` ใส่ `turnId` ของเทิร์น live
  ลงใน payload ของ `interaction` ให้เหมือน event อื่น

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — ใหม่: `createTurnView`, `bindTurnId`
- `src/renderer/app.js` — scoped cases bind turnId; `turnView()` ใช้ factory
- `src/server/sessions.js` — `interaction` payload มี `turnId`
- `src/renderer/index.html` — bump `?v=` 0.4.0/0.4.1 → 0.4.2 (ทุก ref เท่ากัน)
- `scripts/unit-test-turn-view.mjs` — ใหม่, 6 tests; wire เข้า
  `scripts/unit-test-all.mjs`
- `scripts/e2e-mock-agent.mjs` — assert interaction มี turnId ตรงกับเทิร์น +
  case ใหม่: stream ที่ connect หลัง turn_started ยังได้ scoped events ที่
  bind ได้ และ cancel จากสถานะนั้นใช้งานได้

## การทดสอบ

- `node scripts/unit-test-turn-view.mjs` — 6/6 ผ่าน
- `node scripts/unit-test-turn-core.mjs` — 34/34 ผ่าน
- `node scripts/e2e-mock-agent.mjs` — 29/29 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-015\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
