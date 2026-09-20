# BUG-032 — การ์ดที่ตอบแล้วไม่บันทึกว่าเลือกอะไร (เทา ๆ ปุ่มตายหมด)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

หลังตอบการ์ดขออนุญาต/คำถาม การ์ดค้างอยู่ในสถานะเทาและปุ่ม disabled ทุกปุ่ม
โดยไม่มีสัญญาณใด ๆ ว่าเมื่อกี้เลือกตัวไหน — ย้อนอ่านไม่ได้ว่าเคยอนุญาตหรือ
ปฏิเสธ

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) — `interaction_resolved` handler ตั้งแค่
  `ix.resolved = true` ทิ้ง `data.optionId` ที่ server ส่งมาให้
  (`sessions.js:989` emit `{ id, optionId }` อยู่แล้ว) และ paintLiveTurn
  ทำแค่ใส่ class `.resolved` + disable ปุ่ม

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:8925-8937` — resolve แล้ว dismount การ์ด
  ทิ้ง (ทางเลือกอีกแบบ); kimi เลือกเก็บการ์ดไว้ตาม flow เดิม จึงต้องบันทึก
  คำตอบบนการ์ดแทน

## วิธีแก้ไข

- `src/renderer/app.js` —
  - `interaction_resolved`: เก็บ `ix.optionId = data.optionId` ไว้ใน turn view
  - `paintLiveTurn()` resolved branch: หาปุ่มที่ `data-option-id` ตรงกับ
    `ix.optionId` แล้วใส่ class `.chosen` + ต่อท้าย label ด้วย
    "✓ เลือกแล้ว" (กัน append ซ้ำด้วย class check); ปุ่มอื่นยังเทาตาม
    `.resolved` เดิม — ถ้า optionId ไม่ match ปุ่มไหน (เช่น reject อัตโนมัติ
    จาก timeout/settle ที่ id ไม่ตรง) การ์ดก็แค่เทาเหมือนเดิม ไม่พัง
- `src/renderer/style.css` — `.ix-card.resolved button.chosen`: outline
  `--accent-line` + ตัวหนา (outline เป็น decorative ไม่ต้องเพิ่ม colour pair;
  ข้อมูลอยู่ที่ข้อความ ✓)

ขอบเขต: server เก็บ `pendingInteractions` ใน memory และลบทิ้งตอน resolve —
transcript ที่ persist ไม่มีบันทึก interaction ดังนั้นสถานะ "เลือกแล้ว" แสดง
ได้เฉพาะ live session (หลัง reload การ์ดที่ resolve แล้วไม่ถูก rehydrate
อยู่แล้ว — มีแค่การ์ดที่ยังค้างตอบ)

## ไฟล์ที่เปลี่ยน

- `src/renderer/app.js` — เก็บ optionId + ทำเครื่องหมายปุ่มที่เลือก
- `src/renderer/style.css` — `.chosen`
- `src/renderer/index.html` — bump `?v=` 0.4.18 → 0.4.19
- `scripts/e2e-mock-agent.mjs` — assert interaction_resolved มี optionId

## การทดสอบ

- e2e: resolve การ์ดด้วย `approve_once` → event `interaction_resolved` ต้อง
  ถือ `optionId: 'approve_once'` กลับมา (สัญญาฝั่ง wire ที่ renderer ใช้ทำ
  เครื่องหมาย; การไฮไลต์ DOM จริงทดสอบไม่ได้ใน harness)
- `npm test` เขียวทุก suite (e2e 37/37)

## วิธี revert

```
git log --grep='\[BUG-032\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
