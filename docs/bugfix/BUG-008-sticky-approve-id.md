# BUG-008 — "Approve for this session" ไม่เคย sticky กับ agent จริง (id ไม่ตรงกัน)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ผู้ใช้กด "Approve for this session" (`approve_always`) บนการ์ดขออนุญาต แต่
การ์ดขออนุญาตยังเด้งขึ้นมาทุกครั้งในเทิร์นถัด ๆ ไป — sticky auto-approve ไม่เคยทำงาน

## สาเหตุ (file:line)

- `src/server/acp-client.js:223` (ก่อนแก้) — `resolvePermission` เช็ค
  `optionId === 'allow_always' || 'allow-always'` เท่านั้น แต่ canonical id ของ
  kimi CLI จริงคือ `approve_always` (verify กับ
  `@moonshot-ai/kimi-code` dist/main.mjs `CANONICAL_OPTIONS` — v0.36.1:
  `approve_once` / `approve_always` / `reject`)
  `permissionStickyApprove` จึงเป็น dead code กับ agent จริง

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/server/sessions.js:1734` — grok sticky ด้วย
  `optionId === 'allow_always'` ซึ่งตรงกับ grok CLI ของมันเอง (ต่าง vocabulary
  กับ kimi — นี่คือเหตุที่ port ตรง ๆ แล้วพังเงียบ ๆ)

## วิธีแก้ไข

- `AcpClient.resolvePermission` เพิ่ม `approve_always` เข้าไปในเงื่อนไข sticky
  (คง `allow_always`/`allow-always` ไว้สำหรับ agent ที่ใช้ vocabulary แบบ grok)

## ไฟล์ที่เปลี่ยน

- `src/server/acp-client.js` — `resolvePermission` match `approve_always`
- `scripts/unit-test-turn-core.mjs` — +1 test: `approve_always` ตั้ง sticky,
  `allow_always` ยังทำงาน, `approve_once` ไม่ sticky

## การทดสอบ

- `node scripts/unit-test-turn-core.mjs` — 29/29 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-008\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
