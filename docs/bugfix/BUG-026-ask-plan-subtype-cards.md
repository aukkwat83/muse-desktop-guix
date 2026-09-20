# BUG-026 — AskUserQuestion / ExitPlanMode เรนเดอร์เป็นการ์ดขออนุญาตเปล่า ๆ

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

เมื่อ agent ถามคำถาม (AskUserQuestion) หรือขออนุมัติแผน (ExitPlanMode)
ผู้ใช้เห็นการ์ดชื่อ "ขออนุญาตใช้ AskUserQuestion" / "ขออนุญาตใช้ ExitPlanMode"
เท่านั้น — เนื้อคำถามหรือเนื้อแผน (markdown) ที่อยู่ใน `toolCall.content`
ไม่ถูกแสดงเลย ผู้ใช้ต้องตอบโดยไม่รู้ว่ากำลังตอบอะไร

## สาเหตุ (file:line)

- `src/server/hosts.js` — `requestPermission()` ส่งแค่ `toolName` (จาก
  `toolCall.title`) + `summary` (ตัดที่ 240 ตัวอักษร) ให้ UI — ไม่มี field
  บอกว่าการ์ดนี้เป็นคำถาม/แผน และไม่มี body เต็ม
- `src/renderer/app.js:238` (ก่อนแก้) — หัวการ์ด hardcode `ขออนุญาตใช้
  ${ix.toolName}` และแสดงเฉพาะ `ix.summary` แบบ monospace chip

Wire จริง (verify กับ `@moonshot-ai/kimi-code` dist/main.mjs):
- AskUserQuestion: `toolCall = { toolCallId, title: "AskUserQuestion",
  content: [{type:'content', content:{type:'text', text: <คำถาม>}] } }`,
  options `q0_opt_N` (kind `allow_once`, name = label เต็ม) + `q0_skip`
  (kind `reject_once`)
- ExitPlanMode (plan_review): content = [plan markdown, "Requesting approval
  to exit plan mode"], options `plan_approve` / `plan_revise` /
  `plan_reject_and_exit` (หรือ `plan_opt_N` ถ้าแผนมีตัวเลือกย่อย)

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:8291-8410` — `buildAskCard()` การ์ดคำถาม
  เฉพาะทาง (หัว "ถามสั้นๆ" + body + actions)
- `grok-desktop/src/renderer/app.js:8203-8289` — `buildPlanCard()` เรนเดอร์
  plan body เป็น markdown (`ix-plan-md`) + หัว "Plan ready — อนุมัติได้ไหม?"

## วิธีแก้ไข

- `src/server/hosts.js` — เพิ่ม `permissionSubtype(toolName)`
  (`AskUserQuestion`→`ask`, `ExitPlanMode`→`plan`, match แบบตรงตัวพิมพ์)
  และ `permissionBody(toolCall)` — ข้อความเต็มจาก content blocks (cap 8000;
  `permissionSummary()` ยังเป็น headline 240 เหมือนเดิม — refactor walk ร่วม
  กันเป็น `contentText(toolCall, cap)`); ส่ง `subtype` + `body` เฉพาะการ์ด
  subtype ใน `onRequest`
- `src/server/acp-client.js` + `src/server/sessions.js` — plumb
  `subtype`/`body` ผ่าน `permission` event → interaction payload (SSE)
- `src/renderer/app.js` — `interactionNode()`: การ์ด subtype ได้หัวเฉพาะ
  ("agent มีคำถาม" / "แผนพร้อมแล้ว — อนุมัติได้ไหม?") + `card.dataset.ixSubtype`
  และเรนเดอร์ `ix.body` เป็น markdown (`renderMarkdown` + `decorateCodeBlocks`
  ตัวเดียวกับคำตอบ agent) แทน summary chip; การ์ดธรรมดาเหมือนเดิม
- `src/renderer/style.css` — `.ix-body` (กล่อง scroll ในการ์ด; สไตล์ markdown
   reuse จาก `.msg-assistant` ไม่เพิ่ม colour pair ใหม่)
- mock agent เพิ่ม trigger `quiz` / `exitplan` ตาม wire shape จริงข้างบน

ข้อจำกัดของโปรโตคอล (บันทึกไว้ตามโจทย์): grok มีช่อง feedback ให้ขอแก้แผน
ได้ แต่ wire ของ kimi **ไม่มีช่องส่งข้อความ feedback** — เลือกได้แค่
plan_approve / plan_revise / plan_reject_and_exit จึงไม่สร้าง textarea

## ไฟล์ที่เปลี่ยน

- `src/server/hosts.js` — `permissionSubtype()` + `permissionBody()` +
  refactor `contentText()`
- `src/server/acp-client.js` — emit `subtype`/`body`
- `src/server/sessions.js` — payload มี `subtype`/`body`
- `src/renderer/app.js` — หัวการ์ด + body markdown ตาม subtype
- `src/renderer/style.css` — `.ix-body`
- `src/renderer/index.html` — bump `?v=` 0.4.12 → 0.4.13
- `scripts/mock-acp-agent.mjs` — trigger `quiz` / `exitplan`
- `scripts/unit-test-permission-host.mjs` — เคส subtype/body
- `scripts/e2e-mock-agent.mjs` — เคส ask/plan card ผ่าน wire จริง

## การทดสอบ

- unit (`permission-host`): subtype map ตรงตัวพิมพ์เท่านั้น, body ไม่ถูกตัด
  ที่ 240 (แผนยาว > 240 รอดครบ), การ์ดธรรมดาไม่มี subtype/body
- e2e: prompt "quiz me" → interaction มี `subtype:'ask'` + body เป็นข้อความ
  คำถาม + options `q0_opt_*`/`q0_skip` พร้อม label; ตอบ `q0_opt_1` แล้ว agent
  ได้รับ id เดิมกลับไป; prompt "exitplan now" → `subtype:'plan'` + body เป็น
  plan markdown + options `plan_*`; ตอบ `plan_approve` รอบทริปสำเร็จ
- `npm test` เขียวทุก suite (e2e 37/37)

## วิธี revert

```
git log --grep='\[BUG-026\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
