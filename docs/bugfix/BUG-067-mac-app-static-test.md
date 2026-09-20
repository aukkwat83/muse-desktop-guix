# BUG-067 — ไม่มี static test ปัก invariant ของ mac shell

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

ไม่มีอาการปัจจุบัน — เป็นช่องว่างของการป้องกัน: invariant ที่พอร์ตมาจาก
grok-desktop (stateDir แบบ XDG เท่านั้น, verify pid ก่อน kill, shutdown
แบบ HTTP-first) เป็นโค้ด Swift/เชลล์ที่รีวิวมองไม่เห็นการถูกถอดออก
จนกว่าจะระเบิดตอนรันจริง (เช่น kill ผิด process เพราะ macOS recycle pid)

## สาเหตุ (file:line)

- ไม่มีไฟล์ทดสอบเลย — `macos/KimiDesktopShell/.../HostSupervisor.swift:221-240`
  (`verifiedOursPid`), `:161-172` (`stopHostAndAgents` HTTP-first) และ
  `scripts/mac-launch.sh:113-126` (LSEnvironment proxy keys) ไม่มีตัวดัก

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/scripts/test-mac-app.mjs:46-134` — static checks บน
  HostSupervisor.swift / mac-launch.sh / index.js + live probes แบบไม่ POST
  shutdown

## วิธีแก้ไข

สคริปต์ใหม่ `scripts/test-mac-app.mjs` (13 เคส) ปรับ path และข้อเท็จจริงให้
ตรง kimi:

1. **HostSupervisor.swift**: stateDir เป็น XDG `~/.local/state` เท่านั้น
   (ไม่มี `applicationSupportDirectory`), ยิง `/api/host/shutdown`,
   มี `verifiedOursPid`/`fetchStatePid` พร้อมข้อความปฏิเสธ kill,
   `restart` ผ่าน `lifecycleGate` + `waitUntilUnhealthy`,
   `stopHostAndAgents` ใช้ HTTP ก่อน
2. **wiring**: Host menu เรียก `stopHostAndAgents` (KimiDesktopShellApp.swift),
   toolbar ใช้ `/api/memory` (ContentView.swift)
3. **mac-launch.sh**: export proxy vars, LSEnvironment มี proxy keys ครบ,
   STATE เป็น XDG kimi-desktop
4. **index.js**: ลงทะเบียน `POST /api/host/shutdown`, `/api/state` เปิด
   `pid`, host เขียน `host.pid` ตอน listen
5. **live probes** (ข้ามเมื่อ host ดับ): GET `/api/state` มี pid ตัวเลข,
   GET `/api/version` ok — และแทนที่จะ OPTIONS แบบ grok (kimi ไม่มี OPTIONS
   handler) ใช้ GET probe ไปที่ `/api/host/shutdown` แล้วยืนยันว่า **ไม่**
   ตอบ 200/202 และ host ยัง healthy — พิสูจน์ว่า verb gate กัน shutdown
   จาก GET อยู่ โดยไม่เสี่ยงฆ่า host จริง

เพิ่ม npm script `test:mac-app` และลงทะเบียน suite `mac-app` ใน
`scripts/unit-test-all.mjs` (รวม 19 suites)

## ไฟล์ที่เปลี่ยน

- `scripts/test-mac-app.mjs` — suite ใหม่ (13 เคส)
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite
- `package.json` — เพิ่ม `test:mac-app`

## การทดสอบ

- `node scripts/test-mac-app.mjs` → 13/13 (host ดับ → ข้าม live probes)
- `npm test` เขียว 19 suites — e2e 38/38
- ทดสอบเส้นทางลบ: regex `writeFileSync(PID_FILE, …)` ตัวแรกเข้มเกิน (ไม่รองรับ
  argument ที่สาม `'utf8'`) ทำให้ fail จริง — ยืนยันว่า assertion มีฟัน

## วิธี revert

```bash
git log --grep='\[BUG-067\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
