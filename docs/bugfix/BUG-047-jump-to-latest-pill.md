# BUG-047 — ไม่มี jump-to-latest pill เมื่อ unpin แล้วกลับไปท้ายสตรีมไม่ได้

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

เมื่อเลื่อนขึ้นอ่านข้อความเก่ากลางสตรีม (unpin แล้ว) ไม่มีทางรู้ว่ามีเนื้อหา
ใหม่ต่อท้าย และไม่มีปุ่มกลับไปล่างสุด — ต้องลาก scroll เองยาว ๆ หรือรอเทิร์น
จบ

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) — มีแค่ `state.pinned` + `scrollToBottom()`;
  ไม่มี state "มีของใหม่ขณะ unpin" และไม่มี UI affordance ใด ๆ สำหรับกลับไป
  ท้าย transcript

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:1906-1936` — `ensureJumpButton()` /
  `showJumpButton()` / `hideJumpButton()` / `rePinChatToBottom()` (pill
  "↓ ล่าสุด" ลอยกลางจอ กดแล้ว re-pin + scroll ลงล่าง)
- `grok-desktop/src/renderer/scroll-pin.js:18-27` — ตัดสินใจ `showJump`
  เมื่อ `pinned === false && newContent`
- `grok-desktop/src/renderer/style.css:2245-2273` — `.jump-live` ลอย absolute
  กลางล่างของคอลัมน์ chat

## วิธีแก้ไข

- `index.html` — เพิ่ม `<button id="jump-latest" class="jump-latest" hidden>
  ↓ ล่าสุด</button>` ใน #main (ซึ่งตอนนี้ `position: relative` เป็น anchor)
- `style.css` — `.jump-latest` ลอย absolute กลางล่าง, ใช้ token เดิม
  (`--ink` บน `--raised` เป็น pair ที่ contrast audit ครอบอยู่แล้ว จึงไม่ต้อง
  เพิ่ม PAIRS)
- `app.js`:
  - `state.newContentWhileUnpinned` เก็บว่ามีเนื้อหาใหม่ขณะ unpin
  - `scrollToBottom()` ผ่าน `computePin()` เต็มรูปแบบ (พอร์ต
    scrollChatToBottom): ถ้าไม่ควร scroll (unpinned) → ตั้ง flag + โชว์ pill;
    ถ้า scroll → rAF callback เคลียร์ flag + ซ่อน pill; `force` = re-pin
  - scroll listener: re-pin ที่ก้นแล้วเคลียร์ flag + ซ่อน pill; ยัง unpinned
    แต่มี flag → โชว์ pill
  - wheel listener: unpin พร้อม `decision.showJump` → โชว์ pill
  - click ที่ pill: re-pin + เคลียร์ flag + ซ่อน + `scrollToBottom(true)`
  - `selectChat()` สลับแชท: เคลียร์ flag + ซ่อน pill (เป็นของ transcript เดิม)
  - keepScroll+unpinned branch (turn_done/resync rebuild ทับคนอ่านที่ unpin
    อยู่) นับเป็น new content → ตั้ง flag + โชว์ pill

## ไฟล์ที่เปลี่ยน

- `src/renderer/index.html` — markup ปุ่ม + bump `?v=` 0.4.25 → 0.4.26
- `src/renderer/style.css` — #main position:relative + .jump-latest
- `src/renderer/app.js` — state, scrollToBottom ผ่าน computePin, pill
  show/hide, click handler, selectChat reset

## การทดสอบ

- unit (`scroll-pin` จาก BUG-045) ครอบตรรกะ `showJump` ของ computePin แล้ว —
  commit นี้เป็นการผูก DOM เท่านั้น
- `npm test` เขียวทุก suite (e2e 37/37)
- `npm run test:contrast` (อยู่ใน npm test) ยังเขียว — ไม่มี colour pair ใหม่
- ตรวจด้วยมือ: unpin กลางสตรีม → pill โผล่เมื่อ delta มา; กด pill → กลับล่าง
  สุดและ pinned; เลื่อนลงล่างสุดเอง → pill หาย

## วิธี revert

```
git log --grep='\[BUG-047\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
