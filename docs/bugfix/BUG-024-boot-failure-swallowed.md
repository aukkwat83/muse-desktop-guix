# BUG-024 — boot ที่ล้มเหลวถูกกลืนเงียบ (`void boot()` ไม่มี .catch)

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

เปิดแอปขณะ host สะดุด (เช่น `refreshChats()` หรือ `api()` เจอ network hiccup
กลาง boot): UI อยู่ในสถานะครึ่ง ๆ กลาง ๆ — sidebar ว่าง, transcript ว่าง —
โดยไม่มี error อะไรบอกเลย ดูเหมือนแอปค้าง

## สาเหตุ (file:line)

- `src/renderer/app.js:992` (ก่อนแก้) — `void boot();` ไม่มี `.catch` —
  rejection ใด ๆ ใน boot กลายเป็น unhandled promise rejection ที่ผู้ใช้ไม่
  เคยเห็น

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:9305-9307` — `boot().catch(err =>
  appendBubble('error', …))`

## วิธีแก้ไข

- `src/renderer/app.js` — `boot().catch((err) => showError(err?.message ||
  String(err)))` — `showError()` มีอยู่แล้วและพึ่งพาเฉพาะ `#transcript` ที่
  เป็น static element ใน index.html จึงทำงานได้แม้ boot ตายก่อนถึงขั้นไหนก็ตาม

## ไฟล์ที่เปลี่ยน

- `src/renderer/app.js` — boot catch
- `src/renderer/index.html` — bump `?v=` 0.4.10 → 0.4.11

## การทดสอบ

- `node --check src/renderer/app.js` — ผ่าน
- `npm test` — เขียวทุก suite (9 suites; e2e 34/34) — การแสดง error เป็น DOM
  behavior ที่ harness ไม่มี browser ให้ทดสอบ; การเปลี่ยนแปลงไม่แตะ turn
  pipeline/timing

## วิธี revert

```
git log --grep='\[BUG-024\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
