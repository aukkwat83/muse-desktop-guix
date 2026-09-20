# BUG-046 — scroll ตาม delta ทุกเฟรม ไม่มี rAF coalescing

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ช่วงสตรีมหนา ๆ (delta ทุก SSE chunk) การ scroll กระตุกและกิน main thread —
ทุก chunk สั่ง `scrollTop = scrollHeight` ทันที ซ้ำหลายครั้งต่อ frame

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) :146-149 — `scrollToBottom()` เป็น direct
  assignment ถูกเรียกจาก `paintLiveTurn()` (:494) และ `paintLiveMarkdownNow()`
  (:505) ต่อ `message_delta` ทุกตัว ไม่มีการรวมเป็น 1 ครั้งต่อ frame

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:1965-1974` — `scrollChatToBottom()`
  coalesce ผ่าน `requestAnimationFrame` เดียว (`if (scrollRaf) return`) และ
  callback ใช้ direct assignment ("cheaper than scrollTo() during high-rate
  streams") — invariant "1 scroll/frame"
- `grok-desktop/AGENTS.md` (Long streams §v0.3.4): "UI uses a single Text node
  + 1 scroll/frame — do not reintroduce per-token full DOM rewrites"

## วิธีแก้ไข

- `scrollToBottom()` ผ่าน rAF เดียว: ถ้ามี rAF ค้างอยู่แล้ว return —
  ทุก caller ใน frame เดียวกันรวมเป็น scroll ครั้งเดียวก่อน paint
  (callback ของ rAF รันก่อน paint จึงไม่มีแฟลช top→bottom ตอน rebuild)
- เพิ่ม `cancelPendingScroll()` สำหรับ keepScroll path ของ `selectChat()`:
  ตอน restore ตำแหน่งด้วยมือ (BUG-044) ต้องยกเลิก scroll ที่ถูก schedule ค้าง
  ไว้ก่อนหน้า ไม่ให้มายิงทับหลัง restore
- `renderTranscript()` รับ `{ stick = true }`: path keepScroll+unpinned ของ
  selectChat ส่ง `stick:false` เพื่อไม่ให้ force-scroll ลงก้นก่อนที่จะ restore
  ตำแหน่งเดิม (ก่อน rAF การทับด้วยค่าซิงโครนัสชนะเสมอ พอ scroll ขยับไปเป็น
  async ต้องไม่ schedule ตั้งแต่แรก)

## ไฟล์ที่เปลี่ยน

- `src/renderer/app.js` — scrollToBottom rAF-coalesce + cancelPendingScroll +
  renderTranscript({stick}) + selectChat ปรับ keepScroll branch
- `src/renderer/index.html` — bump `?v=` 0.4.24 → 0.4.25

## การทดสอบ

- `npm test` เขียวทุก suite (e2e 37/37 ครอบ turn settle → transcript reload
  ซึ่งเป็น caller หลักของ scroll path นี้)
- logic ที่ตัดสินใจ (pin/unpin) อยู่ใน scroll-pin.js ที่ unit-test แล้ว
  (BUG-045); ส่วน rAF เป็น DOM timing ไม่มี pure logic เพิ่ม
- ตรวจด้วยมือ: สตรีมยาว ๆ scroll นุ่ม ไม่กระตุก; turn_done ตอนอ่านข้างบนอยู่
  ยังคงตำแหน่ง (ไม่ถูก scroll ค้างยิงทับ)

## วิธี revert

```
git log --grep='\[BUG-046\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
