# BUG-072 — status verb ระหว่างเทิร์นไม่ตาม grok: ไม่แยก subtype การ์ด / kind ของ tool, ไม่นับ agent, fallback กล่าวหา thinking

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

- การ์ด AskUserQuestion / ExitPlanMode เด้งขึ้นมา แต่ status line ยังบอก
  "รอการอนุญาต…" เหมือนการ์ด approve ธรรมดา — ผู้ใช้แยกไม่ออกว่ารอคำตอบ
  รอตรวจแผน หรือรอกดอนุญาต
- tool ที่กำลังรันโชว์เป็น title ดิบ ๆ (`Bash npm test…`) ทั้งที่ UI ทั้งแอป
  เป็นภาษาไทย และไม่แยกว่ากำลังอ่าน / แก้ไข / รัน / ค้นหา
- subagent (Agent/AgentSwarm) ที่กำลังรันโชว์เป็น title อิสระของมัน
  ไม่มีการนับ "กำลังรัน n agents…" เหมือน grok
- เทิร์นที่ไม่มีสัญญาณอะไรเลยบอก "กำลังคิด…" ทั้งที่ agent ไม่ได้ส่ง reasoning
  มาด้วยซ้ำ — fallback กล่าวเท็จ

## สาเหตุ (file:line)

- `src/renderer/turn-view.js:273-296` — `resolveStatusVerb()` เวอร์ชันเก่า
  มีแค่ 4 ระดับ (permission → plan step → title ดิบ → "กำลังคิด…")
  ไม่รู้จัก subtype ของการ์ด, ไม่รู้จัก kind ของ tool, ไม่รู้จัก subagent
- `src/renderer/app.js:766-767` — `thought_delta` ถูกทิ้งทั้ง frame
  (`case 'thought_delta': return;`) จึงไม่มีข้อมูลว่า agent กำลังคิดจริงไหม

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/transcript-model.js:730-806` — `resolveStatusVerb()`
  chain: pending interaction (แยก type) → notice → plan step → running
  non-agent tool → subagent count → thinking → Working…
- `grok-desktop/src/renderer/transcript-model.js:812-837` — `formatToolVerb()`
  แปล kind เป็นคำกริยา และใช้ title ที่เป็น verb phrase อยู่แล้วตามเดิม

## วิธีแก้ไข

1. **`src/renderer/turn-view.js`**:
   - `createTurnView()` เพิ่ม `thoughtSeen: false` — flag ต่อเทิร์นว่ามี
     thought_delta เข้ามาแล้ว (เนื้อ reasoning ยังไม่แสดง)
   - เพิ่ม `isAgentTool()` (private) — subagent ของ kimi มาทาง Agent/AgentSwarm
     ซึ่ง kind เป็น 'other' และ title เป็นข้อความอิสระ สัญญาณเดียวที่เชื่อได้คือ
     `rawInput.subagent_type` / `rawInput.prompt_template`; rawInput อาจเป็น
     null ตอน call ถูกสร้างแบบ lazy → degrade เป็น tool ธรรมดา
   - เพิ่ม `formatToolVerb()` (private) — แปล kind → กริยาไทย: read→กำลังอ่าน,
     edit→กำลังแก้ไข, execute→กำลังรัน, fetch→กำลังค้นหา, think→กำลังคิด,
     other→กำลังใช้; title ย่อ 48 ตัวอักษร collapse whitespace; title ที่ขึ้นต้น
     ด้วย "กำลัง" หรือคำอังกฤษลงท้าย -ing ใช้ตามเดิม ไม่เติม prefix ซ้ำ
   - `resolveStatusVerb()` chain ใหม่ตาม grok: การ์ดที่ยังไม่ตอบ (แยก subtype:
     ask→รอคำตอบจากคุณ…, plan→แผนพร้อมแล้ว — รอตรวจสอบ…, อื่น→รอการอนุญาต…) →
     plan step ที่ in_progress (เหมือนเดิม) → tool ธรรมดาตัวแรกที่ยังรัน
     (กริยาตาม kind) → นับ agent ที่ยังรัน (1 agent / n agents) →
     thoughtSeen→กำลังคิด… → fallback กำลังทำงาน… (เลิกใช้ "กำลังคิด…" เป็น
     fallback เพราะการคิดเป็น data-driven แล้ว fallback ต้องไม่กล่าวเท็จ)
2. **`src/renderer/app.js`**:
   - `turn_started` reset `tv.thoughtSeen = false` พร้อม reset ตัวอื่นต่อเทิร์น
   - `thought_delta` ไม่ทิ้งอีก: bind turnId ผ่าน `bindTurnId()` ทิ้ง frame
     ล่าช้าของเทิร์นที่ถูกแทนที่เหมือน case พี่น้อง, ตั้ง `tv.thoughtSeen = true`
     และเรียก `updateRunningChrome()` เฉพาะตอน flip false→true (ครั้งเดียวต่อ
     เทิร์น) หรือตอน frame นั้นเปิดเทิร์น — chunk ของ reasoning ไหลถี่มาก
     การ refresh chrome ทุก chunk คือสิ่งที่ comment เก่ากลัว ไม่ใช่ตัว flip;
     เนื้อ reasoning ยังไม่ถูกนำมาแสดง (product decision เดิมยังคงอยู่)
3. **`src/renderer/index.html`** — bump `?v=` 0.4.43→0.4.44 ทุก asset
   (css-guards บังคับให้ token ตรงกันหมด) + import token ของ turn-view.js ใน
   app.js 0.4.16→0.4.17

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — chain ใหม่ + `isAgentTool()`/`formatToolVerb()`
  + field `thoughtSeen`
- `src/renderer/app.js` — reset ต่อเทิร์น, handler `thought_delta`, import token
- `src/renderer/index.html` — cache-bust tokens
- `scripts/unit-test-turn-view.mjs` — เคส `resolveStatusVerb` ใหม่ครบทั้ง chain

## การทดสอบ

- `node scripts/unit-test-turn-view.mjs` → 32/32 (เพิ่ม: subtype ทั้ง 3 แบบ,
  kind ทั้ง 6 แบบทั้งมี/ไม่มี title, verb-phrase title ไทย/อังกฤษ, agent
  เอกพจน์/พหุพจน์ + tool ธรรมดาชนะ agent + agent ชนะ thought + rawInput null,
  thoughtSeen→กำลังคิด…, view ว่าง→กำลังทำงาน…, ลำดับ priority ทั้ง chain)
- `npm test` เขียวครบ 20 suites (รวม e2e 38/38)
- ไม่เพิ่ม e2e case: status verb แปลงใน renderer ฝั่ง client ล้วน ๆ (e2e ขับผ่าน
  HTTP/SSE ไม่ได้ render DOM) และไม่ได้แตะ turn timing — ตาม convention ที่ e2e
  มีไว้ปกป้อง timing/ordering เท่านั้น

## ข้อจำกัดโปรโตคอล

- kimi-acp ไม่มี token/usage channel → status line ไม่มีตัวนับ token เหมือน
  `resolveStatusTokens` ของ grok — ไม่มีข้อมูลจริงให้แสดง (จงใจไม่ทำ)
- kimi-acp ไม่มี notice/compact channel → ไม่มี verb "Compacting context…"
  ของ grok — wire นี้ไม่มี event ดังกล่าวเลย (จงใจไม่ทำ)

## วิธี revert

```bash
git log --grep='\[BUG-072\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
