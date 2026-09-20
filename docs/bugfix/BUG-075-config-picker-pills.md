# BUG-075 — ไม่มี UI เปลี่ยน model/effort: ต้องแก้ env แล้วรีสตาร์ทโฮสต์

ความรุนแรง: minor (ต่อจาก BUG-074 ที่วาง endpoint)

## อาการที่ผู้ใช้เห็น

ถึง server จะมี `POST /api/chats/:id/config` แล้ว (BUG-074) ผู้ใช้ก็ยัง
เปลี่ยน model หรือ thinking effort จากหน้าแอปไม่ได้ — ไม่มี control บน UI
เลย และ SSE `config_option_update` ที่ agent push มาถูก renderer ทิ้ง
(ไม่มี case ใน onEvent) ทั้งที่ subscribe ไว้

## สาเหตุ (file:line)

- `src/renderer/index.html:47-51` — `.head-right` มีแค่ agent-state pill,
  mode chip, ปุ่ม release-agent
- `src/renderer/app.js` — ไม่มี handler สำหรับ `config_option_update` /
  `config_changed` (ตกไป default case) และไม่มี state เก็บ config snapshot
  ที่ BUG-074 ใส่มาใน `GET /api/chats/:id`

## อ้างอิง pattern เดิมใน repo

- `openMenu(anchor, items)` (`src/renderer/popover.js:61-105`) — popover
  แบบเดียวกับ theme picker (`openThemeMenu`, app.js:1550-1561)
- optimistic update ของ mode chip (`cycleMode`, app.js:1448-1457) — paint
  ก่อน แล้วให้ snapshot ของ server ชนะ / rollback เมื่อ error
- grok-desktop `formatToolVerb`/picker มาร์กตัวเลือกปัจจุบันด้วย ✓ เหมือน
  theme picker ของเรา

## วิธีแก้ไข

1. **`turn-view.js` (pure, testable)**: `configSelectsFromOptions()` —
   normalize configOptions ดิบเป็น selects {model, thinking} (shape เดียวกับ
   `AcpClient.configSelects` ฝั่ง server; thinking เป็น null เมื่อ model คิด
   ไม่ได้), `modelShortName()` — ตัด alias `kimi-code/k3` เหลือ `k3`,
   `configMenuItems()` — สร้างแถวเมนูพร้อม flag ตัวปัจจุบัน
2. **`index.html`**: pill 2 อันใน `.head-right` ก่อน mode chip — `#model-chip`
   แสดงชื่อสั้นของ model, `#effort-chip` แสดง effort; ใช้ class `pill mode`
   เดิม (style เดียวกับ mode chip, focus ring มีอยู่แล้ว)
3. **`app.js`**:
   - `state.chatConfig` เก็บ snapshot {model, effort, options} ของแชทที่เปิด
     (มาจาก GET /api/chats/:id ตอน selectChat; ล้างตอนไม่มีแชท)
   - `updateConfigPills()` — สถานะ degrade ที่ซื่อสัตย์: แชท cold (ยังไม่เคย
     spawn) pill แสดงค่าที่ persist ไว้แบบ **disabled** (ยังไม่มี options ให้
     เลือก — ไม่ใช่ซ่อน เพราะค่าปัจจุบันยังเป็นข้อมูลที่จริง); effort pill
     **ซ่อน** เมื่อ agent ไม่โฆษณา thinking select (model คิดไม่ได้, 0.36.1)
   - คลิก → `openConfigMenu()` เปิด openMenu จาก options ที่โฆษณา (มาร์ก ✓
     ตัวปัจจุบัน) → `setChatConfig()` ยิง POST /config แบบ optimistic +
     rollback เมื่อ error (แสดง showError ไทย)
   - SSE case `config_changed` → ใช้ snapshot ของ server ทับ (หน้าต่างอื่น
     เปลี่ยนก็ตาม); `config_option_update` → normalize แล้วเก็บ options ไว้
     โดยไม่ต้อง refetch — ทั้งคู่เฉพาะแชทที่เปิดอยู่ (turn state is per chat)
4. **`style.css`**: เพิ่มแค่ `.pill.mode:disabled { opacity: 0.55 }` —
   ไม่มีสีใหม่ ไม่กระทบคู่ contrast ที่ audit ไว้

## ไฟล์ที่เปลี่ยน

- `src/renderer/turn-view.js` — pure helpers 3 ตัว
- `src/renderer/app.js` — state, pills, menus, SSE cases, listeners
- `src/renderer/index.html` — pill 2 อัน + bump `?v=` 0.4.45→0.4.46
- `src/renderer/style.css` — rule disabled (opacity เท่านั้น)
- `scripts/unit-test-turn-view.mjs` — เพิ่ม 3 เคส (รวม 35)

## การทดสอบ

- `node scripts/unit-test-turn-view.mjs` → 35/35 (เพิ่ม:
  configSelectsFromOptions normalize ครบ shape + select ที่ไม่มี + garbage,
  modelShortName ตัด segment, configMenuItems flag ตัวปัจจุบัน)
- `npm test` เขียวครบ 21 suites (theme-contrast ผ่าน — ไม่มีสีใหม่; e2e 38/38)
- ข้อจำกัด: ตัว popover/pill render จริงใน WKWebView ไม่ได้คลิกทดสอบจาก
  สภาพแวดล้อมนี้ — ส่วนที่แยกเป็น pure function ถูก unit test ครบ และ flow
  ใช้ pattern เดียวกับ mode chip/theme picker ที่ใช้งานอยู่แล้ว

## วิธี revert

```bash
git log --grep='\[BUG-075\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
