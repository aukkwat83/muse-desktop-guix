# BUG-050 — draft ที่พิมพ์ค้างหายเมื่อ reload

ความรุนแรง: minor

## อาการที่ผู้ใช้เห็น

พิมพ์ข้อความยาว ๆ ค้างไว้ใน composer แล้วหน้าต่าง reload (หรือ WKWebView
รีโหลด) — ข้อความที่พิมพ์หายหมด ทั้งที่ยังไม่ได้ส่ง

## สาเหตุ (file:line)

- `src/renderer/app.js` (ก่อนแก้) :57 — draft เก็บใน `state.drafts` เป็น Map
  ในหน่วยความจำล้วน ๆ ไม่มี mirror ลง storage — reload คือทิ้งทั้งหมด

## อ้างอิง grok-desktop (file:line)

- `grok-desktop/src/renderer/composer-draft.js:53-164` —
  `createComposerDraftStore()`: Map ต่อ chatId + mirror ทุก set/delete ลง
  sessionStorage ใต้ key `gd.composerDraft.<id>`, อ่านแบบ lazy rehydrate
  (Map miss → storage), storage ที่ throw (private mode/quota) ถูกกลืนให้
  Map ยังทำงาน
- (binder ครึ่งหลัง composer-draft.js:176-219 ไม่ได้พอร์ต — kimi ทำ
  save/restore sync ใน `selectChat()` โดยตรงตั้งแต่ BUG-043 การมี binder
  ซ้ำจะเป็น dead code)

## วิธีแก้ไข

- `src/renderer/composer-draft.js` (ใหม่, pure — storage ถูก inject ตอนเทส):
  `createComposerDraftStore()` พอร์ตแบบ lean จาก grok, prefix
  `kd.composerDraft.` — API: get/set/clear/clearAll/has/size
  - `set(id, '')` หรือ `clear(id)` ลบ storage key (draft ว่างไม่ทิ้งขยะ)
- `src/renderer/app.js`:
  - ลบ `state.drafts` (Map) แล้วใช้ module-level
    `const drafts = createComposerDraftStore()` แทน
  - จุดเรียกเดิมทั้ง 5 (save ตอนสลับแชท, restore ใน selectChat, input
    listener, submitPrompt, deleteChat) เปลี่ยนมาใช้ store —
    `delete()` → `clear()` (ลบ storage key ด้วย แชทที่ถูกลบไม่ทิ้ง draft ค้าง)

## ไฟล์ที่เปลี่ยน

- `src/renderer/composer-draft.js` — โมดูล pure ใหม่
- `src/renderer/app.js` — import + เปลี่ยน state.drafts เป็น store
- `src/renderer/index.html` — bump `?v=` 0.4.28 → 0.4.29
- `scripts/unit-test-composer-draft.mjs` — suite ใหม่ (10 เคส)
- `scripts/unit-test-all.mjs` — ลงทะเบียน suite composer-draft

## การทดสอบ

- unit (`composer-draft`): roundtrip, mirror key, lazy rehydrate ข้าม store
  instance (จำลอง reload), set('')/clear ลบ key และ store ใหม่ไม่ชุบชีวิต,
  clearAll, empty id no-op, has() ทั้งสองชั้น, storage throw → Map ยังทำงาน,
  persist:false ไม่แตะ storage
- `npm test` เขียวทุก suite (12 suites: unit 11 + e2e 37/37)

## วิธี revert

```
git log --grep='\[BUG-050\]' --oneline   # เอา hash ล่าสุดจากตรงนี้
git revert <hash>
```
