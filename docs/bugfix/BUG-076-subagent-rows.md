# BUG-076 — แถว subagent หน้าตาเหมือน tool ธรรมดา: แยกไม่ออกว่า agent กำลังรัน

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

เวลา agent สั่ง subagent (Agent / AgentSwarm) แถวที่ขึ้นใน transcript หน้าตา
เหมือน tool row ธรรมดาทุกประการ — แยกไม่ออกว่าอันไหนคือ subagent, swarm
กี่ตัว, หรือเป็นงานเบื้องหลัง ที่สำคัญกว่านั้น background agent ที่ tool_call
จบแล้ว (task ถูก park ไว้) ขึ้น "เสร็จแล้ว" ทั้งที่ agent ยังทำงานอยู่ข้างหลัง

## สาเหตุ (file:line)

- `toolNode()` (`src/renderer/app.js:273-297`) render ทุก tool เหมือนกันหมด —
  ไม่มี class/ไอคอนแยก, ไม่มี subtitle
- `liveChildOrder()` (`src/renderer/turn-view.js:69-76` เดิม) เรียงตามลำดับ
  เข้าอย่างเดียว — agent rows ไม่ได้ pin ไว้บนเหมือน grok
- wire facts: title ของ Agent = `Launching <type> agent: <desc>`, AgentSwarm
  = `Launching agent swarm: <desc>`; kind เป็น 'other' เสมอ — สัญญาณที่เชื่อ
  ได้คือ rawInput (`subagent_type` / `prompt_template`, `items`,
  `resume_agent_ids`, `run_in_background`); tool_call ของ background Agent
  complete ทันทีที่ task ถูก park (ผลลัพธ์มี `task_id`, `status: running`
  ขณะ agent ยังรัน)

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:2857-2927` (`upsertLiveTool`) — agent rows
  ได้ class 'agent' และถูก insert ก่อนแถว non-agent แรก (pin ไว้บน), status
  running ของ agent อ่านว่า 'Working'
- `grok-desktop/src/server/sessions.js:5030-5038` — heuristic background
  completed→running

## วิธีแก้ไข

1. **`turn-view.js` (pure, testable)**:
   - export `isAgentTool()` (เดิม private) และเพิ่ม `agentToolMeta()` —
     คืน { swarm, type, count, background } หรือ null สำหรับ tool ธรรมดา;
     count ของ swarm = `items.length + Object.keys(resume_agent_ids||{}).length`
   - `agentSubtitle()` — `coder` / `explore` หรือ `swarm · 12 ตัว`
   - `toolDisplayState()` — pending/running/done/failed/**background**:
     completed + `run_in_background===true` → 'background' — **presentation
     layer เท่านั้น** wire status ไม่ถูกเขียนทับ resolveStatusVerb/isRunning
     จึงไม่เห็นสถานะนี้ (งานเบื้องหลังไม่ block เทิร์น)
   - `liveChildOrder()` pin agent rows เหนือ plain tool rows (คงลำดับเข้าภายใน
     กลุ่ม) — transcript ที่ settle แล้วยังเรียงตามลำดับเข้าดิบผ่าน
     `messageChildOrder()` เหมือน history restore ของ grok
2. **`app.js` `toolNode()`**: agent rows ได้ class `agent` + subtitle span
   (rawInput อาจมาทีหลังตอน update — class/subtitle re-resolve ทุก paint ไม่ใช่
   เฉพาะตอนสร้าง row); status label ของ background-completed อ่านว่า
   "ทำงานเบื้องหลัง" แทน "เสร็จแล้ว"; เนื้อ body ยังเป็น final report ขยายได้
   เหมือนเดิม
3. **`style.css`**: `.tool-row.agent .name::before { content: '◈ ' }` ใช้
   --accent-text + `.tool-head .sub` ใช้ --muted — ทั้งคู่เป็น audited pairs
   ไม่มีสีใหม่

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — helpers + liveChildOrder
- `src/renderer/app.js` — toolNode (class/subtitle/label), import
- `src/renderer/style.css` — glyph + subtitle rules
- `src/renderer/index.html` — bump `?v=` 0.4.46→0.4.47
- `scripts/unit-test-turn-view.mjs` — เพิ่ม 4 เคส (รวม 39)

## การทดสอบ

- `node scripts/unit-test-turn-view.mjs` → 39/39 (เพิ่ม: agentToolMeta ทั้ง 2
  rawInput shape + กรณี null, agentSubtitle, toolDisplayState ครบ 5 สถานะรวม
  background heuristic, liveChildOrder pin agent เหนือ plain คงลำดับเข้าในกลุ่ม)
- `npm test` เขียวครบ 21 suites (e2e 38/38)

## ข้อจำกัดโปรโตคอล

- ไม่มี inner tool calls ของ subagent บน wire → แถว agent แสดงได้แค่ชื่อ/สถานะ/
  final report ไม่มีรายละเอียดงานข้างใน
- ไม่มี live per-item progress ของ swarm → subtitle แสดงจำนวนตัวอย่างเดียว
  ไม่มี "สำเร็จ x/y" ระหว่างรัน

## วิธี revert

```bash
git log --grep='\[BUG-076\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
