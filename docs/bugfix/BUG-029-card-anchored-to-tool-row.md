# BUG-029 — การ์ดขออนุญาตไม่ยึดกับแถว tool ที่มาขอ (ตกท้ายเทิร์นเสมอ)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

การ์ดขออนุญาตถูกต่อท้าย live wrap เสมอ แม้ tool ที่กำลังขออนุญาตจะมีแถว
ของตัวเองอยู่ใน transcript แล้ว — ผู้ใช้ต้องจับคู่เองว่าการ์ดนี้เป็นของ
คำสั่งไหน โดยเฉพาะเทิร์นที่มีหลาย tool

## สาเหตุ (file:line)

- `src/server/sessions.js` (ก่อนแก้) — interaction payload ไม่มี `toolCallId`
  ทั้งที่ wire ให้มา (`params.toolCall.toolCallId` รูปแบบ `${turnId}:${rawId}`
  เดียวกับ id ของ tool row ที่สตรีม)
- `src/renderer/app.js` (ก่อนแก้) — `paintLiveTurn()` append การ์ดตาม
  `liveChildOrder()` (ไว้ท้ายสุด) โดยไม่มีข้อมูลจะยึดกับแถว tool

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:7956-7968` — `pendingToolCallId()` ดึง
  toolCallId จาก payload
- `grok-desktop/src/renderer/app.js:7975-7998` — `findIxMountPoint()` แทรก
  การ์ดหลัง `.activity-row[data-tool-id]` ที่ตรงกัน ไม่งั้นค่อยตกท้ายเทิร์น

## วิธีแก้ไข

- `src/server/hosts.js` — `requestPermission()` ส่ง `toolCallId` (จาก
  `toolCall.toolCallId` / `tool_call_id`) ใน `onRequest`
- `src/server/acp-client.js` + `src/server/sessions.js` — plumb `toolCallId`
  ผ่าน `permission` event → interaction payload (SSE + `GET /api/interactions`
  + snapshot `GET /turn` ได้ไปด้วย เพราะใช้ payload เดียวกัน)
- `src/renderer/turn-view.js` — pure helper `ixAnchorKey(tv, ix)`: คืน key
  `tool:<id>` เมื่อแถวนั้นอยู่ใน turn view, ไม่งั้น null
- `src/renderer/app.js` — ordering pass ของ `paintLiveTurn()`: การ์ดที่มี
  anchor ถูกแทรกหลังแถว tool ของมัน (`anchor.after(node)`); map
  `anchoredAfter` กันการ์ดหลายใบที่ยึดแถวเดียวกันเรียงกลับ; การ์ดที่ไม่มี
  anchor (เช่น rehydrate หลัง reload ที่แถว tool ไปอยู่ใน history แล้ว)
  ใช้ตำแหน่งเดิมตาม `liveChildOrder()`
- mock agent: flow "ask" สตรีม `tool_call` (tc-perm-1, in_progress) ก่อน
  request_permission แล้วปิดด้วย `tool_call_update` ตามคำตอบ — ตรง wire จริง
  และทำให้ e2e พิสูจน์ได้ว่า id ตรงกัน

## ไฟล์ที่เปลี่ยน

- `src/server/hosts.js` — `toolCallId` ใน onRequest
- `src/server/acp-client.js` — emit `toolCallId`
- `src/server/sessions.js` — payload มี `toolCallId`
- `src/renderer/turn-view.js` — `ixAnchorKey()`
- `src/renderer/app.js` — anchor pass; import token `turn-view.js`
  0.4.12 → 0.4.13
- `src/renderer/index.html` — bump `?v=` 0.4.15 → 0.4.16
- `scripts/mock-acp-agent.mjs` — tool row รอบ permission
- `scripts/unit-test-turn-view.mjs` — เคส `ixAnchorKey`
- `scripts/e2e-mock-agent.mjs` — assert toolCallId + แถว tool คู่กัน

## การทดสอบ

- unit (`turn-view`): `ixAnchorKey` คืน key เมื่อแถวอยู่ใน view; null เมื่อ
  ไม่รู้จัก id / ไม่มี toolCallId / view ว่าง
- e2e: interaction payload มี `toolCallId: 'tc-perm-1'` และมี tool_call event
  id เดียวกันในเทิร์นเดียวกัน (การแทรก DOM จริงทดสอบไม่ได้ — ไม่มี browser)
- `npm test` เขียวทุก suite (e2e 37/37)

## วิธี revert

```
git log --grep='\[BUG-029\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
