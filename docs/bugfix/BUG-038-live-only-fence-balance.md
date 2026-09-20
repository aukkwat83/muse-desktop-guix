# BUG-038 — balanceFences ไปแตะ final/history renders + regex fence อ่อนกว่า CommonMark

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ข้อความที่จบแล้ว (history / settled) ถ้ามี fence ไม่บาลานซ์จริง ๆ (เช่น agent
เขียน ``` ค้างไว้โดยตั้งใจ หรือ fence เยื้อง 1–3 ช่องว่าง) จะถูกเติม ``` ปลาย
ข้อความเงียบ ๆ ทำให้ prose ท้ายข้อความเรนเดอร์กลายเป็น code block ผิดจากต้นฉบับ

## สาเหตุ (file:line)

- `src/renderer/markdown.js` (ก่อนแก้) :113-116 — `renderMarkdown()` เรียก
  `balanceFences()` เสมอ รวมถึงข้อความที่ settle แล้ว (`app.js:166` history
  path ก็โดน)
- `src/renderer/markdown.js` (ก่อนแก้) :108 — regex `/^```/gm` ไม่รับ fence
  ที่เยื้อง ≤3 ช่องว่าง (CommonMark 4.5 อนุญาต) จึงนับ open/close พลาด

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/markdown.js:272` — `opts.live ?
  prepareStreamingMarkdown(raw) : raw` — เติม fence ปิดเฉพาะ live path
- `grok-desktop/src/renderer/viz-contract.js:552-568` — symmetric walk
  `fenceOpenState()` ที่รับ `^( {0,3})(`{3,})` ทั้ง opener และ closer

## วิธีแก้ไข

- `src/renderer/markdown-core.js` — เพิ่ม `fenceOpenState()` (walk ทีละบรรทัด
  ตาม CommonMark: เยื้องได้สูงสุด 3 ช่อง, backtick ≥3 ตัว toggle ครั้งเดียว),
  `balanceFences()` เขียนใหม่บน walk นี้, และ `prepareStreamingMarkdown()`
  เป็นจุดรวม streaming stabilizers
- `src/renderer/markdown.js` — `renderMarkdown(text, { live })`: live เท่านั้น
  ที่ผ่าน `prepareStreamingMarkdown()`; settled/history parse ตามต้นฉบับเป๊ะ
  (ลบ `balanceFences` ออกจาก module นี้ ย้ายเข้า core เพื่อ test ใน Node ได้)
- `src/renderer/app.js` — live paint (`paintLiveMarkdownNow`) ส่ง
  `{ live: true }`; history (`msg.text`) และ ix-body parse แบบ settled

## ไฟล์ที่เปลี่ยน

- `src/renderer/markdown-core.js` — fenceOpenState / balanceFences /
  prepareStreamingMarkdown
- `src/renderer/markdown.js` — signature ใหม่ของ renderMarkdown
- `src/renderer/app.js` — call site สตรีมส่ง { live: true }
- `scripts/unit-test-markdown.mjs` — เคส walk + live/settled split

## การทดสอบ

- unit (`markdown`): fence เยื้อง 3 ช่องนับเป็น fence, 4 ช่องไม่นับ, ````
  toggle ครั้งเดียว, balanceFences ไม่เติม phantom ให้ข้อความที่ปิดด้วย fence
  เยื้อง, live prep เติม fence ปิด ส่วน settled parse ตามเดิม, และ pin ว่า
  app.js ส่ง { live: true } เฉพาะ streaming paint
- `npm test` เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-038\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
