# BUG-083 — `npm test` ล้าง search index จริงของผู้ใช้

ความรุนแรง: major (test-infra — ทำข้อมูล derived หาย, กู้ได้ด้วย rebuild)

## อาการที่ผู้ใช้เห็น

ค้นอะไรในแอปก็ขึ้นว่างเปล่า ทั้งที่แชทมี 88 ห้อง

## หลักฐาน (2026-09-30 ~17:27)

- `/api/search/stats`: `chunks=156 sessions=15` ทั้งที่ store มี 88 แชท
- `sessions_dim` มีแต่ fixture ไร้สาระ (`title='x'` ×10, `hello`) —
  ตรงกับ fixture ใน `scripts/unit-test-turn-core.mjs` เป๊ะ
- `meta.rebuilt_at = 10:27:03Z` แต่ `host.log` ไม่มีบรรทัด rebuild
  รอบสอง → rebuild มาจาก process อื่น (test suite) ไม่ใช่เซิร์ฟเวอร์
- boot rebuild ตอน 12:55 ได้ `5481 chunks / 85 sessions` ถูกต้อง —
  ของจริงถูกล้างทีหลังโดย test run

## สาเหตุ

`unit-test-groups / goal-tasks / turn-core` สร้าง
`new SessionManager({ store, wire })` ด้วย temp chats.json
แต่ constructor hardwire `new SearchIndex()` ไม่มี `dbPath` →
เปิด `search.sqlite` จริงของผู้ใช้ → boot rebuild
(`setImmediate`) ล้าง index จริงแล้ว re-source จาก fixture
store ของเทส — ทุกรอบที่รัน `npm test` คือล้างหนึ่งรอบ

## วิธีแก้ไข

- `src/server/sessions.js` — constructor รับ `searchDbPath`
  ส่งต่อให้ `SearchIndex` (default คงเดิม: production ไม่เปลี่ยน)
- 3 suites ส่ง temp db path ทุกจุด (8 constructions) +
  regression test ใน groups (`zz9 hermetic marker` round-trip
  ผ่าน temp index)
- `src/renderer/index.html` — bump `?v=` 1.1.11→1.1.12
  (หนี้จาก release 1.1.12, ทำ mac-app suite แดง BUG-078)
- กู้ข้อมูลจริง: `POST /api/search/rebuild` → 5873 chunks /
  88 sessions, verify ค้นอังกฤษ+ไทยเจอ

## ไฟล์ที่เปลี่ยน

- `src/server/sessions.js` — `searchDbPath` seam
- `scripts/unit-test-groups.mjs` — temp db + regression test
- `scripts/unit-test-goal-tasks.mjs` — temp db
- `scripts/unit-test-turn-core.mjs` — temp db (6 จุด)
- `src/renderer/index.html` — `?v=1.1.12`

## วิธี verify

- `node scripts/unit-test-groups.mjs` (มีเคส seam ใหม่)
- `npm test` เต็ม 2 รอบ: เขียว 35/35 และ live index
  ยัง 5873/88 เท่าเดิมก่อน-หลังรัน
