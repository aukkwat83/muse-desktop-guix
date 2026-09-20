# BUG-025 — ส่งคำตอบการ์ดขออนุญาตไม่สำเร็จแล้วการ์ดตาย (ปุ่ม disabled ถาวร)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

กดปุ่มตอบการ์ดขออนุญาตแล้ว HTTP POST พลาด (เช่น id เก่าหมดอายุเพราะ auto-reject
5 นาทีชนกับการคลิกพอดี → server ตอบ 404, หรือ network ขาด): ปุ่มทุกปุ่มในการ์ด
ค้าง disabled ถาวร ไม่มี error บอก ไม่มีทาง retry — ฝั่ง agent ยังค้างรอคำตอบ
อยู่เหมือนเดิม ผู้ใช้ได้แต่นั่งมองการ์ดตาย

## สาเหตุ (file:line)

- `src/renderer/app.js:262-268` (ก่อนแก้) — click handler ของปุ่มใน
  `interactionNode()`: disable ปุ่มทั้งหมดก่อน แล้ว `await api(...).catch(() => {})`
  — กลืน error เงียบ ๆ โดยไม่ re-enable ปุ่มและไม่แจ้งอะไรเลย

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/interaction-lifecycle.js:109-119` — reducer เคส
  `submit_fail`: re-enable inputs, เก็บ error ไว้แสดง, answers เดิมอยู่ครบ
- `grok-desktop/src/renderer/app.js:8741-8777` — `answerPermission()`:
  disable → await resolve → สำเร็จค่อยปิดการ์ด / พลาด re-enable + แสดง error
  inline ในการ์ด (`setIxCardSubmitting(false)` + `setIxCardError(...)`)

## วิธีแก้ไข

- `src/renderer/turn-view.js` — เพิ่ม pure helper `ixSubmitTransition(cur, phase)`
  (reducer เฟส `start`/`ok`/`fail` ตามแบบ grok) + ค่าคงที่ `IX_SUBMIT_ERROR_TEXT`
  = "ส่งคำตอบไม่สำเร็จ — ลองอีกครั้ง" (ข้อความไทยคงที่ เพราะ HTTP error ดิบ
  ไม่บอกการกระทำที่ถูกต้องกับผู้ใช้)
- `src/renderer/app.js` — `interactionNode()` ใช้ reducer นี้ขับสถานะปุ่ม +
  บรรทัด error ใหม่ (`div.ix-card-error`, `role="alert"`): ตอน submit ปิดปุ่ม
  ทั้งหมด + ซ่อน error; ถ้า POST พลาด → เปิดปุ่มคืน + แสดงบรรทัด error ในการ์ด
  (คำตอบที่ผู้ใช้เลือกไว้ไม่หาย — ปุ่มเดิมกดซ้ำได้ทันที); ถ้าสำเร็จปล่อยให้
  SSE `interaction_resolved` เป็นคนทาสถานะ resolved ตามกฎ 202-and-SSE-only
  เดิม อีกทั้งกัน double-click ซ้ำระหว่าง submit ด้วย `submitting` flag
- `src/renderer/style.css` — สไตล์ `.ix-card .ix-card-error`: ตัวหนังสือ
  `--danger` บนชิป `--panel` (วาง `--danger` ตรง ๆ บน `--accent-soft` ของการ์ด
  ไม่ผ่าน AA บนธีม claude-light ที่ 4.40 — เลยใช้ pattern ชิปเหมือน `.ix-summary`)

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `ixSubmitTransition()` + `IX_SUBMIT_ERROR_TEXT`
- `src/renderer/app.js` — click path ของการ์ด + import token `turn-view.js`
  0.4.9 → 0.4.10
- `src/renderer/style.css` — `.ix-card-error`
- `src/renderer/index.html` — bump `?v=` 0.4.11 → 0.4.12 (ทั้ง 4 refs)
- `scripts/unit-test-turn-view.mjs` — เคส reducer
- `scripts/e2e-mock-agent.mjs` — เคส stale-id 404

## การทดสอบ

- unit (`turn-view`): `ixSubmitTransition` — `fail` คืน `submitting:false` +
  ข้อความ error; `start` ล้าง error ตอน retry; เฟสแปลกปลอมผ่านคืนเดิม
- e2e: prompt "ask me first" → รอ interaction → cancel เทิร์น (settle ลบ
  pending interaction) → POST resolve ด้วย id เดิมต้องได้ **404 + ok:false** —
  นี่คือสัญญาฝั่ง wire ที่ renderer ใช้เข้าเคส fail; ส่วน DOM re-enable ทดสอบ
  ไม่ได้ใน harness เพราะไม่มี browser
- `npm test` เขียวทุก suite (e2e 35/35)

## วิธี revert

```
git log --grep='\[BUG-025\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
