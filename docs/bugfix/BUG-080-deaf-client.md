# BUG-080 — client หูหนวก: view/subscribe ล้มเงียบ แล้วทุกเทิร์นค้างตลอดกาล

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

เปิดแชทเก่า (`81442763…` → agent session `01a0d811…`) แล้วส่ง prompt —
spinner หมุนไม่หยุด ไม่มีตัวอักษรสตรีมออกมาเลยแม้แต่ตัวเดียว ทั้งที่ฝั่ง
agent ตอบเสร็จและ run `terminal completed` ไปแล้วทั้ง 2 รอบ (พิสูจน์จาก
CLI `session.jsonl` + serve trace) กด cancel ได้ (direct RPC ยังใช้ได้)
แต่ส่งใหม่ก็ค้างเหมือนเดิม

## สาเหตุ (file:line)

- `src/server/msp-client.js:818` (ก่อนแก้) — `view/subscribe` ตอน handshake
  ล้มแล้วถูก `catch` กลืน เหลือแค่ `emit('stderr', …)`; client ที่เหลือไม่มี
  subscription จึงไม่ได้รับ notification สัก frame (no `item/*`, no
  `turn/completed`) แต่ `turn/start` ack มาปกติ → status ค้าง `running`
- `src/server/sessions.js:1152` (ก่อนแก้) — watchdog เห็น client lively แล้ว
  hold ตลอดกาล (hard cap default 0, CLI parity) ไม่มีข้อยกเว้นสำหรับเทิร์นที่
  ไม่เคยได้ยินอะไรเลย → อุ้มเทิร์นที่ตายแล้วไม่รู้จบ
- `src/renderer/app.js:1635` (ก่อนแก้) — SSE `agent_stderr` ถูก subscribe
  ไว้แต่ `onEvent` ไม่มี case รองรับ (ตระกูลเดียวกับ BUG-023) → error
  จากฝั่ง agent ไม่มีทางโผล่บน UI; host.log ก็ไม่มี timestamp
  หาจังหวะเกิดเหตุไม่ได้

## วิธีแก้ไข

- `MspClient.ensureSubscribed()` — retry subscribe 3 ครั้ง (ห่าง 500ms)
  แล้วยังล้ม → throw `SUBSCRIBE_FAILED` ให้ spawn ล้มทั้งก้อนแบบ fail loud
  (prompt ไม่เคยถูกสร้าง, route ตอบ 502 พร้อมข้อความ)
- `MspClient.prompt()` — gate `NOT_SUBSCRIBED`: ปฏิเสธเทิร์นใหม่ถ้า
  `subscribed` ไม่เคยถูกยืนยัน (กันหูหนวกชั้นที่สอง)
- `_onTurnCompleted` — ทุกการทิ้ง completion (ไม่มี active turn / turnId
  ไม่ตรงกับ live waiter) ต้อง emit `[msp]` diagnostic ลง `stderr`
- `_checkWatchdog` — lively แต่ `!sawActivity` เกิน `NO_ACTIVITY_MS` (180s)
  = หูหนวก/ค้างก่อนเริ่มงาน (turn/started + item/started มาก่อนงานเสมอ):
  settle เป็น `turn_error` ภาษาคน + `releaseClient` ทิ้ง proc หูหนวก
  เพื่อให้ prompt ถัดไป spawn ตัวใหม่; เทิร์นที่เคยมี activity ยัง hold
  ตลอดกาลเหมือนเดิม (คงเจตนา 74f04882)
- `agent_stderr` → host.log (timestamp + ตัด 300 ตัวอักษร) + renderer case
  ใหม่แสดงเป็น notice ชั่วคราว (ไม่ modal, ไม่ set errored); boot failure
  และ `sticky-hold` ได้ timestamp ด้วย

## ไฟล์ที่เปลี่ยน

- `src/server/msp-client.js` — `subscribed` flag, `ensureSubscribed()`,
  `prompt()` gate, drop diagnostics
- `src/server/sessions.js` — deaf-client backstop ใน watchdog,
  `stderr`→host.log bridge, boot-failure warn, timestamp ใน sticky-hold
- `src/renderer/app.js` — `case 'agent_stderr'`
- `scripts/unit-test-msp-client.mjs` — suite ใหม่ 5 tests
- `scripts/unit-test-turn-core.mjs` — แยก test lively-hold: มี activity
  ยัง hold / ไม่เคยมี frame เลยต้อง settle + release (contract change
  จาก 'never settles while lively', อธิบายเหตุผลไว้ใน test)
- `scripts/mock-msp-agent.mjs` + `scripts/e2e-mock-agent.mjs` — trigger
  `stay-deaf` (ack แต่ไม่ส่งอะไรเลย) + E2E case: settle เป็น error
  ภาษาคน → release agent → prompt ถัดไป recover ปกติ
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite `msp-client`

## การทดสอบ

- `node scripts/unit-test-msp-client.mjs` — 5/5 ผ่าน (0/5 บนโค้ดเก่า)
- `node scripts/unit-test-msp-client.mjs` — 5/5 ผ่าน (0/5 บนโค้ดเก่า)
- `node scripts/unit-test-turn-core.mjs` — 41/41 ผ่าน
- `npm test` — 35 suites เขียวทั้งหมด (รวม e2e-mock-agent 58/58:
  เคส `stay-deaf` พิสูจน์ settle + release + recovery ส่วนเคส `hang`
  เดิมพิสูจน์ว่าเทิร์นที่มี activity แล้วยัง hold)
- protocol probe แยก (`/tmp/msp-probe.mjs`, isolated XDG store):
  fresh + resumed session บน binary 1.4.1 ได้ `turn/completed` ปกติ —
  ยืนยันว่า serve ไม่ได้พังทั้งระบบ

## วิธี revert

```
git log --grep='\[BUG-080\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
