# BUG-060 — contrast audit ขาดคู่สีที่แบกข้อความ (user bubble / tool output)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ไม่มีอาการที่มองเห็นตอนนี้ — เป็นรูของการป้องกัน: แก้ palette แล้วทำตัวหนังสือ
บนฟอง user หรือ output ของ tool จมลงต่ำกว่า AA ได้โดย audit ไม่เตือน

## สาเหตุ (file:line)

- `scripts/unit-test-theme-contrast.mjs` (ก่อนแก้) PAIRS :111-146 — ไม่มีคู่:
  - `--ink` บน `--user-bubble` — `.msg-user` (`src/renderer/style.css:952-963`)
    ใส่ตัวหนังสือ body ตรง ๆ บนฟองที่ fill เอง
  - `--ink-dim` บน `--code-bg` — `.tool-body` (`style.css:1288-1300`) และ
    `.ix-card .ix-summary` (`style.css:1353-1362`)
  - `--muted` บน `--code-bg` — `.auth-cmd` (`style.css:896-905`)
- กฎ AGENTS.md: "when adding a colour pair that carries text, add it to the
  PAIRS list — the audit only protects what it knows about" ทั้งสามคู่นี้แบก
  ข้อความแต่ไม่เคยถูกลงทะเบียน

## อ้างอิง grok-desktop (file:line)

- ต้นกำเนิดของ audit นี้คือ live DOM audit ตอนตั้งธีม (ดูหัวไฟล์
  unit-test-theme-contrast.mjs) — grok เก็บคู่พวกนี้ไว้ในการตรวจของตัวเอง;
  kimi เพิ่งพอร์ต audit มา (ชุด BUG ก่อน) แล้วตกคู่เหล่านี้ไป

## วิธีแก้ไข

- เพิ่ม 3 คู่ใน PAIRS พร้อม comment บอกว่า element ไหนใช้:
  - `['user bubble text', '--ink', '--user-bubble']`
  - `['tool output on code', '--ink-dim', '--code-bg']`
  - `['muted on code', '--muted', '--code-bg']`
- ผลวัดผ่าน AA (4.5) ทุกธีม จึงไม่ต้องแก้ token ใด:
  - user bubble: moonlight 12.11 / daylight 14.30 / claude-light 10.36
  - tool output: 10.36 / 9.26 / 7.15
  - muted on code: 6.60 / 5.67 / 5.30
- commit นี้แตะเฉพาะสคริปต์ทดสอบ ไม่แตะ renderer asset จึงไม่ bump `?v=`

## ไฟล์ที่เปลี่ยน

- `scripts/unit-test-theme-contrast.mjs` — PAIRS เพิ่ม 3 คู่

## การทดสอบ

- `npm run test:contrast` — คู่ใหม่ทั้งสามผ่าน AA ทุกธีม (ตัวเลขด้านบน)
- `npm test` เขียวทุก suite (17 suites: unit 16 + e2e 38/38)

## วิธี revert

```
git log --grep='\[BUG-060\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
