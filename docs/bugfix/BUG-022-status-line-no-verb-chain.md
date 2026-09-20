# BUG-022 — status line เป็น binary (คิด…/ใช้เครื่องมือ…) ไม่บอกสถานะจริงและไม่มี hint ว่า Esc หยุดได้

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ขณะเทิร์นรัน: status line แสดงแค่ "กำลังคิด…" หรือ "กำลังใช้เครื่องมือ…" กับ
วินาที — ไม่บอกว่ากำลังรอผู้ใช้ตอบการ์ดขออนุญาต (ดูเหมือนค้าง), ไม่บอก plan
step ที่ทำอยู่, ไม่บอกชื่อ tool ที่กำลังรัน และไม่มี hint ว่ากด Esc เพื่อหยุด
ได้

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้, `updateRunningChrome()` ~:376) —
  `tv?.tools.size ? 'กำลังใช้เครื่องมือ…' : 'กำลังคิด…'` — binary, ไม่เคยดู
  interactions/plan และ timer แสดงแค่ `${secs}s`

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/transcript-model.js:730-806` —
  `resolveStatusVerb()` priority chain: pending interaction → in-progress plan
  step → running tool title → Thinking…/Working… และ format `✳ Verb (12s · esc
  to interrupt)`

## วิธีแก้ไข

- `src/renderer/turn-view.js` — เพิ่ม `resolveStatusVerb(tv)` (pure) แบบ lean
  เทียบ shape ของ kimi: การ์ด permission ที่ยังไม่ตอบ → "รอการอนุญาต…" → plan
  step ที่ in_progress (ตัด 56 ตัวอักษร + …) → tool ที่ยังรันอยู่
  (`<title>…`) → "กำลังคิด…" — **ไม่มี tokens segment** เพราะ kimi ACP ไม่มี
  usage channel (ไม่แสดงเท็จ)
- `src/renderer/app.js` — `updateRunningChrome()` ใช้ `resolveStatusVerb(tv)`;
  status-timer เป็น `${secs}s · Esc เพื่อหยุด` และ tick ทันทีตอนเริ่ม (ไม่รอ
  interval แรก); case `plan` / `interaction` / `interaction_resolved` ของแชท
  active เรียก `updateRunningChrome()` ด้วยเพื่อให้ verb ตามสถานะทันที (เดิม
  verb เปลี่ยนเฉพาะตอน tool_call)

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `resolveStatusVerb()`
- `src/renderer/app.js` — status line ใช้ verb chain + esc hint + refresh ตาม
  plan/interaction events
- `src/renderer/index.html` — bump `?v=` 0.4.8 → 0.4.9
- `scripts/unit-test-turn-view.mjs` — +5 tests ครอบ priority chain ทั้งหมด
  (fallback / tool / plan > tool / permission > ทุกอย่าง + resolved ปลด /
  truncate 56+…)

## การทดสอบ

- `node scripts/unit-test-turn-view.mjs` — 20/20 ผ่าน
- `node scripts/e2e-mock-agent.mjs` — 33/33 ผ่าน
- `npm test` — เขียวทุก suite
- ไม่แตะ turn timing จึงไม่เพิ่ม E2E case (ตามเกณฑ์ AGENTS.md)

## วิธี revert

```
git log --grep='\[BUG-022\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
