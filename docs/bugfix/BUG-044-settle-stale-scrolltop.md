# BUG-044 — turn_done reload คืนค่า scrollTop เก่าทับ layout ใหม่

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

หลังเทิร์นจบ (turn_done) หน้าจอกระโดดไปตำแหน่งมั่ว ๆ กลาง transcript —
ผู้ใช้ที่กำลังตามอ่านท้ายสตรีมถูกดึงขึ้นไปกลางเนื้อ หรือผู้ที่เลื่อนอ่านข้างบน
อยู่ถูกย้ายไปจุดที่ไม่ใช่จุดเดิม เพราะเนื้อหาถูก merge/เรนเดอร์ใหม่ทั้งก้อน

## สาเหตุ (file:line)

- `src/renderer/app.js` `selectChat()` (ก่อนแก้):
  - :938 จับ `el.transcript.scrollTop` เป็น**ค่าพิกเซลสัมบูรณ์**ก่อน await fetch
  - :980 หลัง `renderTranscript()` สร้าง DOM ใหม่ทั้งหมดแล้ว เอาค่าเดิมมาทับ
    (`if (keepScroll) el.transcript.scrollTop = scrollTop`) — ความสูงเนื้อหา
    เปลี่ยนแล้ว (final message ถูก merge, tool output ครบ, marker ถูก persist)
    ค่าพิกเซลเดิมจึงชี้ไปเนื้อหาคนละจุด
  - อีกด้วย: `renderTranscript()` scroll ลงล่างสุดเสมอ (:360) แม้ผู้ใช้กำลัง
    อ่านข้างบน — แล้วค่าทับที่ว่าก็ผิดอยู่ดี

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:6912,6929,6949` — settle path ทั้งสาม
  (cancelled / error / done) เรียก `scrollChatToBottom(true)` re-pin ลงล่างสุด
  ไม่มีการคืนค่าพิกเซลเก่า
- `grok-desktop/src/renderer/app.js:4526-4538` — `loadOlderHistory()` ที่ต้อง
  รักษาตำแหน่งจริง ๆ จะจับ `distBottom = scrollHeight - scrollTop -
  clientHeight` ก่อน paint แล้วคืนด้วยระยะห่างจากก้นเดิม
  (`scrollTop = scrollHeight - clientHeight - distBottom`)

## วิธีแก้ไข

ใน keepScroll path ของ `selectChat()`:

- ก่อน fetch: จับ `keepDistBottom = scrollHeight - clientHeight - scrollTop`
  (เฉพาะเมื่อ keepScroll) แทนการจับ scrollTop ดิบ
- หลัง `renderTranscript()`:
  - ถ้า `state.pinned` (ผู้ใช้ตามท้ายสตรีมอยู่) → `scrollToBottom(true)`
    re-pin ลงล่างสุด ตาม settle path ของ grok
  - ถ้าไม่ pinned → คืน `scrollTop = scrollHeight - clientHeight -
    keepDistBottom` (clamp ที่ 0) ด้วยระยะห่างจากก้นเท่าเดิม

ครอบคลุมทั้ง turn_done settle (:700 เรียก `selectChat(chatId, {keepScroll:true})`)
และ `resyncFromServer()` ที่ใช้ path เดียวกัน

## ไฟล์ที่เปลี่ยน

- `src/renderer/app.js` — `selectChat()` เปลี่ยน keepScroll จาก absolute
  scrollTop เป็น pinned / distance-from-bottom
- `src/renderer/index.html` — bump `?v=` 0.4.22 → 0.4.23

## การทดสอบ

- `npm test` เขียวทุก suite (รวม e2e 37/37 ที่ครอบ turn settle → transcript
  reload) — ตัวเลข scroll ผูกกับ layout จริงใน WKWebView จึงไม่มี pure logic
  ให้แยก unit; พฤติกรรม settle ยังผ่าน e2e เดิมทุกเคส
- ตรวจด้วยมือ: เลื่อนขึ้นไปกลางประวัติแล้วรอเทิร์นจบ — ตำแหน่งคงเดิมเทียบจาก
  ก้น; อยู่ล่างสุดแล้วรอเทิร์นจบ — ยังติดก้น

## วิธี revert

```
git log --grep='\[BUG-044\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
