# BUG-020 — selectChat/reload ไม่ hydrate เทิร์นที่กำลังรัน (spinner/Stop/ข้อความที่ไหลอยู่หายหมด)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

reload หน้าต่าง (หรือสลับไปแชทอื่นแล้วกลับมา) กลางเทิร์นที่กำลังสตรีม:
transcript ที่ persist ไว้ขึ้นมา แต่ไม่มี spinner, ไม่มีปุ่ม Stop, ไม่มี
ข้อความ/tool rows/plan ที่สตรีมไปแล้ว — และถ้าพิมพ์ส่งต่อจะเจอ 409 ทั้งที่
หน้าจอดู "ว่าง" (BUG-015 ทำให้ delta ถัดไปเปิดเทิร์นได้ แต่ระหว่าง agent
เงียบ — เช่นกำลังรัน tool นาน — ก็ยังไม่มีอะไรแสดงเลย)

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้, `selectChat()` ~:791-835) — rehydrate เฉพาะ
  `pendingInteractions`; `chatSummary` ให้แค่ `running` + `turnId` — ไม่มี
 โค้ดไหนดึง `GET /api/chats/:id/turn` (endpoint จาก BUG-013) มา seed
  `state.turnViews[chatId]` เลย

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:6682-6711` — `resyncSessionTurn()`:
  GET snapshot → `turnStore.reset()` แล้ว overlay
- `grok-desktop/src/renderer/app.js:6620-6674` — `overlayLiveTurnFromStore()`
  วาด partial stream + tool rows + plan ทับ transcript หลัง history paint

## วิธีแก้ไข

- `src/renderer/turn-view.js` — เพิ่ม `seedTurnView(tv, snapshot)` (pure):
  - turnId ต่างกัน = view เก่าค้าง → server ชนะ แทนที่ทั้งก้อน
  - turnId เดียวกัน/ยังว่าง/เป็น placeholder `'pending'` → เติมเฉพาะที่ขาด
    หรือเก่ากว่า: `partial` เป็น running total ฝั่ง server ดังนั้น snapshot
    ที่สั้นกว่า text ที่ SSE paint ไปแล้ว ห้ามเขียนทับ (กัน regression จาก
    race ระหว่าง fetch กับ delta ที่เข้าคั่น)
- `src/renderer/app.js` — `hydrateTurnView(chatId)` fetch
  `GET /api/chats/:id/turn` (เงียบเมื่อ 404/ไม่มีเทิร์น) แล้ว seed;
  `selectChat()` เรียกเมื่อ `chat.running` ก่อน `renderTranscript()` —
  partial answer + tool rows + plan + permission cards จึงขึ้นทันที และ
  `updateRunningChrome()` เริ่ม spinner/Stop/elapsed จาก `startedAt` ของ
  server; `boot()` กับ `resyncFromServer()` (BUG-011) ได้ hydrate อัตโนมัติ
  เพราะทั้งคู่จบที่ `selectChat()`

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `seedTurnView()`
- `src/renderer/app.js` — `hydrateTurnView()` + เรียกจาก `selectChat()`
- `src/renderer/index.html` — bump `?v=` 0.4.6 → 0.4.7
- `scripts/unit-test-turn-view.mjs` — +4 tests (เติม view ว่าง / ไม่ regress
  state ที่ใหม่กว่า / upgrade 'pending' / adopt เทิร์นใหม่ทั้งก้อน / snapshot
  ว่างเป็น no-op)
- `scripts/e2e-mock-agent.mjs` — +1 case: กลางเทิร์น "slow tool" GET /turn
  ต้องมี turnId + startedAt + partial ที่ไม่ว่าง + tool row ที่ยังเปิดอยู่

## การทดสอบ

- `node scripts/unit-test-turn-view.mjs` — 15/15 ผ่าน
- `node scripts/e2e-mock-agent.mjs` — 33/33 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-020\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
