# BUG-001 — การ์ดขออนุญาตว่างเปล่าเมื่อใช้ agent จริง (ผู้ใช้ต้องกดอนุญาตแบบไม่เห็นคำสั่ง)

ความรุนแรง: CRITICAL

## อาการที่ผู้ใช้เห็น

เมื่อรันกับ `kimi acp` ตัวจริง การ์ดขออนุญาตขึ้นเพียง "ขออนุญาตใช้ Bash"
โดยไม่มีคำสั่งหรือ diff ให้ดูก่อนตัดสินใจ — ผู้ใช้ต้องกดอนุญาต/ปฏิเสธโดยไม่รู้ว่า
agent จะทำอะไร (blind approval)

## สาเหตุ (file:line)

- `src/server/hosts.js:127-136` (ก่อนแก้) — `requestPermission` สร้าง `summary`
  เฉพาะจาก `toolCall.rawInput || toolCall.input || params.input` เท่านั้น
- CLI จริงไม่ส่ง field เหล่านั้นมาใน permission request เลย รายละเอียดอยู่ใน
  `toolCall.content` แทน: text block `"Requesting approval to <action>"`
  บวก diff block `{type:'diff', path, oldText, newText}` อันแรก (กรณี Edit/Write)
- ตรวจสอบกับ CLI ที่ติดตั้งจริง: `@moonshot-ai/kimi-code` `dist/main.mjs`
  ฟังก์ชัน `buildPermissionToolCallUpdate` (บรรทัด ~341987) คืน
  `{ toolCallId, title: toolName, content: [diff?, text] }` — ไม่มี `rawInput`/`kind`

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:8169-8172` — การ์ด permission ของ grok
  render `info.summary` ที่ CLI ของมันใส่มาให้ใน `rawInput` อยู่แล้ว
  (CLI ของ grok กับ kimi ส่ง shape ต่างกัน จึงพอร์ตตรง ๆ ไม่ได้)

## วิธีแก้ไข

- เพิ่ม `permissionSummary(toolCall, params)` ใน `src/server/hosts.js`:
  ดึง text จาก `toolCall.content` ก่อน — block ที่เป็น `{type:'diff'}` แปลงเป็น
  headline แบบอ่านรู้เรื่อง (path + บรรทัด `-old`/`+new`) ผ่าน helper ใหม่
  `formatDiffPreview()`; ถ้า content ไม่มีอะไรใช้ได้ ค่อย fallback ไปที่
  `rawInput`/`input` เหมือนเดิม (mock รุ่นเก่าและ agent อื่นยังใช้ได้)
- ไม่แตะ renderer — การ์ดมีช่อง `ix.summary` อยู่แล้ว แค่ server ส่งข้อความมาให้

## ไฟล์ที่เปลี่ยน

- `src/server/hosts.js` — เพิ่ม `contentBlockText()`, `formatDiffPreview()`,
  `permissionSummary()` และเปลี่ยน `requestPermission` ให้ใช้ `permissionSummary`
- `scripts/unit-test-permission-host.mjs` — suite ใหม่ (wire shape จริง:
  content text + ไม่มี rawInput, กรณี diff headline, fallback rawInput)
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite `permission-host` ใน SUITES

## การทดสอบ

- `node scripts/unit-test-permission-host.mjs` — 5/5 ผ่าน
  (shape จริงจาก CLI, diff headline, fallback rawInput, กรณีว่าง, formatDiffPreview)
- `npm test` — เขียวทั้ง 8 suites

## วิธี revert

```
git log --grep='\[BUG-001\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
