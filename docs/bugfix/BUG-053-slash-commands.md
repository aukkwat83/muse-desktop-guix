# BUG-053 — ไม่มี slash commands (/plan, /ask, /always-approve)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

พิมพ์ `/plan` หรือ `/ask` ใน composer (นิสัยจาก TUI) แล้วข้อความถูกส่งเป็น
prompt ดิบ ๆ ให้ agent — ไม่ได้สลับโหมด ต้องกด chip/Shift+Tab เท่านั้น

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) :1149-1158 (keydown) / submitPrompt — ไม่มี
  parsing คำสั่งนำหน้า `/` เลย โหมดสลับได้เฉพาะ chip กับ Shift+Tab
  (`cycleMode()` :769-778 เดิม)

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:1857-1891` — `handleSlashCommands()`:
  `/plan [ข้อความ]` สลับเป็น plan แล้วส่งส่วนที่เหลือเป็น prompt ต่อทันที,
  `/always-approve on|off` (bare = toggle), `/ask` กลับ normal
- `grok-desktop/src/renderer/app.js:7264-7269` — เรียก pre-send ใน
  `sendPrompt()` และคำสั่งไม่เข้าคิว ("never queue these")

## วิธีแก้ไข

- `src/renderer/slash-commands.js` (ใหม่, pure) — `parseSlashCommand(text)`
  คืน intent: `{type:'mode', mode, rest}` / `{type:'toggle-always'}` /
  `{type:'unknown', name}` / `{type:'none'}`
  - mode ที่คืนเป็นชื่อ SessionMode ภายในของ kimi-desktop
    (`'normal'|'plan'|'always'` — src/server/session-mode.js) **ไม่ใช่** ACP
    wire id: POST /mode → `SessionManager.setMode()` →
    `AcpClient.resolveModeId()` ค่อย map เข้ากับ mode ที่ agent ประกาศจริงใน
    configOptions (ไม่ hardcode ที่ renderer)
- `src/renderer/app.js`:
  - `submitPrompt()` parse หลังล้าง composer/draft และก่อน enqueue/ส่ง —
    คำสั่งไม่เข้าคิวตาม grok
  - `runSlashCommand()`: ตั้ง chip แบบ optimistic (server จะ echo
    `mode_changed` กลับมาเหมือน path chip เดิม), POST ล้มเหลว → roll chip
    กลับ + notice ไทย `ตั้งโหมดไม่สำเร็จ: …`; `/plan <text>` ส่ง rest เป็น
    prompt ต่อ (enqueue ถ้ามีเทิร์นรันอยู่)
  - คำสั่งที่ไม่รู้จัก (`/compact` ฯลฯ) → notice ไทย `ไม่รู้จักคำสั่ง /x —
    ส่งเป็นข้อความตามปกติ` แล้วส่งเป็นข้อความธรรมดา — ไม่มีทางกลืนข้อความ
    ผู้ใช้ (grok ส่งผ่านเงียบ ๆ; kimi เตือนก่อนเพราะคำสั่ง TUI ของ kimi เอง
    ยังไม่มีใน client นี้)

## ไฟล์ที่เปลี่ยน

- `src/renderer/slash-commands.js` — โมดูล pure ใหม่ (parser)
- `src/renderer/app.js` — import + hook ใน submitPrompt + runSlashCommand
- `src/renderer/index.html` — bump `?v=` 0.4.31 → 0.4.32
- `scripts/unit-test-slash-commands.mjs` — suite ใหม่ (5 เคส)
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite slash-commands

## การทดสอบ

- unit (`slash-commands`): ข้อความธรรมดา/ว่าง/null ไม่ใช่คำสั่ง, /plan
  (ว่าง/มี rest/หลายบรรทัด/ตัวพิมพ์), /ask, /always-approve on|off|bare,
  คำสั่งแปลก (`/compact`, `/planx`, `/ask now`) → unknown พร้อมชื่อ
- `npm test` เขียวทุก suite (15 suites: unit 14 + e2e 38/38)
- ตรวจด้วยมือ: `/plan ออกแบบ X` → chip เปลี่ยนเป็น plan และ prompt ต่อเข้าไป;
  `/compact` → notice + ส่งเป็นข้อความ

## วิธี revert

```
git log --grep='\[BUG-053\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
