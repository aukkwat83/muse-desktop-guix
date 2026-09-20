# BUG-079 — pill เลือก model/effort กดไม่ได้ (เหมือนถูก fix ไว้) บนแชทที่ยังไม่เคยส่งข้อความ

ความรุนแรง: major (ผู้ใช้รายงานจากการใช้งานจริง)

## อาการที่ผู้ใช้เห็น

pill model/effort (จาก BUG-075) บนแชทใหม่ที่ยังไม่เคยส่งข้อความกดไม่ได้เลย
(disabled) — ผู้ใช้อยากเลือก model/effort **ก่อน** prompt แรก แต่ทำไม่ได้
จนกว่าจะส่งข้อความไปแล้วครั้งหนึ่ง

## สาเหตุ (file:line)

- แชท cold (ไม่เคย spawn agent) → `GET /api/chats/:id` คืน
  `config.options: null` (BUG-074) → `updateConfigPills()`
  (`src/renderer/app.js`) disable ทั้งสอง pill ตามดีไซน์เดิม ("cold chat ไม่มี
  options ให้เลือก") — ดีไซน์ผิด ไม่ใช่สายไฟ: options ถูกผูกกับ live session
  ของแชทนั้น ทั้งที่ catalog ของ model/thinking เป็น **agent-wide** (CLI
  config เดียวกันทุกแชท มีแค่ currentValue ที่เป็นของแต่ละแชท) — catalog ที่
  เรียนรู้จาก session ไหนก็ได้ใช้เสิร์ฟแชท cold ได้ทุกแชท

## วิธีแก้ไข

### Server

1. **`src/server/config-catalog.js` (ใหม่)**: cache `{ model, thinking,
   fetchedAt }` persist เป็น JSON เล็ก ๆ ข้าง session store (stateDir เดียวกัน)
   — เติม/รีเฟรชทุกจุดที่จับ configOptions ได้: หลัง spawn ใน `ensureClient`,
   ใน `config_option_update` (sessions.js) และหลัง `setChatConfig` สำเร็จ
2. **`chatConfig()`**: options = live selects → cached catalog → null
   (เหมือนเดิมเมื่อไม่เคย spawn ที่ไหนเลย); ตอนใช้ cache จะ override
   currentValue ด้วยค่าของแชทนั้น — catalog เป็น agent-wide แต่ currentValue
   เป็นของแต่ละแชท
3. **`setChatConfig()` บนแชท cold**: validate กับ cached catalog เมื่อมี
   (400 เหมือน live); ถ้า **ไม่มี catalog เลย** → accept-and-persist เพราะ
   `applySessionConfig()` ข้ามค่าที่ agent ไม่โฆษณาอยู่แล้วตอน spawn
   (degrade ปลอดภัย ไม่มีทาง brick)
4. **route ใหม่ `POST /api/chats/:id/config-refresh`**: prewarm ผ่าน
   `ensureClient()` (spawn + session/new **โดยไม่ส่ง prompt**) แล้วรีเฟรช
   catalog และตอบ `{ config }` shape เดียวกับ GET; error (auth/spawn) →
   error JSON shape เดียวกับ route อื่น

### Renderer

5. `updateConfigPills()`: pill กดได้เสมอเมื่อมี options (ตอนนี้มาจาก cache
   ได้สำหรับแชท cold); effort pill ยังซ่อนเมื่อ select ไม่มี (model คิดไม่ได้)
6. คลิก pill ตอน **ไม่มี options เลย** (fresh install ไม่เคย spawn ที่ไหน):
   เปิดเมนูที่มี item disabled `กำลังดึงรายการ…` แล้วยิง config-refresh →
   สำเร็จ: repaint + เปิดเมนูใหม่ด้วยรายการจริง (กันวนซ้ำเมื่อ select นั้นไม่มี
   จริง เช่น thinking บน model ที่คิดไม่ได้); ล้มเหลว: `showError` ไทย —
   **ไม่** auto-prewarm ตอนเลือกแชท (spawn ทุกครั้งที่คลิกผ่าน = สิ้นเปลือง)

## พฤติกรรมใหม่

- แชท cold เลือก model/effort ได้ทันทีจาก catalog cache (รอดแม้รีสตาร์ทโฮสต์)
- เครื่องที่เคย spawn แล้ว: คลิกแล้วเมนูขึ้นทันที
- fresh install ที่ไม่เคย spawn เลย: คลิกแรกรอ ~1-3 วิ (spawn จริง) ครั้งต่อไป
  ทันที (hot pool + cache)

## ไฟล์ที่เปลี่ยน

- `src/server/config-catalog.js` — ไฟล์ใหม่
- `src/server/sessions.js` — catalog wiring, chatConfig fallback,
  setChatConfig cold validation, `refreshChatConfig()`
- `src/server/index.js` — route config-refresh
- `src/renderer/app.js` — updateConfigPills/openConfigMenu/prewarmConfigMenu
- `src/renderer/index.html` — `?v=` 0.4.48→0.4.49 + `package.json`/`package-lock.json`
  0.4.49 (กฎ BUG-078 — guard ข้อ 7 บังคับคู่กัน)
- `scripts/unit-test-config-options.mjs` — 16 เคส (เพิ่ม 7 + inject tmp catalog
  ทุก test กันรั่วเข้า state dir จริง)

## การทดสอบ

- `node scripts/unit-test-config-options.mjs` → 16/16 (catalog round-trip,
  cold fallback + currentValue ของแชทชนะ, config_option_update เติม catalog,
  cold validation 400/accept, thinking ถูกปฏิเสธเมื่อ model คิดไม่ได้,
  refreshChatConfig คืน selects)
- `npm test` เขียวครบ 21 suites (e2e 38/38)
- ตรวจ live หลัง deploy กับแชท cold จริง: GET → options จาก cache, POST
  config-refresh → selects จริงจาก agent, GET ซ้ำ → options ครบ

## วิธี revert

```bash
git log --grep='\[BUG-079\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
