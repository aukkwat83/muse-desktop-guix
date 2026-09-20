# BUG-011 — replay cursor ที่ถูก evict ไม่มีสัญญาณบอก client (spinner ค้างจน reload)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

หน้าต่างที่หลุดการเชื่อมต่อนาน (สลีปเครื่อง, แท็บ background ข้ามคืน) แล้ว
reconnect: host replay ได้เฉพาะ event ที่ยังอยู่ใน ring ขนาด 2000 — ถ้า
`turn_done`/`interaction` ของเทิร์นที่จบไปแล้วถูก evict หลุดไป client จะไม่มี
วันรู้ว่าเทิร์นจบแล้ว — spinner หมุนค้างจนกว่าจะสั่ง reload ทั้งหน้าเอง

## สาเหตุ (file:line)

- `src/server/sse-wire.js:63-68` (ก่อนแก้) — `addClient` replay เฉพาะ
  `ev.id > since` จาก ring เท่าที่มีอยู่ โดยไม่เช็คว่า cursor ของ client
  อยู่ "ก่อน" frame เก่าสุดใน ring หรือไม่ — gap ที่ evict ไปแล้วถูกเมินเงียบ ๆ

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/sse-wire.js:76-99` — `resolveReplay()` คืน
  `{mode:'resync'}` เมื่อ cursor ต่ำกว่า min id ของ ring
- `grok-desktop/src/server/index.js:529-534` — เขียน synthetic `resync` frame
  ด้วย id จริง (`sseRing.nextId++`) แต่ไม่เก็บลง ring เพื่อให้ cursor ของ
  client ขยับพ้น gap
- `grok-desktop/src/renderer/app.js:7399-7408` — renderer รับ `resync` แล้ว
  refetch snapshot

## วิธีแก้ไข

- server (`sse-wire.js` `addClient`): ถ้า `since < seq` และ ring ว่างหรือ
  `ring[0].id > since + 1` → cursor ถูก evict ⇒ เขียน frame `resync` แบบ
  unstored พร้อม `id: ++this.seq` แทนการ replay; cursor อยู่ใน ring → replay
  ปกติเหมือนเดิม
- renderer (`app.js`): เพิ่ม `'resync'` ใน EventSource types + case ใหม่ที่เรียก
  `resyncFromServer()` — reuse fetch ตอน boot: `refreshChats()` +
  `/api/interactions` + `selectChat(activeId)`; และเพราะ `turn_done` ที่หลุดไป
  ใน gap คืออาการ spinner ค้าง จึงลบ `turnViews` ของ chat ที่ server ยืนยันว่า
  `running: false` ก่อน refetch (hydration เต็มรูปแบบเป็นงานของ Batch 3)
- bump `?v=` ของ `app.js` ตาม AGENTS.md

## ไฟล์ที่เปลี่ยน

- `src/server/sse-wire.js` — resync detection + synthetic frame ใน `addClient`
- `src/renderer/app.js` — `case 'resync'` + `resyncFromServer()`
- `src/renderer/index.html` — `app.js?v=0.4.1`
- `scripts/unit-test-sse-wire.mjs` — +2 tests: cursor ที่ถูก evict ได้ resync
  frame ครั้งเดียวพร้อม id ที่เดินหน้า (และไม่ถูกเก็บลง ring); cursor ที่ยังอยู่
  ใน ring replay ปกติไม่มี resync

## การทดสอบ

- `node scripts/unit-test-sse-wire.mjs` — 14/14 ผ่าน
- `node --input-type=module --check < src/renderer/app.js` — ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-011\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
