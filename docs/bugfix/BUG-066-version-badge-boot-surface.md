# BUG-066 — ไม่มี version badge / หน้าจอนิ่งเงียบเมื่อ app.js ตายตอน boot

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

ถ้า `app.js` โหลดไม่สำเร็จหรือ throw ระหว่าง boot ผู้ใช้จะเห็น shell เปล่า ๆ
โดยไม่มีตัวบอกเลยว่า host ตัวไหนกำลังเสิร์ฟอยู่ หรือ host ตายไปแล้ว — แม้แต่
เลขเวอร์ชันของแอปก็ไม่มีที่ไหนแสดง (side-foot มีแค่ agent-badge กับปุ่มธีม)
ทั้งที่ `/api/version` มีอยู่แล้ว

## สาเหตุ (file:line)

- `src/renderer/index.html:30-33` — side-foot ไม่มี element สำหรับ version
- ไม่มีสคริปต์ early-paint แบบ standalone — ทุกอย่างพึ่ง `app.js` โหลดสำเร็จ
- `src/server/index.js:205-207` — `/api/version` ตอบ `{version, name}` อยู่แล้ว
  แต่ไม่มีฝั่ง renderer มาอ่าน

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/index.html:46-51` — element `#version-badge`
- `grok-desktop/src/renderer/index.html:427-485` — `paintVersionEarly()` inline
  standalone: fetch `/api/version` พร้อม AbortController 4 วินาที มี fallback
  ไป `/api/state` ทำงานได้แม้ app.js ตาย
- `grok-desktop/src/renderer/app.js:1027-1105` — `applyVersionBadge()`
  re-fetch หลัง boot เพื่อให้ badge ตรงกับ host ที่เสิร์ฟจริงเสมอ

## วิธีแก้ไข

เบี่ยงจาก grok จุดเดียวโดยมีเหตุผล: grok ฝังสคริปต์ early-paint แบบ inline ใน
index.html แต่ CSP ของ kimi (`script-src 'self'`, index.html:6-9) จะบล็อก
inline script — จึงย้ายโค้ดชุดเดียวกันออกมาเป็นไฟล์ภายนอก
`src/renderer/version-boot.js` โหลดด้วย `<script src>` ธรรมดา (pattern เดียว
กับ `theme-boot.js` ที่มีอยู่แล้ว) ยังคง standalone: ไม่ import อะไร ไม่พึ่ง
module graph ทำงานได้แม้ `app.js` โหลดไม่ขึ้น

1. **element** `#version-badge` ใน side-foot ระหว่าง agent-badge กับปุ่มธีม
2. **`version-boot.js`** (ใหม่): fetch `/api/version` ด้วย AbortController
   timeout 4s → fallback `/api/state` (ทั้งสอง endpoint ของ kimi คืน
   `version`/`name` ตรง ๆ ไม่มี `appVersion` wrapper เหมือน grok) → แสดง
   `v<version>`; ล้มเหลวหมดแสดง `?` + class `is-missing` ปรับสไตล์ var/
   function-expression ตาม grok เพื่อกันพังแม้สภาพแวดล้อม JS มีปัญหา
3. **`refreshVersionBadge()`** ใน `app.js` เรียกหลัง `refreshAgentBadge()`
   ใน `boot()` (ไม่ await — ไม่ควร block boot): re-fetch `/api/version`
   เป็น source of truth; ถ้าล้มเหลวจะ mark missing เฉพาะตอนที่ early paint
   ยังไม่เคยแสดงเวอร์ชันจริง
4. **CSS** `.version-badge` / `.is-missing` ถัดจาก `.agent-badge` ใช้ token
   ล้วน (`--fs-caption-2`, `--muted`, `--line-soft`, `--danger`)
5. bump `?v=` 0.4.42 → 0.4.43 ทั้ง 6 รายการ (theme-boot, style.css,
   theme-claude-light/dark, version-boot, app.js) — guard `css-guards`
   บังคับ uniform อยู่แล้ว

## ไฟล์ที่เปลี่ยน

- `src/renderer/index.html` — element badge + script tag + bump `?v=`
- `src/renderer/version-boot.js` — ไฟล์ใหม่ (early paint standalone)
- `src/renderer/app.js` — `el.versionBadge`, `refreshVersionBadge()`, เรียกใน `boot()`
- `src/renderer/style.css` — สไตล์ `.version-badge`

## การทดสอบ

- `node --check` ผ่านทั้ง `version-boot.js` และ `app.js`
- `npm test` เขียวทั้ง 18 suites (รวม css-guards ที่ยืนยัน `?v=` uniform และ
  boot order) — e2e 38/38
- ทดสอบเส้นทางลบด้วยมือ: เมื่อ host ตาย badge จะแสดง `?` + `is-missing`
  (fail path ของ version-boot.js); เมื่อ host ปกติ badge แสดง `v<version>`

## วิธี revert

```bash
git log --grep='\[BUG-066\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
