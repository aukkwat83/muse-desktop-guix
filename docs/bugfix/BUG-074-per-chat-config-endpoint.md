# BUG-074 — เปลี่ยน model/effort ต่อแชทไม่ได้: ไม่มี endpoint และ effort เป็น global ตายตัว

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

ทุกแชทถูกบังคับใช้ model + thinking effort จาก env ตอนเปิดโฮสต์
(`KIMI_DESKTOP_MODEL` / `KIMI_DESKTOP_EFFORT`) — เปลี่ยนเฉพาะบางแชทไม่ได้
เปลี่ยนกลางทางโดยไม่รีสตาร์ทโฮสต์ไม่ได้ และแชทเย็น (cold) ที่ spawn ใหม่จะ
กลับไปใช้ค่า global เสมอแทนค่าที่เคยเลือกไว้

## สาเหตุ (file:line)

- `src/server/sessions.js` `ensureClient()` ส่ง `effort: this.defaults.effort`
  (ค่า global จาก env) ให้ constructor ของ AcpClient เสมอ — ไม่มี field
  `effort` บน chat เลย
- `src/server/session-store.js` `create()` / `normalizeChat()` ไม่มี field
  `effort` — persist ไม่ได้
- ไม่มี endpoint สำหรับ `session/set_config_option`: `PATCH /api/chats/:id`
  (`src/server/index.js:417-426`) รับแค่ title/cwd — `applySessionConfig()`
  (`src/server/acp-client.js:335-371`) เรียก RPC นี้ได้ตอนเปิดเซสชันเท่านั้น

## อ้างอิง wire facts (kimi-code 0.36.1, ตรวจแล้ว)

- `session/new` → `configOptions` เป็น select 3 ตัว: `model`, `thinking`
  (category `thought_level` — **ไม่มีเลย**ถ้า model ปัจจุบันไม่รองรับการคิด;
  ค่าที่รับได้คือ `off` + supportEfforts เช่น low/high/max แตกต่างกันตาม model)
  และ `mode`
- `session/set_config_option {configId, value}` ตอบกลับเป็น snapshot
  `{configOptions}` ชุดใหม่ทั้งก้อน และ agent push `config_option_update`
  ตามหลัง (server forward เป็น SSE อยู่แล้ว sessions.js:938-943)
- ห้าม hardcode ค่าตัวเลือก — validate กับ configOptions ที่ agent โฆษณาเท่านั้น

## วิธีแก้ไข

1. **field `chat.effort` ครบวงจร**: `session-store.js` (create + normalizeChat),
   `sessions.createChat` (`opts.effort ?? this.defaults.effort`),
   `ensureClient` ส่ง `chat.effort` ให้ constructor — ค่าต่อแชทชนะค่า global
   เพราะ `applySessionConfig()` push ค่าจาก constructor อยู่แล้ว
   (`chatSummary` ใส่ effort ด้วย)
2. **`AcpClient.setConfigOption(kind, value)`**: validate kind ∈ {model,
   thinking} + value กับ configOptions ที่โฆษณา (reject ด้วย error ที่มี
   `.status = 400`), ยิง `session/set_config_option`, อัปเดต configOptions จาก
   snapshot ที่ตอบกลับ และเก็บค่า wanted ใหม่ไว้บน client; เพิ่ม
   `configSelects()` — normalize select model/thinking (currentValue + values)
   โดย thinking เป็น null เมื่อ model ไม่รองรับการคิด
3. **`SessionManager.setChatConfig(chatId, body)`** + route
   `POST /api/chats/:id/config` (`src/server/index.js`): persist ลง store เสมอ
   (model→chat.model, thinking→chat.effort); มี live client → validate + apply
   แล้ว broadcast `config_changed` (configId, value, config ใหม่ทั้งก้อน);
   แชท cold → persist-only รอ applySessionConfig ตอน spawn ถัดไป; ถ้า RPC
   เจอ history-incompatible (เปลี่ยน model บนเซสชันที่ resume มา) → rotate
   เหมือน prompt path เป๊ะ: clear acpSessionId (flushNow), notice ไทยใน
   transcript, release client — ค่าใหม่ถูก apply ตอน spawn ใหม่
   (notice ดึงออกมาเป็น const กลาง `HISTORY_INCOMPATIBLE_NOTICE` ใช้ร่วมกัน
   2 path)
4. **snapshot**: `GET /api/chats/:id` ตอนนี้มี `config: { model, effort,
   options }` — options เป็น select ที่ normalize แล้ว หรือ null เมื่อแชท cold
   (renderer จะได้สร้าง picker ได้โดยไม่ต้องมี SSE event ใหม่)

## ไฟล์ที่เปลี่ยน

- `src/server/session-store.js` — field `effort` (create + normalizeChat)
- `src/server/acp-client.js` — `setConfigOption()` + `configSelects()`
- `src/server/sessions.js` — effort plumbing, `chatConfig()`, `setChatConfig()`,
  const `HISTORY_INCOMPATIBLE_NOTICE`
- `src/server/index.js` — route `POST /api/chats/:id/config`
- `scripts/unit-test-config-options.mjs` — suite ใหม่ 9 เคส
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite (รวม 21 suites)

## การทดสอบ

- `node scripts/unit-test-config-options.mjs` → 9/9: whitelist reject (400),
  value ไม่อยู่ใน advertised → 400 + ไม่ persist, cold persist-only + SSE
  options null, live path ยิง RPC + SSE พก selects ใหม่, rotation
  history-incompatible (clear id + notice + release + persist), effort รอด
  store round-trip, guard no-live-session / select ที่ไม่ได้โฆษณา
- `npm test` เขียวครบ 21 suites (รวม e2e 38/38)

## วิธี revert

```bash
git log --grep='\[BUG-074\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
