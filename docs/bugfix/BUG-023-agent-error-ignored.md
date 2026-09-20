# BUG-023 — SSE `agent_error` ถูก subscribe ไว้แต่ไม่มี handler (หน้าต่างอื่นไม่รู้ว่า agent spawn ไม่ขึ้น)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

agent process พัง (binary หาย / handshake ล้มเหลว / frame เพี้ยน): หน้าต่าง
ที่เพิ่ง reload หรือหน้าต่างที่สองไม่เคยรู้ว่า agent ตาย — pill ยังดูปกติ,
ไม่มี notice ใน transcript; ผู้ใช้พิมพ์ต่อทั้งที่ agent ใช้ไม่ได้

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) — `connectStream()` subscribe
  `'agent_error'` (:560) แต่ `onEvent()` ไม่มี case รองรับ — ตก default
  (:542-543) เงียบ ๆ ทั้งที่ server bridge client 'error' → SSE ไว้แล้ว
  (`src/server/sessions.js:417-419`)

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/sessions.js:3564` — start failure ถูก emit ผ่าน
  SSE เพื่อให้ **ทุก** window ที่ attach อยู่วาด error ได้ ไม่ใช่แค่หน้าต่าง
  ที่สั่ง prompt

## วิธีแก้ไข

- `src/renderer/app.js` — เพิ่ม `case 'agent_error'`: ถ้าเป็นแชท active →
  `setAgentState('errored')` (pill "error" แบบเดียวกับสถานะ errored อื่น) +
  `showError()` วาด notice ภาษาไทยใน transcript; ทุกแชท → `refreshChats()`
  ให้ sidebar สะท้อนสถานะ (ไม่วาด notice ให้แชทที่ไม่ active เพราะ transcript
  บนจอเป็นของแชท active)
- หมายเหตุตอนเขียน test: `resolveKimiBin()` ตกไปหา binary จริงเมื่อ KIMI_BIN
  ชี้ไฟล์ที่ไม่มีอยู่ (acp-client.js:111-136) — e2e จึงใช้ไฟล์ที่ "มีแต่ exec
  ไม่ได้" (mode 0644 → spawn EACCES) แทน

## ไฟล์ที่เปลี่ยน

- `src/renderer/app.js` — case `agent_error`
- `src/renderer/index.html` — bump `?v=` 0.4.9 → 0.4.10
- `scripts/e2e-mock-agent.mjs` — `startHost()` รับ `kimiBin` override + host
  ที่สามกับ binary ที่ exec ไม่ได้: prompt → ต้องเห็น `agent_error` ที่ scoped
  ด้วย chatId และมี message (ไม่ await HTTP response ของ prompt เพราะ
  handshake กับ binary ที่ตายอาจค้างจน timeout ของมันเอง)

## การทดสอบ

- `node scripts/e2e-mock-agent.mjs` — 34/34 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-023\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
