# BUG-071 — ไม่มี debug page / endpoint สำหรับดูสุขภาพ host

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ไม่มีหน้า diagnostic เลย: เมื่อ UI เพี้ยน (SSE หลุด? เทิร์นค้าง? agent ตาย?)
ไม่มีที่ให้เปิดดู counters ของ host และไม่มีทาง smoke test endpoints จากใน
เบราว์เซอร์ — ดีบั๊กต้องเดาจาก log อย่างเดียว

## สาเหตุ (file:line)

- ไม่มี `src/renderer/debug.html` และไม่มี route `/api/debug*` ใน
  `src/server/index.js`

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/debug.html` (248 บรรทัด) — live counters +
  in-browser API smoke
- `grok-desktop/src/server/index.js:345-359` — `/api/debug` และ
  `/api/debug/stream`

## วิธีแก้ไข

พอร์ตแบบ lean ปรับให้เข้ากับสถาปัตยกรรม kimi — รายงานเฉพาะ counter ที่มีจริง
(grok มี debug log ring ของตัวเอง ซึ่ง kimi ไม่มี จึงไม่พอร์ตมา):

1. **`src/server/debug-info.js`** (ใหม่): `debugSnapshot()` เป็น pure
   function — pid/port/host/version/name/uptime/stateDir + `sse`
   (clients, seq, ring size/max, min/max id — มองเห็น replay-cursor eviction
   แบบ BUG-011) + `sessions.stats()` (chats/groups/hot/running/maxHot/
   pendingInteractions) — แยกเป็น module เองเพื่อให้ unit test ได้โดยไม่ต้อง
   boot host
2. **`src/server/index.js`**: เพิ่ม 2 route —
   `GET /api/debug` ตอบ snapshot ครั้งเดียว; `GET /api/debug/stream` เป็น SSE
   แยกจาก SseWire โดยเด็ดขาด (snapshot ทุก 2s, ไม่เขียนเข้า ring, ไม่กิน
   client slot — tap สำหรับดีบั๊กห้ามไปรบกวนสายที่มันดูอยู่) และเคลียร์
   interval เมื่อ client ปิด
3. **`src/renderer/debug.html` + `debug.js`** (ใหม่): หน้า counters สดจาก
   stream (fallback poll 2s เมื่อ stream ใช้ไม่ได้) + ปุ่ม "รัน API smoke"
   ที่ยิง GET `/api/version` `/api/state` `/api/chats` `/api/groups`
   `/api/memory` `/api/debug` พร้อม status/เวลา — style inline ในไฟล์เดียว
   แต่ script แยกไฟล์เพราะ CSP `script-src 'self'`; **ไม่ลิงก์จาก UI ไหน**
   เข้าด้วย URL ตรง `/debug.html` เท่านั้น (เหมือน grok)
4. **`scripts/unit-test-debug-info.mjs`** (ใหม่, 5 เคส): identity fields,
   ring ว่าง (min/max null), seq+id bounds หลัง emit, eviction ขยับ minId,
   stats() passthrough — ลงทะเบียนใน `unit-test-all.mjs` (รวม 20 suites)

## ไฟล์ที่เปลี่ยน

- `src/server/debug-info.js` — ไฟล์ใหม่
- `src/server/index.js` — import + 2 routes
- `src/renderer/debug.html` / `src/renderer/debug.js` — ไฟล์ใหม่
- `scripts/unit-test-debug-info.mjs` — ไฟล์ใหม่
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite

## การทดสอบ

- `node scripts/unit-test-debug-info.mjs` → 5/5; `npm test` เขียว 20 suites
- ทดสอบจริงกับ host บนพอร์ต scratch (3895, state dir ชั่วคราว): `/api/debug`
  ตอบ payload ครบทุก field; `/debug.html` และ `/debug.js` เสิร์ฟ 200;
  `/api/debug/stream` ส่ง `hello` + `snapshot` frame จริง; ปิด host ด้วย
  HTTP shutdown แล้วลบ state ชั่วคราว
- ข้อจำกัด: ตัวหน้าเว็บ render จริงในเบราว์เซอร์ไม่ได้เปิดดูจากสภาพแวดล้อมนี้
  — ตรวจได้แค่ asset ถูกเสิร์ฟและ JS ผ่าน `node --check`

## วิธี revert

```bash
git log --grep='\[BUG-071\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
