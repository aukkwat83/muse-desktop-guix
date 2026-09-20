# BUG-010 — back-pressure flag เป็น dead code (ทุก frame buffer บน socket หมด)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

client ที่ช้า (แท็บที่ถูก background, สลีปจอ, เครือข่ายอืด) ทำ host สะสมทุก SSE
frame ใน kernel/userland buffer ของ socket โดยไม่มีการจำกัด — สตรีมยาว ๆ บน
client ที่ไม่กลืน = memory บวมใน host process และไม่มีทางลดภาระ

## สาเหตุ (file:line)

- `src/server/sse-wire.js:119-126` (ก่อนแก้) — `_writeTo` set
  `entry.backpressure = true` เมื่อ `res.write()` คืน false แต่ **ไม่มีโค้ด
  ส่วนไหนอ่าน flag นี้เลย**; `isTerminal()` (`sse-wire.js:25-35`) จึงเป็น
  เพียง decoration — ทุก frame ยัง write เข้า socket buffer เหมือนเดิมทุกประการ

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/sse-wire.js:132-177` — `writeSseFrame` /
  `flushSseCoalesce`: เมื่อ backed up → coalesce หมวด delta (latest ต่อ
  chatId), drop หมวด chatter, force-write หมวด NEVER_DROP, แล้ว flush coalesce
  map ตอน `drain`

## วิธีแก้ไข

เพิ่มพฤติกรรมจริงให้ `_writeTo` เมื่อ `entry.backpressure` เปิดอยู่:

- `message_delta`/`thought_delta` → coalesce: เก็บเฉพาะ frame ล่าสุดต่อ
  chatId ใน `entry.coalesce` — **lossless** เพราะ payload แบก running-total
  `text` (BUG-009) ข้าม frame กลางไม่เสียตัวอักษร
- `agent_stderr`/`agent_update_other` → drop ทิ้งตรง ๆ
- terminal (`isTerminal`) และ frame ต้องส่งอื่น ๆ → flush coalesce ก่อนแล้ว
  force-write — frame ที่ค้างใน coalesce เก่ากว่า ห้ามถูกแซงบน wire
- `drain` → `_flushCoalesce` เขียน frame ที่ coalesce ไว้ทั้งหมด; `write()`
  ที่คืน false ยังรับข้อมูลเข้า userland buffer (ลำดับคงไว้) จึงไม่มีการ
  re-queue ที่ทำให้ frame ซ้ำ — flag คลายเมื่อ flush สำเร็จครบ

## ไฟล์ที่เปลี่ยน

- `src/server/sse-wire.js` — `isCoalescible`/`isDroppable` + `_writeTo`
  แยก force path + `_writeFrame` (arm drain listener ครั้งเดียว) +
  `_flushCoalesce` (drain handler)
- `scripts/unit-test-sse-wire.mjs` — fakeRes อ่าน `writeReturns` จาก instance
  (เปลี่ยนค่ากลาง test ได้) + 2 tests: coalesce/drop/force+ordering ผ่าน fake
  res ที่ write() คืน false แล้วยิง drain; ไม่มี frame ซ้ำ/หายข้าม drain

## การทดสอบ

- `node scripts/unit-test-sse-wire.mjs` — 12/12 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-010\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
