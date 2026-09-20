# BUG-007 — settleTurn ปิดการ์ดขออนุญาตฝั่ง UI แต่ agent ยังค้างรอคำตอบ (dead interaction cleanup)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

เทิร์นที่ถูก settle ขณะมีการ์ดขออนุญาตค้างอยู่ (เช่น watchdog hard cap ตัดเทิร์น)
UI แสดงว่าการ์ดถูก reject แล้ว แต่ agent ยัง park อยู่บน `session/request_permission`
ต่อไปอีกจนกว่า timeout 5 นาทีของ AcpClient จะทำงาน — เทิร์นดูเหมือนจบแล้ว
แต่ agent ไม่ไปต่อ

## สาเหตุ (file:line)

- `src/server/sessions.js:559-565` (ก่อนแก้) — `settleTurn` เรียก
  `p.resolve?.('reject')` แต่ entries ใน `pendingInteractions` มี shape เป็น
  `{chatId, payload}` (ดู `sessions.js:794`) ไม่มี `resolve` — เป็น dead code;
  waiter ตัวจริงอยู่ที่ `AcpClient._permWaiters` (`src/server/acp-client.js:183-196`)
- `src/server/sessions.js:375-380` (ก่อนแก้) — `releaseClient` มี dead shape
  เดียวกัน (`p.reject?.(...)`)

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/sessions.js:1718-1756` — `resolvePermission` ให้
  `pendingInteraction` เป็น metadata เท่านั้น แล้ว resolve waiter จริงผ่าน
  `client.resolvePermission(permId, optionId)`

## วิธีแก้ไข

- ใน `settleTurn` loop ปิด pending interactions: เรียก
  `slot.client?.resolvePermission(id, 'reject')` (guard client ด้วย `?.`) แทน
  `p.resolve?.()` ที่ไม่มีอยู่จริง — agent ที่ค้างบน permission RPC จึงได้
  'reject' ทันทีที่เทิร์นถูก settle
- `releaseClient`: ลบ `p.reject?.()` แล้ว reject ผ่าน `slot.client?.resolvePermission`
  ก่อน shutdown client (shutdown เองก็ reject waiters ผ่าน `_onProcExit`
  อยู่แล้ว แต่นี่คือการแจ้งให้เร็วและชัดเจนกว่า)

## ไฟล์ที่เปลี่ยน

- `src/server/sessions.js` — `settleTurn` + `releaseClient` reject ผ่าน waiter จริง
- `scripts/unit-test-turn-core.mjs` — +1 test: settle ขณะมี interaction →
  waiter ของ `AcpClient` จริงได้รับ 'reject' และถูก consume

## การทดสอบ

- `node scripts/unit-test-turn-core.mjs` — 28/28 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-007\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
