# BUG-054 — เมนูแชทไม่มี "คัดลอกทั้งหมด (Markdown)"

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

อยากคัดลอกบทสนทนาทั้งหมดออกไปวางที่อื่น — เมนู ⋯ ของ session มีแค่ เปิด /
คัดลอก session id / ย้าย / ลบ ไม่มีทางเอา transcript ออกทีเดียว

## สาเหตุ (file:line)

- `src/renderer/sidebar.js` (ก่อนแก้) `openChatMenu()` :466-504 — ไม่มีรายการ
  copy ทั้งแชท
- ไม่มี serializer transcript → Markdown ใน renderer เลย

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/app.js:6411-6418` — เมนู session มี
  "Copy all (Markdown)" (`copySessionSummary('md')`; ถ้าไม่ใช่ session ที่เปิด
  อยู่จะ select ก่อนแล้วค่อย copy)
- `grok-desktop/src/renderer/teams-format.js:546-566` —
  `buildSessionMarkdownCopy()`: `# title` + `session: \`id8\`` + section ต่อ
  เทิร์น (format Teams/HTML เป็น grok-specific — ไม่พอร์ต)

## วิธีแก้ไข

- `src/renderer/transcript-markdown.js` (ใหม่, pure) — `chatToMarkdown(chat)`:
  - header `# <title>` + `session: \`<id8>\``
  - user → `## คำถาม`, assistant → `## คำตอบ`, notice → blockquote
  - tool rows ของ assistant → บรรทัด `**🔧 <title> — <สถานะไทย>**`
    (ใช้ `toolStatusLabel()` จาก turn-view.js) + output ใน fenced block —
    fence เลือกความยาวให้ยาวกว่า run ของ backtick ในเนื้อหาเสมอ
- `src/renderer/sidebar.js` — เมนู session เพิ่ม "คัดลอกทั้งหมด (Markdown)"
  (icon ⎘) หลัง "คัดลอก session id"
- `src/renderer/app.js` — action `copyChatMarkdown(chatId)`: ใช้ `state.chat`
  ถ้าเป็นแชทที่เปิดอยู่ ไม่งั้น `GET /api/chats/:id`; เขียน clipboard ผ่าน
  `copyTextToClipboard()` ของ markdown.js (helper จาก BUG-035 ที่มี fallback
  execCommand สำหรับ WKWebView — ตอนนี้ export แล้ว); ล้มเหลว → notice ไทย
  เฉพาะเมื่อเป็นแชทบนจอ (เมนูปิดไปแล้ว ไม่มีปุ่มให้ flash)
- ชุดทดสอบใหม่ทำให้ AGENTS.md (Testing) อัปเดตจำนวน suite ไปด้วยใน commit นี้

## ไฟล์ที่เปลี่ยน

- `src/renderer/transcript-markdown.js` — โมดูล pure ใหม่
- `src/renderer/markdown.js` — export copyTextToClipboard
- `src/renderer/sidebar.js` — เมนูเพิ่มรายการ
- `src/renderer/app.js` — action + ฟังก์ชัน copyChatMarkdown, bump token
  markdown.js 0.4.3→0.4.4 / sidebar.js 0.4.3→0.4.4
- `src/renderer/index.html` — bump `?v=` 0.4.32 → 0.4.33
- `scripts/unit-test-transcript-markdown.mjs` — suite ใหม่ (6 เคส)
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite transcript-markdown
- `AGENTS.md` — อัปเดตจำนวน suite (15 unit + e2e)

## การทดสอบ

- unit (`transcript-markdown`): header/short id, ลำดับ section ตาม transcript,
  tool row เป็น fenced block พร้อมสถานะไทย, output ที่มี ``` ได้ fence ยาวขึ้น,
  notice เป็น quote, role แปลกถูกข้าม, input เสีย ๆ ไม่ throw
- `npm test` เขียวทุก suite (16 suites: unit 15 + e2e 38/38)
- ตรวจด้วยมือ: เมนู ⋯ ของ session ที่ไม่ได้เปิดอยู่ → คัดลอกทั้งหมด → วางแล้ว
  ได้ Markdown ครบ

## วิธี revert

```
git log --grep='\[BUG-054\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
