# BUG-019 — ทุก delta ทำ markdown re-parse เต็มก้อน + เขียน DOM ใหม่ทั้ง bubble

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

เทิร์นที่สตรีมยาว: เครื่องทำงานหนักผิดปกติ (CPU พุ่งตามจำนวน chunk), code
block highlight กะพริบทุก token, scroll สั่น, เลือกข้อความระหว่างสตรีมแทบไม่
ได้ (selection ถูกทำลายทุกครั้งที่ innerHTML ถูกเขียนใหม่), ปุ่ม copy บน code
block ถูกสร้าง-ทำลายตลอด

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้, `paintLiveTurn()` :334-342) — ทุก
  `message_delta` เรียก `liveText.innerHTML = renderMarkdown(tv.text)` +
  `decorateCodeBlocks(liveText)` — full re-tokenize ของข้อความทั้งหมด + full
  DOM rewrite ต่อ SSE chunk หนึ่งครั้ง

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:3233-3247` — `scheduleLiveMarkdownPaint()`
  coalesce ด้วย timer ขั้นต่ำ `LIVE_MD_MIN_MS = 48` (app.js:309) + force flush
- `grok-desktop/AGENTS.md` ("Long streams, v0.3.4+") — ห้าม per-token full DOM
  rewrites เด็ดขาด

## วิธีแก้ไข

- `src/renderer/turn-view.js` — เพิ่ม `createLivePaintScheduler(paint,
  { minMs })` (pure ยกเว้น timer): `schedule()` รวม burst ให้ paint ครั้งเดียว
  ต่อ window (trailing), `flush()` paint ซิงโครนัสทันทีและยกเลิก timer ที่ค้าง
  อยู่; นับ `paints` ไว้ให้ test สังเกต
- `src/renderer/app.js`:
  - `LIVE_MD_MIN_MS = 48` (ค่าเดียวกับ grok)
  - `paintLiveMarkdownNow()` แยกการ re-parse ออกมา แล้วห่อด้วย scheduler
    (`liveMd`)
  - `paintLiveTurn()` — path ต่อ delta ใช้ `liveMd.schedule()`; path rebuild
    (สลับแชท / hydrate) ใช้ `liveMd.flush()` เพื่อให้ของที่มีอยู่แล้วแสดงทันที
  - terminal handler — `liveMd.flush()` ก่อน `turnViews.delete()` เสมอ (แชท
    active) ไม่อย่างนั้น paint ที่ค้างอยู่จะยิงเข้า view ที่ถูกลบ (no-op) และ
    chunk สุดท้ายจะไม่ render ถ้า transcript reload ล้มเหลว

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — `createLivePaintScheduler()`
- `src/renderer/app.js` — throttle markdown paint, flush ตอน settle/rebuild
- `src/renderer/index.html` — bump `?v=` 0.4.5 → 0.4.6
- `scripts/unit-test-turn-view.mjs` — +2 tests (burst → paint เดียว; flush
  ซิงโครนัส + ยกเลิก timer)

## การทดสอบ

- `node scripts/unit-test-turn-view.mjs` — 11/11 ผ่าน (ครอบ throttle โดยตรง)
- `node scripts/e2e-mock-agent.mjs` — 32/32 ผ่าน — case "long streamed answer"
  เดิมพิสูจน์แล้วว่าเนื้อหาสุดท้ายถูกต้องครบ (server-side contract ที่
  renderer วาดตาม); การนับจำนวน paint ระดับ DOM ไม่มีใน harness นี้ จึงอยู่ใน
  unit test
- `npm test` — เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-019\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
