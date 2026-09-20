# BUG-056 — reduced-motion guard ชี้ selector ที่ไม่มีอยู่จริง

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ผู้ใช้ที่เปิด "ลดการเคลื่อนไหว" (prefers-reduced-motion) ใน macOS ยังเห็นจุด
กะพริบของ session ที่กำลังรันใน sidebar ตลอดเวลา — guard ที่ควรปิด animation
นั้นไม่ทำงาน

## สาเหตุ (file:line)

- `src/renderer/style.css` (ก่อนแก้) :1397-1401 — บล็อก
  `@media (prefers-reduced-motion: reduce)` ปิด animation ให้
  `.chat-row.running .dot` — selector นี้ไม่มี element ใดตรงเลย (grep ทั้ง
  renderer เจอแค่ rule นี้ rule เดียว; ไม่มี `.chat-row` หรือ `.dot` ใน
  JS/HTML) เป็นซากจากชื่อ class รุ่นก่อน
- จุดกะพริบตัวจริงคือ `.s-pulse.on` (`style.css` :503-506,
  `animation: pulse 1.1s infinite`) ที่ `sidebar.js` :278 และ `app.js` :676-677
  เติม class `on` ให้ session ที่กำลังรัน — ตัวนี้ไม่ถูก guard เลย

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/style.css:5786` — บล็อก reduced-motion ระบุ
  `.session-item .s-pulse.on` ชัดเจน ครอบ indicator ตัวจริงของ sidebar

## วิธีแก้ไข

- `src/renderer/style.css` — เปลี่ยน selector ตาย `.chat-row.running .dot`
  เป็น `.s-pulse.on` (คง `.status-line .spark` ไว้เหมือนเดิม)
- ไม่เพิ่มการทดสอบใน commit นี้ — BUG-061 (static CSS guards) จะเพิ่ม
  assertion ว่า selector ในบล็อก reduced-motion ต้องมี class ที่ใช้จริงใน
  renderer ป้องกัน selector ตายแบบนี้กลับมาอีก

## ไฟล์ที่เปลี่ยน

- `src/renderer/style.css` — สลับ selector ใน reduced-motion block
- `src/renderer/index.html` — bump `?v=` 0.4.34 → 0.4.35 (ทุก ref)

## การทดสอบ

- `npm test` เขียวทุก suite (17 suites: unit 16 + e2e 38/38) — contrast audit
  ยังผ่าน (ไม่ได้แตะสี)
- ตรวจด้วยมือ: เปิด Reduce Motion ที่ระบบแล้วรันเทิร์น → จุด sidebar หยุดนิ่ง

## วิธี revert

```
git log --grep='\[BUG-056\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
