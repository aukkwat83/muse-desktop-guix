# BUG-069 — ไม่มี deploy pipeline

ความรุนแรง: major

## อาการที่ผู้ใช้เห็น

ไม่มีวิธี deploy แบบคำสั่งเดียว: มีแค่ `mac-launch.sh` (open/build/host/stop)
ไม่มี health-verified start, ไม่มี post-deploy smoke, ไม่มี status —
deploy แล้วไม่รู้ว่า host ขึ้นจริงไหมจนกว่าจะเปิดแอปเอง

## สาเหตุ (file:line)

- `package.json` ไม่มี script `deploy*` เลย; มีเพียง `mac`/`mac:build`/
  `mac:host`/`mac:stop`
- ไม่มี `scripts/deploy.sh`

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/scripts/deploy.sh` (ทั้งไฟล์) — deps → Node ≥20 → launcher →
  CLI check → detached start (pid/log) → health gate `/api/state` → open →
  optional PoC; npm scripts deploy/deploy:start/deploy:stop/deploy:status
- จุดที่**ไม่**พอร์ตมา: `stop_server()` ของ grok kill pid จากไฟล์ตรง ๆ แล้ว
  `kill -9` ซ้ำ + `fuser -k` — ขัดกับ verified-shutdown discipline ของ kimi
  (HostSupervisor.swift:221-240 และ BUG-068)

## วิธีแก้ไข

สคริปต์ใหม่ `scripts/deploy.sh`:

1. **deps**: `npm install` เฉพาะเมื่อ `node_modules/marked` หาย; assert Node
   ≥ 20
2. **build**: เรียก `mac-launch.sh build` (swift build + wrap_app) —
   `https_proxy` ถูก export ล่วงหน้าจาก `SCB_PAC_PROXY` (default
   `http://127.0.0.1:39080`, behavior เดิมของ `acp-client.js spawnEnv`)
   ทำให้ `nc` probe ใน mac-launch.sh short-circuit — **deploy path ไม่ probe/
   ไม่แตะ proxy process เลย** ใช้แค่ URL เป็น env (ได้รับอนุญาตอยู่แล้ว)
3. **stop old host**: รูทผ่าน `mac-launch.sh stop` เสมอ (HTTP
   `/api/host/shutdown` ก่อน, verified-pid SIGTERM fallback ของ BUG-068) —
   deploy ไม่ re-implement สัญญาณเอง
4. **start**: detached `NO_OPEN=1 nohup node src/server/index.js` log ไปที่
   `$STATE/host.log`; `host.pid` host เขียนเองตอน listen (index.js:470)
5. **health gate**: poll `GET /api/state` ≤15s ไม่ผ่าน → fail พร้อมชี้ log
6. **smoke**: `npm run test:e2e` — self-contained (host+mock agent ของตัวเอง
   บนพอร์ตสุ่ม 3900–4299) ไม่ชนพอร์ต 3849 ของ host จริง ไม่ต้อง login
   (`test:acp` ยังเป็น opt-in เพราะต้อง interactive login)
7. **open**: `open dist/KimiDesktop.app` เว้นแต่ `NO_OPEN`/`CI`

`package.json` เพิ่ม `deploy`, `deploy:stop`, `deploy:status`
ขยาย `scripts/test-mac-app.mjs` เพิ่ม 7 เคสปักขั้นตอนสำคัญ: shutdown-first,
health gate, detached nohup, Node ≥20, smoke, **no pkill/fuser/lsof/nc** และ
npm scripts ครบ

## ไฟล์ที่เปลี่ยน

- `scripts/deploy.sh` — ไฟล์ใหม่
- `package.json` — เพิ่ม deploy / deploy:stop / deploy:status
- `scripts/test-mac-app.mjs` — เพิ่ม 7 static assertions (รวม 22 เคส)

## การทดสอบ

- `bash -n scripts/deploy.sh` ผ่าน
- `node scripts/test-mac-app.mjs` → 22/22; `npm test` เขียว 19 suites
- ผล deploy จริงบนเครื่องนี้: ดูหัวข้อ "ผล deploy จริง" ด้านล่าง

## ผล deploy จริง

รัน `NO_OPEN=1 bash scripts/deploy.sh` บนเครื่องนี้หลัง commit แรก:

- **ก่อน deploy**: ไม่มี host บนพอร์ต 3849 (curl ขึ้น connection refused)
- **deps/build**: node v26.1.0 · npm 11.13.0; swift build 8.43s; bundle
  `dist/KimiDesktop.app` v0.4.0 พร้อม AppIcon.icns
- **start + health gate**: host healthy pid 25840 ที่ `http://127.0.0.1:3849`
- **smoke**: `npm run test:e2e` → 38/38 ผ่านบน host แยกพอร์ตของตัวเอง
  (host จริงไม่ถูกแตะ)
- **--status**: ตอบ JSON `/api/state` ครบ (pid/version/stats/stateDir)
- **--stop**: "host shutting down" ผ่าน HTTP shutdown ทางแรก (ไม่ต้องถึง
  verified-pid fallback); พอร์ตปิดสนิท — คืนสถานะเดิม (ไม่มี host ค้าง)
  เพราะก่อน deploy ก็ไม่มี host ของ session ผู้ใช้รันอยู่
- ไม่มีขั้นตอนใดแตะ proxy process 127.0.0.1:39080 (ใช้เป็น env var เท่านั้น)

## วิธี revert

```bash
git log --grep='\[BUG-069\]' --oneline   # หา hash ของ commit นี้
git revert <hash>
```
