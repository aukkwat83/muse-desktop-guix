# BUG-082 — เทิร์นตายเรียบด้วย `MCP startup audit failed` ซ้ำไม่หาย

ความรุนแรง: major (แชทค้างถาวรจนกว่า agent จะตาย/ถูกปล่อย)

## อาการที่ผู้ใช้เห็น

ส่ง prompt ใน Desktop แล้วเทิร์นตายทันที (3–12ms ไม่มี model activity)
2 ครั้งติดด้วยเหตุผลเดียวกัน ผู้ใช้เห็นแค่ turn error —
กดส่งซ้ำกี่ครั้งก็ตายเหมือนเดิม เพราะ host เดิมยังไม่ตาย

## หลักฐาน (session 01a0f130, 2026-09-30 ~16:34)

- `session.jsonl` seq 8036/8045: `run_fatal_error_classified`
  (`config_error`) + terminal reason:
  `invalid run configuration: MCP startup audit failed; MCP is disabled
  for this runtime`
- serve host (`local-tracing/bootstrap/cli-35bcaabe-*.log`, 16:11–16:45):
  MCP 26 servers `outcome="ready"` ครบตอนสตาร์ท, เทิร์นก่อนหน้า
  (16:11–16:33) ใช้ MCP ปกติ — ไม่มี transport ตาย ไม่มี log ฝั่ง
  audit เลย (binary ตั้งใจไม่บันทึก diagnostic ของ audit fault)
- host ไม่ exit (อยู่ถึง 16:45) → retry บน host เดิมล้มเหลวแบบ
  deterministic — ไม่ใช่สาเหตุจาก prompt หรือ config
  (`settings.json` ถูกต้อง, probe ปัจจุบันเขียว 26/26)

## สาเหตุ

`muse serve` ทำเครื่องหมาย MCP ว่า disabled สำหรับ runtime นั้น
(ทริกเกอร์ภายใน binary ไม่มี diagnostic ใดๆ หลงเหลือให้สาวต่อ)
Desktop เดิมไม่มีทางออก: จับแค่ `history-incompatible` /
`auth_required` ส่วน audit failure ปล่อยเป็น turn error ธรรมดา
แถม host ที่ poisoned แล้วยัง hot อยู่ — retry ครั้งถัดไปวิ่งบน
host เดิม ตายซ้ำไม่รู้จบ

## วิธีแก้ไข

- `src/server/msp-client.js` — เพิ่ม `isMcpAuditFailedError(err)`
  matcher (เคสข้อความ production verbatim ทั้ง `message` และ `rpc`)
- `src/server/sessions.js` — catch branch ใหม่ใน `prompt()` ทรงเดียว
  กับ history-incompatible: settle `rotated` + notice ภาษาไทย +
  `releaseClient(chatId, 'mcp-audit-failed')` + retry ครั้งเดียว
  (`_mcpAuditRetried` กันลูป) — ต่างกันตรงที่ **เก็บ `mspSessionId**
  **ไว้** (session log สมบูรณ์ ปัญหาอยู่ที่ host) retry จึง resume
  session เดิมบน agent ใหม่ ไม่ทิ้ง context และไม่แปะ recovery recap
- ถ้า fresh host ยัง audit-fail ซ้ำ (ไม่ใช่ transient) เทิร์น retry
  จะ surface เป็น turn_error ตามปกติ — ไม่ retry วน

## ไฟล์ที่เปลี่ยน

- `src/server/msp-client.js` — `isMcpAuditFailedError`
- `src/server/sessions.js` — import + `MCP_AUDIT_FAILED_NOTICE` +
  catch branch
- `scripts/mock-msp-agent.mjs` — keyword `auditfail` (ล้มครั้งแรกด้วย
  reason ตรง production เป๊ะ, marker แยกจาก histfail) +
  `MOCK_MSP_SESSION_LOG` (บันทึก session start/resume verbs)
- `scripts/e2e-mock-agent.mjs` — step ใหม่: rotated + retry ได้คำตอบ,
  ไม่ duplicate user message, มี notice, session id ไม่เปลี่ยน,
  fresh agent มาแบบ resume (ไม่ใช่ start)
- `scripts/unit-test-msp-client.mjs` — matcher: ตรง production reason
  ทุกทรง + ปฏิเสธเคสใกล้เคียง

## วิธี verify

- `node scripts/unit-test-msp-client.mjs` (มีเคสใหม่ 2 ข้อ)
- `npm run test:e2e` (มี step `mcp-audit failure rotates ... (BUG-082)`)
