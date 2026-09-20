# Muse Desktop v1.0.0

**Tag:** `v1.0.0`  
**Date:** 2026-09-21  
**Repo:** https://github.com/aukkwat83/muse-desktop

แอป desktop สำหรับ **Muse CLI** — หน้าต่างแชท native คุยกับ agent จริงผ่าน MSP
(`muse serve`) ไม่ใช่ chat API ปลอม fork มาจาก `kimi-desktop` แล้วพอร์ตสายส่ง
ACP → MSP ทั้งเส้น

---

## สรุปหนึ่งย่อหน้า

Muse Desktop v1.0.0 เป็น stable แรก: เปิดหลายแชท/หลาย group, สตรีม realtime,
ค่าเริ่มต้น yolo + ultra, แผง MCP/subagent/tasks/goal/context/usage ใน header,
วาด mermaid diagram พร้อมปุ่ม copy/download, ค้นหาข้อความข้ามทุกแชทแบบ substring
(ไทยกลางคำก็เจอ), แนบไฟล์/รูปโดยไม่ปนข้อความ — ทั้งหมดมี test คลุม (`npm test`
27 suites + e2e 54/54)

---

## ฟีเจอร์หลัก

### 1. แชท + เอเจนต์จริง (MSP)

| ทำอะไรได้ | รายละเอียด |
|-----------|------------|
| คุยกับ Muse CLI | spawn `muse serve`, session แบบ durable, resume ได้ |
| ค่าเริ่มต้น | แชทใหม่ = **yolo + ultra** (เปลี่ยนได้ต่อแชท) |
| สตรีมไว | text-only fast path + batch 8ms + markdown 32ms |
| ซ่อนค่า cold-start | พิมพ์แล้ว warm agent ล่วงหน้า (~20s MCP connect หายไป), UI บอกตรงๆ ตอนกำลังเตรียม |
| Approval / คำถาม | approval card + ask card กลาง transcript |

### 2. แผงสถานะใน header

| แผง | รายละเอียด |
|-----|------------|
| MCP | รายชื่อ server + สถานะ + ปุ่มเปิด/ปิด + reload, จำ last-used ข้ามรีสตาร์ท |
| Subagent | เห็น agent ย่อยตอนทำงาน กด drill-down ดูรายตัว |
| Tasks / Goal | chip จำนวนงาน + goal พร้อม % กดดูรายละเอียด |
| Context | แถบ context แบบ grok + ยอด used/limit ของ session |
| Usage | โควต้า 5h + weekly พร้อมเวลารีเซ็ต |

### 3. Mermaid diagram (ลอก grok-desktop)

| ทำอะไรได้ | รายละเอียด |
|-----------|------------|
| วาดอัตโนมัติ | ` ```mermaid ` กลายเป็นการ์ด SVG (สตรีมเสร็จวาดทันที ไม่ต้องรอจบเทิร์น) |
| ⧉ Mermaid | copy เป็น fence วางใน gitdop/GitLab แล้ว render เหมือนกัน |
| ↓ SVG / ↓ PNG | ดาวน์โหลดผ่าน host ลง ~/Downloads + reveal ใน Finder |
| Hero | `mermaid-hero` / `viz` ได้กล่องใหญ่ยึดเวที |
| ตามธีม | เปลี่ยนธีมแล้ว re-tint จาก source ที่เก็บไว้ |
| พังอย่างสุภาพ | วาดไม่ได้โชว์ source + เหตุผล, echarts โดน soft-block ตามนโยบาย Mermaid-only |

### 4. ค้นหาข้ามแชท (FTS5 trigram)

| ทำอะไรได้ | รายละเอียด |
|-----------|------------|
| กล่องค้นหาแถบซ้าย | substring ทุกแชท — `ค้นหา` เจอใน `ระบบค้นหาไฟล์แนบ`, `erma` เจอ `mermaid` |
| Operator | `group:` `kind:` `in:`/`surface:` `is:running` `session:` |
| ⌘F find-in-chat | ค้นเฉพาะเนื้อหาที่ AI generate ในแชทนี้ + Enter/Shift+Enter เดินผล |
| Deep-link | กดผลแล้วเปิดแชท/ขยาย history + flash ข้อความเป้าหมาย |
| ไม่ล่มไม่ปิด | boot rebuild ทุกแชท, db พัง quarantine + สร้างใหม่เอง, binding หายพังแบบเสียงดัง (ไม่มี silent disable) |

### 5. แนบไฟล์ (UX แบบ grok, สายส่งสะอาดกว่า)

| ทำอะไรได้ | รายละเอียด |
|-----------|------------|
| Picker macOS | เลือกไฟล์/โฟลเดอร์ได้หลายรายการ + ช่องวาง path สำรอง |
| Paste / Drop | วาง screenshot หรือลากไฟล์ลง composer ได้เลย |
| ไม่รวม prompt | รูปไปเป็น MSP `image` part, ไฟล์เป็น `@path` ใน text part แยก — ข้อความเราเก็บ verbatim + chips ใต้ bubble |
| จำกัด | รูปละ ≤15MB (≤10 รูป/เทิร์น), mention ≤32 path/เทิร์น |

### 6. งานไม้

แถบซ้ายลากขยายได้ (จำความกว้าง, ดับเบิลคลิก reset), คอลัมน์ result เต็มขอบตาม,
dock icon spark ฟ้า, 4 ธีม (moonlight / daylight / claude-dark / claude-light)

---

## การยืนยัน

- `npm test` — 27/27 suites (รวม viz-contract 20, search 18, attach 11 เคสใหม่), e2e 54/54
- Live: vendor mermaid เสิร์ฟ 200, search ของจริง 108 chunks / 6 sessions ใน 22ms,
  เทิร์นแนบรูปกับ agent จริงเห็นรูปถูกต้อง (ตอบขนาด 1px PNG ถูก)
- ข้อความ user ที่แนบไฟล์เก็บ verbatim (ตรวจแล้วไม่มี `@` ปน), ไฟล์แนบอยู่ใน meta

## อัปเกรด

```bash
cd ~/muse-desktop
git pull --ff-only
npm install          # better-sqlite3 + mermaid (ครั้งแรกครั้งเดียว)
./scripts/deploy.sh  # รันเทส + deploy http://127.0.0.1:3850 + เปิด MuseDesktop.app
```

ข้อมูลเดิม (`~/.local/state/muse-desktop/chats.json`) ใช้ต่อได้เลย —
index ค้นหาสร้างใหม่เองตอน boot ครั้งแรก
