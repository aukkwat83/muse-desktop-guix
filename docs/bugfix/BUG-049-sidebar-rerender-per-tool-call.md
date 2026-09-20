# BUG-049 — sidebar re-render ทั้งต้นทุก tool_call ของแชทที่กำลังดู

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

เปิดกล่อง rename group (หรือกล่อง "group ใหม่") ค้างไว้ขณะที่แชทกำลังรัน —
ทุก tool_call/tool_call_update ที่ไหลเข้ามาทำ sidebar re-render ทั้งต้น กล่อง
ที่กำลังพิมพ์ถูก detach และสร้างใหม่ โฟกัสหลุด (commitOnRealBlur กันการ commit
ปลอมไว้ แต่โฟกัสที่หายไปกลางคำยังน่ารำคาญและ caret หาย)

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้):
  - `tool_call` / `tool_call_update` handler (:612-625) เรียก
    `updateRunningChrome()` ทุก event
  - `updateRunningChrome()` (:575) ปิดท้ายด้วย `renderSidebar()` เสมอ — ทั้งที่
    สิ่งที่ sidebar แสดง (pulse/จำนวน running) ไม่ได้เปลี่ยนจาก tool event เลย

## อ้างอิง grok-desktop (file:line)

- grok-desktop re-render sidebar เฉพาะตอน status transition หรือ session
  payload เปลี่ยน (เช่น `applySessionsPayload` จาก select/created/updated)
  ไม่มี path ที่ tool event ของ session ที่กำลังดูไป trigger full re-render
  ของ sidebar

## วิธีแก้ไข

- `updateRunningChrome()` ไม่เรียก `renderSidebar()` ตรง ๆ อีก แต่เรียก
  `updateRunningSidebar()` ใหม่:
  - คำนวณ signature = ชุด chat id ที่ running (รวม compensation `c.running ||
    isRunning(c.id)` แบบเดียวกับ renderSidebar) เรียงแล้ว join
  - signature เปลี่ยน → `renderSidebar()` เต็มรูปแบบ (ต้องอัปเดต group count
    "1/3", badge ฯลฯ)
  - signature เดิม → อัปเดต pulse ในที่ (toggle `is-running` / `s-pulse.on`
    ต่อแถว) ไม่แตะโครงสร้าง DOM — กล่อง rename/new-group ที่เปิดอยู่ไม่หลุด
- guard เดิมของ sidebar ที่เก็บ `renameValue`/`draftValue` ข้าม re-render
  คงไว้เหมือนเดิม (ยังจำเป็นสำหรับ re-render จาก path อื่น เช่น refreshChats)

## ไฟล์ที่เปลี่ยน

- `src/renderer/app.js` — updateRunningChrome แยก updateRunningSidebar พร้อม
  running-signature cache
- `src/renderer/index.html` — bump `?v=` 0.4.27 → 0.4.28

## การทดสอบ

- `npm test` เขียวทุก suite (e2e 37/37 ครอบ tool_call stream → settle)
- ตรวจด้วยมือ: เปิด rename ค้างไว้ขณะเทิร์นกำลังรัน → กล่องไม่หลุดโฟกัสเมื่อ
  tool event เข้า; เทิร์นเริ่ม/จบ → pulse ขึ้น/หายถูกต้อง

## วิธี revert

```
git log --grep='\[BUG-049\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
