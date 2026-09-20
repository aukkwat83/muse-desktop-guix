# BUG-042 — ไม่มี streaming stabilizers (fence ติดกับข้อความ / comment ไม่ปิด)

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

กลางสตรีม ถ้า agent ส่ง fence ติดกับข้อความบรรทัดเดียวกัน (`ผลลัพธ์:```js`)
ช่วงเวลาก่อนบรรทัดถัดไปมาถึง ข้อความจะเรนเดอร์เป็น inline code ยาว ๆ แล้ว
ค่อย "snap" กลายเป็น code block — กะพริบเห็นได้ชัด อีกเคสคือ HTML comment
ที่ยังไม่ปิด (`<!--`) กลืนข้อความท้ายสตรีมหายไปชั่วคราว

## สาเหตุ (file:line)

- `src/renderer/markdown.js` (ก่อนแก้) — live prep มีแค่ปิด fence ค้าง
  (balanceFences) ไม่มี normalize ของ fence ที่ติดกับข้อความ และไม่มีการ
  soft-close comment

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/viz-contract.js:524-542` —
  `normalizeMarkdownFences()`: แยก opener ที่ติดท้ายข้อความ (ใส่บรรทัดว่าง)
  และ closer ที่ติดท้ายบรรทัดโค้ด (เฉพาะเมื่อนับ fence ข้างหน้าแล้วเป็นตัวปิด);
  inline ```span``` ไม่โดนแตะเพราะ lookahead บังคับ newline/EOS หลัง info
- `grok-desktop/src/renderer/markdown.js:256-258` —
  `prepareStreamingMarkdown()` soft-close HTML comment ที่เปิดค้าง

## วิธีแก้ไข

- `src/renderer/markdown-core.js` —
  - `normalizeMarkdownFences()`: พอร์ต regex ทั้งสองของ grok (ย่อ alternation
    ของภาษา viz เหลือ `[\w+-]*` เพราะ kimi ไม่มี viz fence)
  - `prepareStreamingMarkdown()` ลำดับใหม่: normalize → balance (BUG-038) →
    soft-close comment — ทำเฉพาะ live path เท่านั้น (settled ไม่โดนแตะ ตาม
    BUG-038)

## ไฟล์ที่เปลี่ยน

- `src/renderer/markdown-core.js` — normalizeMarkdownFences +
  prepareStreamingMarkdown ขยาย
- `scripts/unit-test-markdown.mjs` — เคส normalize/comment + parse จริงผ่าน
  marked จาก node_modules

## การทดสอบ

- unit (`markdown`): fence ติดข้อความถูกแยก, inline ```span``` รอด, closer
  ติดบรรทัดโค้ดถูกแยกเฉพาะตอนเป็นตัวปิด, comment ค้างถูก soft-close, และ
  `marked.parse(prepareStreamingMarkdown('ผลลัพธ์:```js\n…'))` ออก code block
  จริง (parse ด้วย marked ตัวจริงจาก node_modules)
- `npm test` เขียวทุก suite

## วิธี revert

```
git log --grep='\[BUG-042\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
