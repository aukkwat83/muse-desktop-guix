# BUG-077 — ไม่มีตัวบอกจำนวน subagent ที่กำลังรันในเทิร์น (ต้องไล่อ่าน transcript)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

เทิร์นที่ agent แตก subagent หลายตัว (โดยเฉพาะ swarm) ผู้ใช้ไม่รู้เลยว่าตอนนี้
มี agent กำลังรันอยู่กี่ตัวจากทั้งหมดกี่ตัว ต้องไล่อ่านแถว tool ใน transcript
เอง — grok มี chip บอก `n/total` บน head bar

## สาเหตุ (file:line)

- `src/renderer/index.html:47-51` — `.head-right` ไม่มี chip สำหรับ agent
  count; ข้อมูลมีอยู่แล้วใน turn view (`tv.tools` + `isAgentTool()` จาก
  BUG-076) แต่ไม่มีใครนำมาแสดง

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/index.html:359-362` — `#agents-chip`/`#agents-count`
- `grok-desktop/src/renderer/app.js:1383-1411` — setAgentsPill/renderAgentsChip:
  แสดง `n/total` ของเทิร์นปัจจุบัน, เด่น/กะพริบเมื่อมี ≥1 ตัวรัน, ซ่อนเมื่อไม่มี
- `grok-desktop/src/renderer/style.css:2559-2568` — style ของ chip

## วิธีแก้ไข

1. **`turn-view.js` (pure, testable)**: `agentCounts(tv)` → `{ running, total }`
   — นับจาก `tv.tools` ที่ `isAgentTool()` (swarm นับเป็น 1 แถวไม่ว่าจะ fan-out
   กี่ item); `running` ตาม wire status (pending|in_progress|running) โดย
   background-done (display state 'background' ของ BUG-076) **ไม่นับ** — chip
   กะพริบเพื่องานที่เทิร์นรออยู่ งานเบื้องหลังไม่ block อะไร; settled/failed
   อยู่ใน total อย่างเดียว
2. **`index.html`**: `#agents-chip` (span.pill) ใน `.head-right` หลัง
   agent-state — ซ่อนเมื่อ total = 0
3. **`app.js`**: `updateAgentsChip()` แสดง `agents n/total` (title ไทยบอก
   รายละเอียด) toggle class `busy` + `agents-pulse` เมื่อ running ≥1 — เรียกจาก
   `updateRunningChrome()` จุดเดียว ซึ่งเป็น funnel ที่ tool_call /
   tool_call_update / turn_started / turn_done / selectChat ไหลผ่านอยู่แล้ว
   ไม่ต้องมี SSE ใหม่ (turn state is per chat — chip อ่านเฉพาะ view ของแชทที่
   เปิดอยู่ เทิร์นจบ view ถูกลบ chip หายเอง)
4. **`style.css`**: `.pill.agents-pulse` ใช้ `@keyframes pulse` ที่มีอยู่แล้ว
   (ตัวเดียวกับ sidebar pulse) + เพิ่ม selector เข้า reduced-motion block —
   สีใช้คู่ `.pill.busy` ที่ audit แล้ว ไม่มี scroll container ใหม่ (guard
   min-height:0 ข้อ 6 ไม่ถูกแตะ)

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `agentCounts()`
- `src/renderer/app.js` — el, `updateAgentsChip()`, ผูกเข้า updateRunningChrome
- `src/renderer/index.html` — chip + bump `?v=` 0.4.47→0.4.48
- `src/renderer/style.css` — pulse rule + reduced-motion guard
- `scripts/unit-test-turn-view.mjs` — เพิ่ม 1 เคส (รวม 40)

## การทดสอบ

- `node scripts/unit-test-turn-view.mjs` → 40/40 (เพิ่ม agentCounts: view
  ว่าง/null, plain tools ไม่นับ, swarm 5 item นับ 1 แถว, settled อยู่ใน total,
  background-done หลุดจาก running, failed ไม่นับ running)
- `npm test` เขียวครบ 21 suites (css-guards 12/12 รวม reduced-motion guard
  ตัวใหม่; e2e 38/38)

## วิธี revert

```bash
git log --grep='\[BUG-077\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
