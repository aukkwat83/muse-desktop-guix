# BUG-034 — code block ไม่มีแถบ chrome / ป้ายภาษา

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

code block ในคำตอบของ assistant เป็นกล่องโค้ดลอย ๆ ไม่มีป้ายบอกภาษา
(js / python / bash …) และไม่มีปุ่ม copy ประจำบล็อก — มีเพียงปุ่ม 'copy'
ลอยที่โผล่มาเฉพาะตอน hover (หาไม่เจอถ้าไม่รู้มาก่อน)

## สาเหตุ (file:line)

- `src/renderer/markdown.js` (ก่อนแก้) — ใช้ default renderer ของ marked
  ที่ออก `<pre><code>` เปล่า ๆ ไม่มี container/chrome ใด ๆ
- `src/renderer/style.css` (ก่อนแก้ ~:900-941) — มีเฉพาะ `.msg-assistant pre`
  กับปุ่ม `.code-copy` แบบ `opacity: 0` จนกว่าจะ hover

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/markdown.js:355-373` — custom `code()` renderer
  ของ marked ออก `.md-code-block > .md-code-chrome (.md-code-label +
  .md-copy-btn) + pre.md-pre`
- `grok-desktop/src/renderer/style.css:3773-3858` — CSS ของ chrome bar

## วิธีแก้ไข

- แยก pure helpers ออกมาเป็น `src/renderer/markdown-core.js` (ไม่ import
  vendor/DOM — unit test โหลดใน Node ได้ตรง ๆ แบบ turn-view.js) ใส่
  `escapeHtml()` + `codeBlockHtml({ text, lang })` ที่ออก HTML โครงเดียวกับ
  grok; ป้ายภาษาเป็นตัวพิมพ์ใหญ่ผ่าน CSS `text-transform` (fallback `'code'`)
  และ label ปุ่มเป็นไทยตาม convention ('คัดลอก')
- `src/renderer/markdown.js` — `marked.use({ renderer: { code } })`; เพิ่ม
  `button` เข้า `ALLOWED_TAGS` และ attrs `type/class/title/aria-label`, เพิ่ม
  `pre: class` — ไม่อย่างนั้น sanitize walk ลบปุ่ม/คลาสทิ้งหมด
- `src/renderer/style.css` — พอร์ต CSS chrome (token สีเดิมของ kimi เท่านั้น:
  bar เป็น `--panel-2` + label `--muted`, ปุ่ม hover `--raised`/`--ink`,
  สถานะ copied ใช้ `--ok`); เก็บปุ่ม `.code-copy` แบบเดิมไว้ชั่วคราว —
  BUG-035 ถึงเปลี่ยนเป็น delegated handler และลบออก

## ไฟล์ที่เปลี่ยน

- `src/renderer/markdown-core.js` — ไฟล์ใหม่: `escapeHtml`, `codeBlockHtml`
- `src/renderer/markdown.js` — custom code renderer + sanitizer allowlist
- `src/renderer/style.css` — บล็อก CSS `.md-code-block/.md-code-chrome/
  .md-code-label/.md-copy-btn/pre.md-pre`
- `src/renderer/app.js` — import token `markdown.js` 0.4.2 → 0.4.3
- `src/renderer/index.html` — bump `?v=` 0.4.20 → 0.4.21
- `scripts/unit-test-markdown.mjs` — suite ใหม่ (wire เข้า
  `scripts/unit-test-all.mjs`)
- `scripts/unit-test-theme-contrast.mjs` — เพิ่ม pair `--ok` บน `--panel-2`
  (ป้าย copied บนแถบ chrome)

## การทดสอบ

- unit (`markdown`): codeBlockHtml ออก chrome/label/ปุ่ม, fallback `'code'`,
  escape เนื้อโค้ดและ info string
- `npm test` เขียวทุก suite รวม `test:contrast`

## วิธี revert

```
git log --grep='\[BUG-034\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
