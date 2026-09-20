# BUG-043 — restore draft หลัง await fetch → แฟลชข้อความแชทเก่า + draft รั่วข้ามแชท

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

สลับแชทแล้วเห็นข้อความที่พิมพ์ค้างของแชทก่อนหน้าแฟลชอยู่ในกล่อง composer
ชั่วครู่ ระหว่างที่รอ fetch แชทใหม่ ถ้าพิมพ์ต่อในช่องเวลานั้น ข้อความ (ทั้งของ
เก่าและที่เพิ่งพิมพ์) จะถูกบันทึกเป็น draft ของแชท**ใหม่** ถาวร — พิมพ์ค้างใน
แชท A แล้วสลับไปแชท B ข้อความของ A ติดไปโผล่ใน B ทุกครั้งที่เปิด B

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) `selectChat()`:
  - บันทึก draft ของแชทเก่าที่ :935-937 และตั้ง `state.activeId = chatId` ที่ :939
  - แต่ restore draft ของแชทใหม่ (`el.prompt.value = state.drafts.get(chatId)`)
    อยู่ที่ :977-978 — **หลัง** `await api('/api/chats/:id')` ที่ :950
  - ช่องว่างระหว่าง set activeId กับ restore: textarea ยังแสดงข้อความแชทเก่า และ
    input listener ที่ :1144-1147 ผูก draft เข้ากับ `state.activeId` (แชทใหม่แล้ว)
    จึงเขียนข้อความเก่าทับ draft ของแชทใหม่

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:5782-5784` — `syncComposerDraftForSession(id)`
  ถูกเรียกใน `selectSession()` **ก่อน** `await api.selectSession(id)` ที่ :5798
  (comment: "before any await — avoids flash of the previous session's typed text")
- `grok-desktop/src/renderer/composer-draft.js:176-219` — binder semantics:
  `sync(next, currentText)` ถ้า next === bound เดิมจะ `changed:false` และ
  **ไม่แตะ** textarea; ต่างกันค่อย save ของเก่า + restore ของใหม่

## วิธีแก้ไข

- `selectChat()` จำ `prevId` ไว้, save draft ของแชทเก่าเหมือนเดิม, แล้วทันทีหลัง
  `state.activeId = chatId` (ก่อน await ใด ๆ) ตั้ง
  `el.prompt.value = state.drafts.get(chatId) || ''` + `autoGrow()`
- เคส reselect แชทเดิม (`chatId === prevId` — เช่น turn_done keepScroll, เปลี่ยน cwd)
  ข้าม restore ตาม binder semantics ของ grok: textarea แสดงของแชทนี้อยู่แล้ว การ
  เขียนทับมีแต่จะกลืนค่าที่ถูก restore แบบ programmatic (เช่น path 409 ของ
  submitPrompt ที่ไม่ผ่าน input event)
- ลบ assignment เดิมที่อยู่หลัง await (เดิม :977-978) ออก
- ผลข้างเคียงที่ถูกต้อง: path `!chatId` (deselect) ตอนนี้ล้าง composer ด้วย
  (`drafts.get(null) → ''`) แทนที่จะทิ้งข้อความแชทเก่าค้างไว้

## ไฟล์ที่เปลี่ยน

- `src/renderer/app.js` — `selectChat()` ย้าย draft restore ขึ้นก่อน fetch
- `src/renderer/index.html` — bump `?v=` 0.4.21 → 0.4.22

## การทดสอบ

- `npm test` เขียวทุก suite (logic เป็นการจัดลำดับใน event handler ที่ผูก DOM —
  ไม่มี pure logic ใหม่ให้แยกทดสอบ; e2e ไม่เกี่ยวกับ turn timing)
- ตรวจด้วยมือ: เปิดเซิร์ฟเวอร์จริง พิมพ์ค้างในแชท A → คลิกแชท B → composer
  เปลี่ยนเป็นค่าของ B (หรือว่าง) ทันทีในเฟรมเดียวกับคลิก ไม่มีแฟลชของ A

## วิธี revert

```
git log --grep='\[BUG-043\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
