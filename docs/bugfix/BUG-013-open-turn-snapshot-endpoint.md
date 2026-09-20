# BUG-013 — ไม่มี endpoint สำหรับดูเทิร์นที่กำลังรัน (reload กลางเทิร์นเห็นพื้นที่ live ว่างเปล่า)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

reload หน้าต่างกลางเทิร์นที่ agent กำลังสตรีม: transcript ที่ persist ไว้โหลด
ขึ้นมา แต่ข้อความ/tool rows/plan ที่กำลังไหลอยู่ (ยังไม่ settle) หายไปทั้งหมด
เพราะไม่มีทางดึง state ของเทิร์นที่กำลังรันผ่าน HTTP ได้เลย — renderer เห็น
พื้นที่ live ว่างเปล่าจนกว่าเทิร์นจะจบ (การ hydrate ฝั่ง renderer เป็นงานของ
Batch 3 — commit นี้ทำเฉพาะฝั่ง server)

## สาเหตุ (file:line)

- `src/server/sessions.js:100-103` (ก่อนแก้) — `chatSummary` เปิดเผยแค่
  `running` + `turnId`; `turn.text`/`toolCalls`/`plan`/`startedAt` ของเทิร์นที่
  กำลังรันไม่มี route ไหนเข้าถึงได้

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/sessions.js:843-872` — `SessionManager.getTurn()`
  serialize เทิร์นที่กำลังรัน → `{turnId, startedAt, partial, activityOpen,
  pendingInteraction}`
- `grok-desktop/src/server/index.js:922-923` — route `GET /api/sessions/:id/turn`

## วิธีแก้ไข

- `SessionManager.getTurn(chatId)` — คืน `null` ถ้าไม่รู้จัก chat; คืน
  `{ turn: null }` ถ้าไม่มีเทิร์น live; ไม่งั้นคืน `{ turn: { turnId,
  startedAt, partial, tools, plan, pendingInteractions } }` (pending
  interactions ดึงจาก store กลางตาม chatId — การ์ดที่ mount อยู่คือส่วนหนึ่ง
  ของสแนปช็อตเทิร์น)
- route `GET /api/chats/:id/turn` ใน `index.js` ตาม style เดิมของ router:
  404 `chat not found` เมื่อไม่รู้จัก chat, 404 `no live turn` เมื่อไม่มี
  เทิร์นที่กำลังรัน, 200 + `{ ok, turn }` ระหว่างรัน

## ไฟล์ที่เปลี่ยน

- `src/server/sessions.js` — `getTurn()`
- `src/server/index.js` — route `GET /api/chats/:id/turn`
- `scripts/unit-test-turn-core.mjs` — +1 test: snapshot กลางเทิร์นมี partial +
  tool ที่ยัง open + interaction ที่ mount อยู่; หลัง settle → `turn: null`;
  chat ที่ไม่มีจริง → null
- `scripts/e2e-mock-agent.mjs` — +1 E2E case: กลางเทิร์น permission (การ์ด
  mount ค้างไว้) GET ได้ 200 พร้อม snapshot; ตอบการ์ดแล้ว settle → GET ได้ 404

## การทดสอบ

- `node scripts/unit-test-turn-core.mjs` — 32/32 ผ่าน
- `node scripts/e2e-mock-agent.mjs` — 27/27 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-013\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
