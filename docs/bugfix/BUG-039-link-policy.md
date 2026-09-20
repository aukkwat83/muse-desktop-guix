# BUG-039 — link policy ฆ่า relative/anchor link และติด target=_blank ให้ mailto

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

- link แบบ site-relative (`/docs/...`) หรือ anchor (`#section`) ในคำตอบของ
  assistant กลายเป็นข้อความธรรมดา คลิกไม่ได้ (href ถูกลบทิ้ง)
- link `mailto:` เปิด tab ใหม่ว่าง ๆ ก่อนเรียก mail client เพราะติด
  `target="_blank"` มาด้วย

## สาเหตุ (file:line)

- `src/renderer/markdown.js` (ก่อนแก้) :36 — `safeUrl()` อนุญาตเฉพาะ
  `https?:|mailto:` ทำให้ `/path` และ `#anchor` โดนลบ href
- `src/renderer/markdown.js` (ก่อนแก้) :79 — sanitize walk ใส่
  `target="_blank"` ทุกลิงก์ไม่มีเงื่อนไข

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/markdown.js:67` — `safeHref()` อนุญาต
  `https?:|mailto:|/|#`
- `grok-desktop/src/renderer/markdown.js:387` — ใส่ `target="_blank"`
  เฉพาะลิงก์ที่ขึ้นต้นด้วย http

## วิธีแก้ไข

- `src/renderer/markdown-core.js` — ย้าย `safeUrl()` มาที่ core (test ใน Node
  ได้) พร้อมขยาย regex รับ `^/` และ `^#`; เพิ่ม `isExternalUrl()` สำหรับ gate
  target
- `src/renderer/markdown.js` — sanitize walk ใส่ `target="_blank"` เฉพาะเมื่อ
  `isExternalUrl(url)`; `rel="noopener noreferrer"` ยังใส่ทุกลิงก์เหมือนเดิม

## ไฟล์ที่เปลี่ยน

- `src/renderer/markdown-core.js` — safeUrl (ขยาย) + isExternalUrl
- `src/renderer/markdown.js` — gate target=_blank ใน walk
- `scripts/unit-test-markdown.mjs` — เคส safeUrl/isExternalUrl + source pin

## การทดสอบ

- unit (`markdown`): https/http/mailto///# ผ่าน, javascript:/data:/ค่าว่าง
  โดนปฏิเสธ, isExternalUrl true เฉพาะ http(s), walk ใช้ gate นั้นจริง
- `npm test` เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-039\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
