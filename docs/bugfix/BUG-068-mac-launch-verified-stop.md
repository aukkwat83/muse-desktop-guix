# BUG-068 — stop fallback ของ mac-launch.sh kill pid ที่ไม่ได้ verify

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

`npm run mac:stop` เมื่อ host ไม่ตอบ HTTP shutdown จะยิง `kill -TERM` ไปที่
pid ที่อ่านจาก `host.pid` ตรง ๆ — pid ในไฟล์อาจค้างจาก crash เก่า แล้ว macOS
เอา pid นั้นไปให้ process อื่นแล้ว สัญญาณจึงอาจไปโดน process ที่ไม่เกี่ยว
ข้อง — อันตรายเดียวกับที่ `HostSupervisor.swift` ของตัวเองเขียนเตือนและกันไว้
ทุกจุด ยกเว้นจุดนี้

## สาเหตุ (file:line)

- `scripts/mac-launch.sh:161-167` — fallback หลัง HTTP shutdown ล้มเหลวทำ
  `kill -TERM "$(cat "$STATE/host.pid")"` โดยไม่ยืนยันความเป็นเจ้าของ pid

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/scripts/test-mac-app.mjs:60-65` — assertion "PID ownership
  via /api/state pid before kill"
- ต้นแบบพฤติกรรม: `kimi-desktop/macos/.../HostSupervisor.swift:221-240`
  (`verifiedOursPid` — pid จาก `/api/state` เป็น authoritative เท่านั้น;
  ไฟล์เป็นเพียง hint และปฏิเสธ kill เมื่อ verify ไม่ได้)

## วิธีแก้ไข

เขียน fallback ใหม่ให้ mirror `verifiedOursPid`:

1. `curl GET /api/state` แล้วดึง `pid` ด้วย sed (ไม่เพิ่ม dependency — เครื่อง
  มี sed เสมอ และ payload ของ host เรียง `"pid":N` ไว้ต้น JSON)
2. สั่ง `kill -TERM` เฉพาะเมื่อ pid ที่ได้เป็นตัวเลขล้วน **และ** `kill -0`
   ยืนยันว่ามีชีวิตอยู่ — pid จาก API เป็น authoritative เพราะมีแค่ host ของ
   เราที่ตอบบนพอร์ตนั้น
3. ถ้า verify ไม่ได้ → ปฏิเสธ พิมพ์ "refusing to signal anything" ไป stderr
   (ข้อความเดียวกับฝั่ง Swift เพื่อ grep เจอคู่กัน)

ขยาย `scripts/test-mac-app.mjs` (suite จาก BUG-067) เพิ่ม 2 เคส: fallback
ต้อง curl `/api/state` ก่อนส่งสัญญาณ และต้องไม่มี pattern
`kill -TERM "$(cat …"` เหลืออยู่

## ไฟล์ที่เปลี่ยน

- `scripts/mac-launch.sh` — stop fallback แบบ verified pid
- `scripts/test-mac-app.mjs` — เพิ่ม 2 static assertions (รวม 15 เคส)

## การทดสอบ

- `bash -n scripts/mac-launch.sh` ผ่าน
- `node scripts/test-mac-app.mjs` → 15/15; `npm test` เขียว 19 suites
- ทดสอบจริงกับ fake host (HTTP server บนพอร์ต scratch ที่ตอบ `/api/state`
  ด้วย pid ตัวเอง): pipeline curl+sed ดึง pid ถูกต้อง และ regex guard ผ่าน;
  เส้นทางพอร์ตตาย → extraction ว่าง → เข้าเงื่อนไข refuse ถูกต้อง
- ข้อจำกัด: การยิง `kill -TERM` จริงและการรัน `mac-launch.sh stop` เต็มรูปแบบ
  ถูก sandbox ของสภาพแวดล้อมนี้บล็อก (process control) — บรรทัด kill เป็น
  pattern มาตรฐานและถูกปักด้วย static assertion แล้ว; เส้นทาง HTTP shutdown
  ปกติถูกครอบคลุมโดย e2e suite อยู่แล้ว

## วิธี revert

```bash
git log --grep='\[BUG-068\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
