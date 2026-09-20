# BUG-037 — ไม่มี typography สำหรับ heading/list/hr/image ของ GFM

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

เมื่อ assistant ตอบด้วย markdown ที่มีหัวข้อ/ลิสต์/เส้นคั่น/รูป: หัวข้อมี
margin เทอะทะตาม UA default, ลิสต์เยื้องเข้าไป 40px, ลิสต์ซ้อนไม่มีสไตล์
แยกระดับ และรูปที่กว้างกว่าคอลัมน์ล้นออกนอกกรอบ

## สาเหตุ (file:line)

- `src/renderer/style.css` (ก่อนแก้) — ไม่มี rule ใด ๆ สำหรับ
  `.msg-assistant h1–h6 / ul / ol / li / hr` เลย (UA defaults ทำงานแทน)
  และไม่มี `.msg-assistant img` เลย

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/style.css:3676-3705` — scale ของ h1–h6 พร้อม
  border-bottom ใต้ h1/h2 และกฎ line-height รองรับสระ/วรรณยุกต์ไทย
- `grok-desktop/src/renderer/style.css:3726-3742` — list ซ้อน
  (disc/circle/square, decimal/lower-alpha)
- `grok-desktop/src/renderer/style.css:3752-3757` — hr
- `grok-desktop/src/renderer/style.css` (.md-image) — img max-width

## วิธีแก้ไข

- `src/renderer/style.css` — พอร์ตบล็อก typography มาไว้ใต้โดยใช้ token ของ
  kimi: หัวข้อ `--ink` (h5 ใช้ `--ink-dim`, h6 ใช้ `--muted`), border ใต้
  h1/h2 ใช้ `--line` / color-mix, list ซ้อนสามระดับ, hr ใช้ `--line`, และ
  `.msg-assistant img { max-width: 100% }`
- `scripts/unit-test-theme-contrast.mjs` — เพิ่ม pair `--muted` บน `--bg`
  (h6 เป็นตัวหนังสือ muted บนพื้นเพจโดยตรง)

## ไฟล์ที่เปลี่ยน

- `src/renderer/style.css` — บล็อก GFM typography ใหม่
- `scripts/unit-test-theme-contrast.mjs` — pair 'muted on page'
- `scripts/unit-test-markdown.mjs` — source-level guard ของ selector ทั้งหมด

## การทดสอบ

- unit (`markdown`): selector h1/h6/ul/ol/li/hr/img ต้องมีใน style.css และ
  img ต้อง max-width: 100%
- `npm test` เขียวทุก suite รวม `test:contrast` (pair ใหม่ผ่าน AA ทุกธีม)

## วิธี revert

```
git log --grep='\[BUG-037\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
