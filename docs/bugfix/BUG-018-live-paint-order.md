# BUG-018 — live paint แทรก tool/plan ไว้ "ใต้" ข้อความที่กำลังสตรีม (คำตอบแหว่งกลาง)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

agent พิมพ์คำตอบไปครึ่งทาง แล้วเรียก tool แล้วพิมพ์ต่อ: แถว tool ไปโผล่
**ใต้** bubble ข้อความที่กำลังไหล แล้วข้อความที่โตขึ้นเรื่อย ๆ อยู่เหนือแถว
tool — คำตอบดูเหมือนถูกผ่าครึ่งด้วยแถว tool ค้างกลางจอ

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้, `paintLiveTurn()` :308-319) — tool row /
  plan card / permission card ที่มาใหม่ถูก `liveWrap.append()` ต่อท้ายเสมอ —
  แต่ node ข้อความสตรีม (`liveText`) ถูกสร้างไว้ก่อนแล้ว (:321-329) จึงอยู่
  "ก่อน" แถวใหม่ใน DOM ทั้งที่ตามเวลาจริง tool เกิดทีหลัง… และ delta ถัดไป
  ขยายข้อความที่อยู่เหนือแถวนั้นต่อไป

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:2132-2176` — `pinLiveLayout()` บังคับ
  ลำดับ activity → plan → assistant ใหม่ทุกครั้งที่ paint ("answer always
  bottommost" เป็น layout contract ตั้งแต่ grok v0.3.1)

## วิธีแก้ไข

- `src/renderer/turn-view.js` — เพิ่ม `liveChildOrder(tv)` (pure): คืน key
  ลำดับที่ต้องการ `tool:<id>` (ตามลำดับมาถึง) → `plan` → `text` → `ix:<id>`
  (การ์ด permission อยู่ล่างสุดเพื่อให้กดตอบได้เสมอขณะข้อความโตอยู่เหนือมัน)
- `src/renderer/app.js` — `paintLiveTurn()` เขียนใหม่ให้ reconcile ผ่าน
  `liveChildren` (Map key → element) แทนการ querySelector ด้วย CSS selector:
  upsert เนื้อหาลง map แล้ว re-append ตาม `liveChildOrder()` ทุกครั้ง —
  `append()` ย้าย node ที่ต่ออยู่แล้ว จึง "pin" ลำดับได้ฟรีเมื่อลำดับถูกอยู่
  แล้ว; key ที่หายไป (plan ถูกล้าง) ถูก prune ออก

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `liveChildOrder()`
- `src/renderer/app.js` — `paintLiveTurn()` reconcile ด้วย child map + pin order
- `src/renderer/index.html` — bump `?v=` 0.4.4 → 0.4.5
- `scripts/mock-acp-agent.mjs` — trigger ใหม่ "mixorder": text → tool_call →
  text
- `scripts/unit-test-turn-view.mjs` — +2 tests (pin order + arrival order)
- `scripts/e2e-mock-agent.mjs` — +1 case: สตรีม mixorder ต้องมี delta →
  tool_call → delta บน wire ตามลำดับ (contract ที่ renderer pin ตาม)

## การทดสอบ

- `node scripts/unit-test-turn-view.mjs` — 9/9 ผ่าน
- `node scripts/e2e-mock-agent.mjs` — 32/32 ผ่าน
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-018\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
