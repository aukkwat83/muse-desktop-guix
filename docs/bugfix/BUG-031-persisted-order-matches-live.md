# BUG-031 — ลำดับข้อความที่ persist ขัดกับลำดับ live (แผนกระโดดขึ้นบนหลังจบเทิร์น)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ระหว่างเทิร์น live เห็นลำดับ: แถว tool → plan card → คำตอบ (กฎ BUG-018)
แต่พอเทิร์นจบและ transcript reload จาก disk ลำดับกลายเป็น plan → tool →
คำตอบ — แผน "กระโดด" ขึ้นไปอยู่เหนือแถว tool ทุกครั้งหลัง turn_done

## สาเหตุ (file:line)

- `src/renderer/app.js:171-180` (ก่อนแก้) — `messageNode()` เรนเดอร์
  plan → tools → text ขณะที่ live path (`liveChildOrder()` ใน
  `turn-view.js`) เป็น tools → plan → answer

## อ้างอิง grok-desktop (file:line)

- grok-desktop ใช้ลำดับ activity → plan → assistant เหมือนกันทั้ง live path
  และ history path (เทียบ `pinLiveLayout` app.js:2132-2176 กับการเรนเดอร์
  transcript จาก store)

## วิธีแก้ไข

- `src/renderer/turn-view.js` — เพิ่ม pure helper `messageChildOrder(msg)`
  คืนลำดับลูกของข้อความ assistant เป็น tools → plan → text → marker
  (user/notice เป็น node เดียว) — เป็นลำดับเดียวกับ `liveChildOrder()` เป๊ะ
- `src/renderer/app.js` — `messageNode()` วนตาม `messageChildOrder(msg)`
  แทนการ hardcode ลำดับเอง — แก้ที่เดียวทั้งสอง path ไม่มีทางเบี้ยวกันอีก

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `messageChildOrder()`
- `src/renderer/app.js` — messageNode ใช้ helper; import token
  `turn-view.js` 0.4.14 → 0.4.15
- `src/renderer/index.html` — bump `?v=` 0.4.17 → 0.4.18
- `scripts/unit-test-turn-view.mjs` — เคสเทียบลำดับ settled vs live

## การทดสอบ

- unit (`turn-view`): `messageChildOrder` คืน ['tools','plan','text','marker']
  สำหรับข้อความที่มีครบ และลำดับสัมพัทธ์ตรงกับ `liveChildOrder()` (tools <
  plan < text); เนื้อที่ไม่มีตกออก; user/notice เป็น node เดียว
- `npm test` เขียวทุก suite (ลำดับ DOM จริงทดสอบไม่ได้ใน harness — เทียบผ่าน
  helper ที่ทั้งสอง path ใช้ร่วมกัน)

## วิธี revert

```
git log --grep='\[BUG-031\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
