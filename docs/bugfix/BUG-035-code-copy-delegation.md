# BUG-035 — ปุ่ม copy: สตริงอังกฤษ + listener ต่อ node + ไม่มี clipboard fallback

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

- ปุ่ม copy บน code block แสดง 'copy' / 'copied' / 'failed' ทั้งที่ UI
  ทั้งแอปเป็นไทย
- กด copy กลางสตรีมแล้วบางทีไม่มีอะไรเกิดขึ้น — live repaint แทนที่ subtree
  ทั้ง bubble ทำให้ listener ที่ผูกไว้กับ node เก่าหลุดไปด้วย
- บน context ที่ `navigator.clipboard` ใช้ไม่ได้ (WKWebView ที่ไม่ใช่ secure
  context) copy ล้มเหลวเงียบ ๆ

## สาเหตุ (file:line)

- `src/renderer/markdown.js` (ก่อนแก้) :126-136 — `decorateCodeBlocks()`
  ผูก click listener หนึ่งตัวต่อ `<pre>` ใช้ `navigator.clipboard.writeText`
  อย่างเดียว และสตริงเป็นอังกฤษ

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/markdown.js:1267-1289` —
  `installCodeCopyDelegation()`: click handler ตัวเดียวบน `document`
  (capture phase) อ่านโค้ดจาก DOM ตอนคลิก จึงรอดจาก re-render ทุกครั้ง
- `grok-desktop/src/renderer/markdown.js:1254-1262` — feedback ไทย
  '✓ คัดลอกแล้ว' / '! ลองใหม่'
- `grok-desktop/src/renderer/markdown.js:1229-1251` —
  `copyTextToClipboard()` พร้อม fallback `execCommand('copy')` ผ่าน textarea

## วิธีแก้ไข

- `src/renderer/markdown.js` — พอร์ต `copyTextToClipboard()` (clipboard API
  → fallback textarea + `execCommand`), `flashCopyBtn()` (ไทย +
  class `is-copied`), และ `installCodeCopyDelegation()` ที่มี guard
  `codeCopyDelegationInstalled` กันผูกซ้ำ; ลบ `decorateCodeBlocks()`
- `src/renderer/markdown-core.js` — คงสตริง feedback ไว้ใน
  `COPY_OK_TEXT` / `COPY_FAIL_TEXT` ให้ unit test pin ได้
- `src/renderer/app.js` — import เปลี่ยนเป็น `installCodeCopyDelegation`,
  เรียกครั้งเดียวตอน `boot()`; ลบ call `decorateCodeBlocks()` ทั้ง 3 จุด
  (history, ix-body, live)
- `src/renderer/style.css` — ลบ CSS `.code-copy` แบบ hover-only และ
  `position: relative` บน `pre` ที่ไม่มีลูก positioned แล้ว

## ไฟล์ที่เปลี่ยน

- `src/renderer/markdown.js` — delegation + fallback + ไทย, ลบ decorate
- `src/renderer/markdown-core.js` — COPY_OK_TEXT / COPY_FAIL_TEXT
- `src/renderer/app.js` — wire ตอน boot, ลบ call sites
- `src/renderer/style.css` — ลบ `.code-copy` block
- `scripts/unit-test-markdown.mjs` — pin สตริงไทย + resting label

## การทดสอบ

- unit (`markdown`): สตริง feedback และ resting label เป็นไทย
- `npm test` เขียวทุก suite (พฤติกรรมคลิกจริงเป็น DOM — ทดสอบใน harness
  ไม่ได้; delegation เป็น handler เดียวบน document ไม่แตะ turn timing)

## วิธี revert

```
git log --grep='\[BUG-035\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
