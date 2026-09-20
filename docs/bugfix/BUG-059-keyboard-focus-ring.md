# BUG-059 — โฟกัสจากคีย์บอร์ดมองไม่เห็นเกือบทุก control

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

กด Tab ไล่ผ่านปุ่มต่าง ๆ (new chat, theme toggle, mode chip, แถว session,
หัว tool row, ปุ่มในการ์ด) แทบไม่มีอะไรเปลี่ยนบนจอ — ดูเหมือน Tab ไม่ทำงาน
ยกเว้นในเมนู popover; ปุ่ม icon ที่ซ่อนด้วย opacity: 0 (⋯, ✕, ปุ่ม group)
ยิ่งแล้วไปกันใหญ่ — โฟกัสอยู่แต่ปุ่มยังมองไม่เห็น

## สาเหตุ (file:line)

- `src/renderer/style.css` (ก่อนแก้) :613-617 — มี rule `:focus-visible` เพียง
  อันเดียวของทั้งไฟล์ คือ `.pop-item`; ไม่มี token `--focus-ring` เลย
- ปุ่มทุก family (.btn :120, .icon-btn :227, .group-btn :359, .session-main,
  .pill.mode, .tool-head :1173, .cwd, .jump-latest, .prompt-queue-chip,
  .history-load-older button) ไม่มี focus style — พึ่ง UA default ที่จมหายกับ
  พื้น panel
- `.icon-btn` / `.group-btn` / `.s-del` ถูกซ่อนด้วย `opacity: 0` จนกว่าจะ
  hover แถว (:227, :359, :566) — keyboard focus ไม่เคยเปิดให้เห็น

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/style.css:93` — token `--focus-ring` (override
  ต่อธีม: theme-claude-light.css:77, theme-claude-dark.css:73)
- `grok-desktop/src/renderer/theme-claude-light.css:167-177` —
  `box-shadow: 0 0 0 3px var(--focus-ring)` บน `:focus-visible` ของ control
- `grok-desktop/src/renderer/style.css:823-829` — focus-visible คู่กับ
  reveal ของ resizer (focus ต้องทำให้ control ที่ซ่อนอยู่ปรากฏด้วย)

## วิธีแก้ไข

- เพิ่ม token `--focus-ring` ทั้งสามธีม (โทน accent ของธีมนั้น, alpha 0.3-0.35):
  moonlight `rgba(139,124,246,.35)`, daylight `rgba(98,72,221,.3)`,
  claude-light `rgba(181,87,58,.3)`
- `src/renderer/style.css` — rule เดียวหลัง block ปุ่ม: `:focus-visible` ของ
  ทุก control ที่โฟกัสได้ (.btn, .icon-btn, .group-btn, .group-expand,
  .group-name, .dashed-tab, .session-main, .s-del, .pill.mode, .cwd,
  .tool-head, .jump-latest, .prompt-queue-chip, .prompt-queue-remove,
  .history-load-older button, .pop-item) → `outline: none` + `box-shadow: 0 0
  0 3px var(--focus-ring)`; text input คงพฤติกรรมเดิม (ขอบ accent อยู่แล้ว)
- rule เล็กอีกอัน: `.icon-btn/.group-btn/.s-del:focus-visible { opacity: 1 }`
  — focus ต้องเปิดปุ่มที่ hover-reveal ให้เห็น ไม่อย่างนั้น ring ไปอยู่บนปุ่ม
  ที่มองไม่เห็น
- ลงทะเบียน `--focus-ring` ในรายการ required tokens ของ contrast audit
  (token coverage) — ring เป็น decorative ไม่เข้า PAIRS

## ไฟล์ที่เปลี่ยน

- `src/renderer/style.css` — token 2 บล็อก + focus rules 2 กลุ่ม
- `src/renderer/theme-claude-light.css` — token --focus-ring
- `scripts/unit-test-theme-contrast.mjs` — required tokens เพิ่ม --focus-ring
- `src/renderer/index.html` — bump `?v=` 0.4.37 → 0.4.38 (ทุก ref)

## การทดสอบ

- `npm run test:contrast` — token coverage ผ่านทั้งสามธีม (moonlight 28,
  daylight 26, claude-light 27 tokens)
- `npm test` เขียวทุก suite (17 suites: unit 16 + e2e 38/38)
- ตรวจด้วยมือ: Tab ไล่ทุกปุ่มเห็น ring โทน accent; Tab ไปที่ ปุ่ม ⋯/✕ ในแถว
  session แล้วปุ่มปรากฏพร้อม ring

## วิธี revert

```
git log --grep='\[BUG-059\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
