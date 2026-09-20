# BUG-052 — renderTranscript mount ทุกข้อความ + re-render markdown ทั้งประวัติ

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

แชทที่สนทนามายาว (หลายร้อยข้อความ — server เก็บสูงสุด 500) กระตุก/หน่วงทุกครั้ง
ที่สลับแชทและทุกครั้งที่เทิร์นจบ เพราะ markdown ของทุกข้อความในประวัติถูก
parse + mount ใหม่ทั้งหมด

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) :419-422 — `renderTranscript()` วน
  `for (const msg of chat.messages) turn.append(messageNode(msg))` ทุกครั้งที่
  ถูกเรียก: ทุก chat switch (:1016 เดิม) และทุก turn settle (:700 เดิม) —
  O(ทั้งประวัติ) ต่อครั้ง

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/history-window.js:59`
  (`computeHistoryStartIndex` — window ตามจำนวน user turn + พื้นขั้นต่ำ
  minMessages), :122 (`expandHistoryStartIndex` — ขยายขึ้นทีละ N turn,
  startIndex ไม่มีทางเพิ่ม), :154 (`sliceHistoryMessages`), :20
  (`adaptiveHistoryDefaults` — เครื่อง core น้อย window เล็กลง)
- `grok-desktop/src/renderer/app.js:4483-4504` — ปุ่ม "โหลดข้อความเก่ากว่า ·
  N ข้อความ" เหนือ window
- `grok-desktop/src/renderer/app.js:4509-4539` — `loadOlderHistory()` ขยาย
  จาก buffer ในหน่วยความจำ (ไม่ fetch) + anchor scroll ด้วย distance-from-bottom

## วิธีแก้ไข

- `src/renderer/history-window.js` (ใหม่, pure) — พอร์ต
  `adaptiveHistoryDefaults` / `userMessageIndices` / `computeHistoryStartIndex`
  / `expandHistoryStartIndex` / `sliceHistoryMessages`
  - ไม่พอร์ต `partitionTranscriptWindow` / `turnMsgIndex` /
    `shouldDeferHistoryWindowRecompute`: สามตัวนั้นทำงานบน TurnModel ของ grok —
    kimi ไม่มี model นั้น; live turn ของ kimi mount แบบ incremental ผ่าน
    `paintLiveTurn()` ต่อท้าย history window เสมอ (เปิดอยู่เสมอโดยโครงสร้าง)
    และไม่มี window recompute กลางสตรีมให้ defer (renderTranscript ไม่ถูกเรียก
    ต่อ delta)
- `src/renderer/app.js`:
  - `historyStartIndex` (module state): null = window ดีฟอลต์, เลข = จุดที่ผู้ใช้
    ขยายถึง — reset ตอนสลับแชทใน selectChat, คงไว้ข้าม same-chat re-render
    (settle ไม่ทำให้ที่ขยายไว้หดกลับ)
  - `renderTranscript()` mount เฉพาะ slice ท้ายตาม window และ prepend แถว
    "โหลดข้อความเก่ากว่า · N ข้อความ" เมื่อ truncated
  - `loadOlderHistory()` ขยายทีละ `expandTurns` user turns (ข้อความทั้งหมดอยู่ใน
    memory อยู่แล้ว — ไม่ต้อง fetch ไม่ต้องมี loading state) และ anchor ด้วย
    distance-from-bottom (สอดคล้อง BUG-044: settle path ยัง re-pin ถ้า pinned
    และคืน distBottom ถ้าไม่ — windowing ไม่แตะ logic นั้น)
- `src/renderer/style.css` — `.history-load-older` (dashed pill ตามภาษา
  dashed-tab ของ sidebar; `--muted` บนพื้นหน้าเป็น pair ที่ audit แล้ว)

ข้อจำกัดที่รับรู้: server เก็บสูงสุด 500 ข้อความ — เมื่อข้อความเก่าหลุดออกจาก
store, absolute index ที่ขยายไว้คลาดเล็กน้อย (clamp ที่ความยาว) เหมือน buffer
ของ grok

## ไฟล์ที่เปลี่ยน

- `src/renderer/history-window.js` — โมดูล pure ใหม่
- `src/renderer/app.js` — windowed mount + load-older + reset ตอนสลับแชท
- `src/renderer/style.css` — .history-load-older
- `src/renderer/index.html` — bump `?v=` 0.4.30 → 0.4.31
- `scripts/unit-test-history-window.mjs` — suite ใหม่ (12 เคส)
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite history-window

## การทดสอบ

- unit (`history-window`): window ตาม turn, floor minMessages ขยายเท่านั้น
  ไม่เคยหด, empty/degenerate ไม่ throw, options กำหนดเอง, expand ถอยทีละ turn
  และไม่เพิ่ม, clamp ที่ 0, ไม่มี user message → ถอย 4×expandTurns, slice
  clamp, adaptive ตาม cores
- `npm test` เขียวทุก suite (14 suites: unit 13 + e2e 38/38)
- ตรวจด้วยมือ: แชทยาว → mount เฉพาะหน้าต่างท้าย + แถวโหลดเก่า; กด → ขยายขึ้น
  โดยข้อความบนจออยู่ที่เดิม; settle หลังขยาย → ไม่หดกลับ

## วิธี revert

```
git log --grep='\[BUG-052\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
