# BUG-041 — ไม่มี error containment รอบ marked.parse

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ถ้า `marked.parse()` throw กับ input หน้าตาประหลาด (edge case ของ parser)
ขณะอยู่ใน SSE handler การ throw จะทำให้ `paintLiveTurn`/`renderTranscript`
abort กลางฟังก์ชัน — bubble ค้าง หรือ transcript เรนเดอร์ครึ่งเดียว

## สาเหตุ (file:line)

- `src/renderer/markdown.js` (ก่อนแก้) :114 — เรียก `marked.parse()` ตรง ๆ
  ไม่มี try/catch

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/markdown.js:274-282` — try/catch รอบ parse
- `grok-desktop/src/renderer/markdown.js:1885-1904` + style.css — fallback
  เป็น plain text ใน `.md-plain` (white-space: pre-wrap)

## วิธีแก้ไข

- `src/renderer/markdown-core.js` — `plainFallbackHtml(text)`: escape ต้นฉบับ
  ใส่ `<div class="md-plain">` (div+class ผ่าน sanitizer allowlist อยู่แล้ว
  จึงปลอดภัยโดยไม่ต้องพึ่ง textContent ของ caller)
- `src/renderer/markdown.js` — ครอบ `marked.parse()` ด้วย try/catch; เมื่อ
  throw คืน fallback ของต้นฉบับดิบ (ไม่ผ่าน streaming prep)
- `src/renderer/style.css` — `.msg-assistant .md-plain
  { white-space: pre-wrap; overflow-wrap: anywhere }`

## ไฟล์ที่เปลี่ยน

- `src/renderer/markdown-core.js` — plainFallbackHtml
- `src/renderer/markdown.js` — try/catch ใน renderMarkdown
- `src/renderer/style.css` — สไตล์ .md-plain
- `scripts/unit-test-markdown.mjs` — เคส escape/wrap + source pin

## การทดสอบ

- unit (`markdown`): fallback escape HTML และ wrap ด้วย .md-plain,
  renderMarkdown มี catch รอบ parse, CSS มี pre-wrap
- `npm test` เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-041\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
