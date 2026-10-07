# BUG-081 — กดเมนู Host แล้ว crash: non-ASCII title บน Swift-native string

ความรุนแรง: major (crash ทั้งแอป)

## อาการที่ผู้ใช้เห็น

กดเมนู Host บน menu bar ปุ๊บแอปหายทันที — แค่เปิดเมนูแล้วเมาส์แตะ
item ใดๆ ก็ล้ม (`EXC_BREAKPOINT`/`SIGTRAP`) เกิด 3 ครั้งติดวันที่
30 ก.ย. และเคยเกิดแล้ว 29 ก.ย. บน v1.1.7 (Xcode ตัวเก่า) → บั๊กอยู่
ในโค้ด ไม่ใช่ toolchain ใหม่

## สาเหตุ (file:line)

- `macos/MuseDesktopShell/Sources/MuseDesktopShell/MuseDesktopShellApp.swift`
  (ก่อนแก้) — เมนู Host เป็น SwiftUI `CommandMenu` + `Button("เปิด log
  ของ host")` ฯลฯ SwiftUI ส่ง Swift-native (UTF-8-backed) string เป็น
  `NSMenuItem` title; AppKit เรียก `-[NSMenuItem _description:]` ทุกครั้ง
  ที่ highlight item (ผ่าน `_NSNoteInCrashReports`) → `getBytes` →
  `__StringStorage.getCharacters(_:range:)` → `String.UTF16View._indexRange`
  assertion trap (stack เดียวกันทั้ง 4 `.ips`)
- ต้นตอเป็นบั๊กฝั่ง platform (Swift stdlib ↔ Foundation bridging บน
  macOS 26): reproduce ได้ด้วย `NSMenuItem` เปล่าๆ — title ไทย/จีน/
  emoji/ฝรั่งเศส (มี accent) ล้มหมด, ASCII ล้วนผ่าน; ข้อความเดียวกันที่
  ผ่าน `NSString` (Foundation-owned storage) ไม่ล้ม

## วิธีแก้ไข

- ย้ายเมนู Host จาก SwiftUI `CommandMenu` ไปสร้างด้วย AppKit ล้วนใน
  `AppDelegate.installHostMenu` (แทรกก่อนเมนู Window)
- ทุก title ผ่าน `nsTitle(_:)` = `NSString(string:) as String` บังคับ
  Foundation-owned storage — เมนูไทย 4 รายการเดิมครบถ้วน
- action เดิมทั้ง 4 (เปิด log/state, restart/stop host) ย้ายเป็น
  `@objc` methods บน AppDelegate (responder chain หาเจอ)
- กันเมนูหายถ้า SwiftUI ยังไม่ทันติดตั้ง mainMenu: retry 1 tick +
  `hostMenuInstalled` flag กันติดตั้งซ้ำ

## ไฟล์ที่เปลี่ยน

- `macos/.../MuseDesktopShellApp.swift` — ตัด `CommandMenu("Host")`,
  เพิ่ม `installHostMenu` + `nsTitle` + 4 `@objc` actions
- `scripts/probe-menu-titles.swift` — probe ใหม่ ยิง
  `NSMenuItem.description` ตรงๆ บน title ที่ ship จริง
- `scripts/test-mac-app.mjs` — 2 pins (ห้ามย้ายเมนูกลับไป
  SwiftUI, ทุก title ต้องผ่าน helper)
- `package.json` — script `test:menutitle`

## การทดสอบ

- `swift scripts/probe-menu-titles.swift` — 5/5 ผ่าน
- `npm run test:mac-app` — เขียว (รวม 2 pins ใหม่)
- `npm test` — 35 suites เขียวทั้งหมด (รวม e2e-mock-agent 58/58)
- `bash scripts/deploy.sh` — health gate + e2e ผ่าน, เปิดแอปได้ปกติ

## วิธี revert

```
git log --grep='\[BUG-081\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
