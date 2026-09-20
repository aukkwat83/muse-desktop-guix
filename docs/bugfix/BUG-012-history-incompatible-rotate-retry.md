# BUG-012 — history ที่ agent ใช้ต่อไม่ได้ทำ chat บริคถาวร (ไม่มี rotate-and-retry)

ความรุนแรง: CRITICAL

## อาการที่ผู้ใช้เห็น

เมื่อ agent ปฏิเสธ history ที่ host ส่งต่อ (เปลี่ยน model, encryption หมดอายุ,
session ถูก prune) เทิร์นนั้นจบด้วย error — และ **ทุก prompt ถัดไป fail แบบ
เดียวกันไปตลอด** จนกว่าผู้ใช้จะรู้ว่าต้องกด release agent แล้วเริ่มใหม่เอง
เพราะ `acpSessionId` ที่ตายแล้วยังค้างอยู่บน disk

## สาเหตุ (file:line)

- `src/server/sessions.js` `prompt()` catch (ก่อนแก้) — ทุก error ถูก settle เป็น
  `turn_error` แล้วหยุด; `isHistoryIncompatibleError()` มีอยู่ใน
  `src/server/acp-client.js:60-87` แต่ **ไม่มีไฟล์ไหน import ไปใช้เลย** —
  `acpSessionId` ที่ตายแล้วค้างบน slot/disk ทำให้ prompt ถัดไป resume เจอ
  history เดิมที่ใช้ไม่ได้ซ้ำอีก

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/sessions.js:3536-3586` — เมื่อ
  `isHistoryIncompatibleError(err)`: settle partial, ล้าง id ที่ตายผ่าน
  `_markRotated` (+ persist ทันที), spawn agent ใหม่, แล้ว retry prompt
  ครั้งเดียว (guard ด้วย `opts._historyRotated`)

## วิธีแก้ไข

ใน catch ของ `client.prompt(...)` ใน `SessionManager.prompt()`:

1. ตรวจ `isHistoryIncompatibleError(err) && !opts._historyRetried`
2. `settleTurn(chatId, turnId, { reason: 'rotated' })` — เก็บ partial stream
   ไว้ (content fallback เป็น turn.text) ไม่ปนกับ error จริง
3. `store.update(chatId, { acpSessionId: null })` — field นี้ flushNow
   ทันทีตาม invariant ใน AGENTS.md (session-store.js:271)
4. บันทึก notice ไทยลง transcript ว่ากำลังหมุนเซสชัน + stash
   `_rotated` flag (ให้ BUG-014 แนบ recovery recap ใน wire text ถัดไป)
5. `releaseClient(chatId, 'history-incompatible')` แล้ว `this.prompt()`
   ซ้ำครั้งเดียวด้วย `{ _historyRetried: true, skipUserMessage: true }` —
   `skipUserMessage` กัน user message ซ้ำใน transcript (ข้อความถูก store
   ไปแล้วตอนครั้งแรก); ถ้า retry พังอีก ปล่อยให้ settle ปกติของรอบนั้นจัดการ

## ไฟล์ที่เปลี่ยน

- `src/server/sessions.js` — import `isHistoryIncompatibleError`; `prompt()`
  รับ `opts` (`_historyRetried`/`skipUserMessage`); rotation branch ใน catch;
  `_rotated` map ใน constructor
- `scripts/mock-acp-agent.mjs` — trigger `"histfail"`: one-shot ผ่าน marker
  file (`MOCK_ACP_HISTFAIL_MARKER`) เพราะ agent ที่ถูก rotate เป็น process
  ใหม่ — state ใน process เดิมหายหมด; ครั้งแรกตอบ `-32602 'Session not found;
  start a new session'` (shape เดียวกับ resume miss ของ CLI จริง), ครั้งถัดไป
  ตอบปกติ
- `scripts/e2e-mock-agent.mjs` — env marker + E2E case: prompt histfail →
  turn_done 2 ครั้ง (rotated + retry) ไม่มี turn_error, คำตอบลงจริงครั้งเดียว,
  user message ไม่ซ้ำ, มี notice, และ `acpSessionId` บน disk เป็น id สดใหม่

## การทดสอบ

- `node scripts/e2e-mock-agent.mjs` — 26/26 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-012\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
