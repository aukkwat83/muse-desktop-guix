# บันทึกแก้บั๊ก (bugfix log)

ดัชนีรายงานบั๊กที่แก้ในรอบนี้ เรียงตามหมายเลข BUG — แต่ละรายการ commit
รวมโค้ด + รายงานไว้ด้วยกัน ดูรายละเอียดได้จากไฟล์รายงานของบั๊กนั้น

> คอลัมน์ commit ไม่ได้ฝัง hash ไว้ตรง ๆ — ค้น hash ล่าสุดของแต่ละบั๊กด้วย
> `git log --grep='\[BUG-NNN\]' --oneline` (เช่น `git log --grep='\[BUG-001\]' --oneline`)

| BUG | ชื่อ | ความรุนแรง | commit | ไฟล์รายงาน |
|-----|------|-----------|--------|------------|
| BUG-001 | การ์ดขออนุญาตว่างเปล่ากับ agent จริง (blind approval) | CRITICAL | `git log --grep='\[BUG-001\]'` | [BUG-001-permission-summary-empty.md](BUG-001-permission-summary-empty.md) |
| BUG-002 | tool row ไม่แสดง diff และเมิน rawOutput | CRITICAL | `git log --grep='\[BUG-002\]'` | [BUG-002-diff-tool-output-dropped.md](BUG-002-diff-tool-output-dropped.md) |
| BUG-003 | watchdog ตัดเทิร์นที่ agent ยังทำงานอยู่ | CRITICAL | `git log --grep='\[BUG-003\]'` | [BUG-003-watchdog-settles-live-turns.md](BUG-003-watchdog-settles-live-turns.md) |
| BUG-004 | แถว tool ค้าง pending/in_progress หลังจบเทิร์น | major | `git log --grep='\[BUG-004\]'` | [BUG-004-open-tool-rows-never-settled.md](BUG-004-open-tool-rows-never-settled.md) |
| BUG-005 | แถว tool หายเมื่อเทิร์นจบโดยไม่มีข้อความ | major | `git log --grep='\[BUG-005\]'` | [BUG-005-tool-rows-lost-on-empty-settle.md](BUG-005-tool-rows-lost-on-empty-settle.md) |
| BUG-006 | mock agent ส่ง wire shape ไม่เหมือน CLI จริง | major (test-infra) | `git log --grep='\[BUG-006\]'` | [BUG-006-mock-real-wire-shape.md](BUG-006-mock-real-wire-shape.md) |
| BUG-007 | settle ปิดการ์ดขออนุญาตฝั่ง UI แต่ agent ยังค้างรอ | major | `git log --grep='\[BUG-007\]'` | [BUG-007-dead-interaction-cleanup.md](BUG-007-dead-interaction-cleanup.md) |
| BUG-008 | "Approve for this session" ไม่เคย sticky กับ agent จริง | minor | `git log --grep='\[BUG-008\]'` | [BUG-008-sticky-approve-id.md](BUG-008-sticky-approve-id.md) |
| BUG-009 | ทุก token chunk กลายเป็น SSE frame ของตัวเอง (ไม่มี batching) | major | `git log --grep='\[BUG-009\]'` | [BUG-009-delta-batching.md](BUG-009-delta-batching.md) |
| BUG-010 | back-pressure flag เป็น dead code ไม่มีใครอ่าน | major | `git log --grep='\[BUG-010\]'` | [BUG-010-backpressure-dead-flag.md](BUG-010-backpressure-dead-flag.md) |
| BUG-011 | replay cursor ถูก evict เงียบ ๆ — client พลาด turn_done ถาวร | major | `git log --grep='\[BUG-011\]'` | [BUG-011-resync-on-ring-eviction.md](BUG-011-resync-on-ring-eviction.md) |
| BUG-012 | history ที่ agent ใช้ต่อไม่ได้ทำ chat บริคถาวร | CRITICAL | `git log --grep='\[BUG-012\]'` | [BUG-012-history-incompatible-rotate-retry.md](BUG-012-history-incompatible-rotate-retry.md) |
| BUG-013 | ไม่มี endpoint ดูเทิร์นที่กำลังรัน — reload กลางเทิร์นเห็น live ว่าง | major | `git log --grep='\[BUG-013\]'` | [BUG-013-open-turn-snapshot-endpoint.md](BUG-013-open-turn-snapshot-endpoint.md) |
| BUG-014 | agent session ใหม่หลัง rotation เริ่มจากศูนย์ ไม่มี recovery preamble | major | `git log --grep='\[BUG-014\]'` | [BUG-014-recovery-preamble.md](BUG-014-recovery-preamble.md) |
| BUG-015 | scoped SSE events ไม่ bind turnId — หน้าต่างที่พลาด turn_started ว่างทั้งเทิร์น | CRITICAL | `git log --grep='\[BUG-015\]'` | [BUG-015-scoped-events-bind-turnid.md](BUG-015-scoped-events-bind-turnid.md) |
| BUG-016 | turn_done ของแชทพื้นหลัง orphan live DOM ของแชทที่กำลังดู | major | `git log --grep='\[BUG-016\]'` | [BUG-016-background-settle-orphans-live-dom.md](BUG-016-background-settle-orphans-live-dom.md) |
| BUG-017 | error/cancel กลางเทิร์นไม่ทิ้งร่องรองใน live path — ไม่มี marker หยุดโดยผู้ใช้ | major | `git log --grep='\[BUG-017\]'` | [BUG-017-error-cancel-no-live-trace.md](BUG-017-error-cancel-no-live-trace.md) |
| BUG-018 | live paint แทรก tool/plan ใต้ข้อความสตรีม — คำตอบแหว่งกลาง | major | `git log --grep='\[BUG-018\]'` | [BUG-018-live-paint-order.md](BUG-018-live-paint-order.md) |
| BUG-019 | ทุก delta ทำ markdown re-parse เต็มก้อน + เขียน DOM ใหม่ทั้ง bubble | major | `git log --grep='\[BUG-019\]'` | [BUG-019-per-delta-markdown-reparse.md](BUG-019-per-delta-markdown-reparse.md) |
| BUG-020 | selectChat/reload ไม่ hydrate เทิร์นที่กำลังรัน — ไม่มี spinner/Stop/partial text | major | `git log --grep='\[BUG-020\]'` | [BUG-020-no-live-turn-hydration.md](BUG-020-no-live-turn-hydration.md) |
| BUG-021 | ปุ่ม Stop ไม่มีสถานะ "กำลังหยุด…" — double-Esc ยิง cancel ซ้ำ | minor | `git log --grep='\[BUG-021\]'` | [BUG-021-no-cancelling-composer-state.md](BUG-021-no-cancelling-composer-state.md) |
| BUG-022 | status line binary ไม่บอกรออนุญาต/plan step/tool ที่รัน และไม่มี hint Esc | minor | `git log --grep='\[BUG-022\]'` | [BUG-022-status-line-no-verb-chain.md](BUG-022-status-line-no-verb-chain.md) |
| BUG-023 | agent_error ถูก subscribe แต่ไม่มี handler — หน้าต่างอื่นไม่รู้ว่า agent ตาย | minor | `git log --grep='\[BUG-023\]'` | [BUG-023-agent-error-ignored.md](BUG-023-agent-error-ignored.md) |
| BUG-024 | boot ที่ล้มเหลวถูกกลืนเงียบ — UI ครึ่ง ๆ กลาง ๆ โดยไม่มี error บอก | major | `git log --grep='\[BUG-024\]'` | [BUG-024-boot-failure-swallowed.md](BUG-024-boot-failure-swallowed.md) |
| BUG-025 | ส่งคำตอบการ์ดขออนุญาตไม่สำเร็จแล้วการ์ดตาย (ปุ่ม disabled ถาวร) | major | `git log --grep='\[BUG-025\]'` | [BUG-025-dead-card-on-resolve-fail.md](BUG-025-dead-card-on-resolve-fail.md) |
| BUG-026 | AskUserQuestion/ExitPlanMode เรนเดอร์เป็นการ์ดเปล่า ไม่เห็นคำถาม/แผน | major | `git log --grep='\[BUG-026\]'` | [BUG-026-ask-plan-subtype-cards.md](BUG-026-ask-plan-subtype-cards.md) |
| BUG-027 | แถว tool พิมพ์สถานะ protocol ดิบ ๆ ("in_progress") ใน UI ภาษาไทย | minor | `git log --grep='\[BUG-027\]'` | [BUG-027-tool-status-thai-labels.md](BUG-027-tool-status-thai-labels.md) |
| BUG-028 | ปุ่มตัวเลือกทุกปุ่มที่ไม่ใช่ reject ถูกแต่งเป็น primary | minor | `git log --grep='\[BUG-028\]'` | [BUG-028-one-primary-option.md](BUG-028-one-primary-option.md) |
| BUG-029 | การ์ดขออนุญาตไม่ยึดกับแถว tool ที่มาขอ ตกท้ายเทิร์นเสมอ | minor | `git log --grep='\[BUG-029\]'` | [BUG-029-card-anchored-to-tool-row.md](BUG-029-card-anchored-to-tool-row.md) |
| BUG-030 | การ์ดขออนุญาตไม่มี keyboard shortcut (เลขเลือก / Esc ปฏิเสธ) | minor | `git log --grep='\[BUG-030\]'` | [BUG-030-ix-card-keyboard-shortcuts.md](BUG-030-ix-card-keyboard-shortcuts.md) |
| BUG-031 | ลำดับข้อความที่ persist ขัดกับลำดับ live — แผนกระโดดขึ้นบนหลัง turn_done | minor | `git log --grep='\[BUG-031\]'` | [BUG-031-persisted-order-matches-live.md](BUG-031-persisted-order-matches-live.md) |
| BUG-032 | การ์ดที่ตอบแล้วไม่บันทึกว่าเลือกอะไร (เทา ๆ ปุ่มตายหมด) | minor | `git log --grep='\[BUG-032\]'` | [BUG-032-resolved-card-chosen-record.md](BUG-032-resolved-card-chosen-record.md) |
| BUG-033 | แถว tool ที่กำลังรันพับมิดอยู่ตลอด ไม่เห็น output จนกว่าจะคลิก | minor | `git log --grep='\[BUG-033\]'` | [BUG-033-auto-expand-running-tool-rows.md](BUG-033-auto-expand-running-tool-rows.md) |
| BUG-034 | code block ไม่มีแถบ chrome / ป้ายภาษา / ปุ่ม copy ประจำบล็อก | major | `git log --grep='\[BUG-034\]'` | [BUG-034-code-block-chrome.md](BUG-034-code-block-chrome.md) |
| BUG-035 | ปุ่ม copy สตริงอังกฤษ + listener หลุดกลางสตรีม + ไม่มี clipboard fallback | minor | `git log --grep='\[BUG-035\]'` | [BUG-035-code-copy-delegation.md](BUG-035-code-copy-delegation.md) |
| BUG-036 | ตารางกว้างล้นคอลัมน์ transcript ไม่มี horizontal scroll | major | `git log --grep='\[BUG-036\]'` | [BUG-036-table-overflow-wrap.md](BUG-036-table-overflow-wrap.md) |
| BUG-037 | heading/list/hr/image ของ GFM ตกไปใช้ UA default — margin เทอะทะ รูปล้น | minor | `git log --grep='\[BUG-037\]'` | [BUG-037-gfm-typography.md](BUG-037-gfm-typography.md) |
| BUG-038 | balanceFences แตะ final/history render + regex fence อ่อนกว่า CommonMark | minor | `git log --grep='\[BUG-038\]'` | [BUG-038-live-only-fence-balance.md](BUG-038-live-only-fence-balance.md) |
| BUG-039 | link policy ฆ่า relative/anchor link และติด target=_blank ให้ mailto | minor | `git log --grep='\[BUG-039\]'` | [BUG-039-link-policy.md](BUG-039-link-policy.md) |
| BUG-040 | CSP img-src บล็อกรูป https ที่ sanitizer อนุญาต — รูปแตก | minor | `git log --grep='\[BUG-040\]'` | [BUG-040-csp-img-src-https.md](BUG-040-csp-img-src-https.md) |
| BUG-041 | marked.parse throw กลาง SSE handler ทำ paint abort ไม่มี fallback | minor | `git log --grep='\[BUG-041\]'` | [BUG-041-parse-error-containment.md](BUG-041-parse-error-containment.md) |
| BUG-042 | fence ติดข้อความ/comment ค้างกลางสตรีม เรนเดอร์กะพริบเป็น inline code | minor | `git log --grep='\[BUG-042\]'` | [BUG-042-streaming-stabilizers.md](BUG-042-streaming-stabilizers.md) |
| BUG-043 | restore draft หลัง await fetch — แฟลชข้อความแชทเก่า + draft รั่วข้ามแชท | major | `git log --grep='\[BUG-043\]'` | [BUG-043-draft-restored-after-fetch.md](BUG-043-draft-restored-after-fetch.md) |
| BUG-044 | turn_done reload คืน scrollTop เก่าทับ layout ใหม่ — หน้าจอกระโดดมั่วหลังเทิร์นจบ | major | `git log --grep='\[BUG-044\]'` | [BUG-044-settle-stale-scrolltop.md](BUG-044-settle-stale-scrolltop.md) |
| BUG-045 | ไม่มี wheel-up unpin — เลื่อนขึ้นน้อยกว่า 120px แล้วถูกสตรีมดึงกลับลงล่าง | minor | `git log --grep='\[BUG-045\]'` | [BUG-045-wheel-up-unpin.md](BUG-045-wheel-up-unpin.md) |
| BUG-046 | scroll ตาม message_delta ทุก chunk ไม่มี rAF coalescing — กระตุกกลางสตรีม | minor | `git log --grep='\[BUG-046\]'` | [BUG-046-raf-coalesced-scroll.md](BUG-046-raf-coalesced-scroll.md) |
| BUG-047 | ไม่มี jump-to-latest pill — unpin แล้วไม่รู้ว่ามีของใหม่ กลับท้ายสตรีมลำบาก | major | `git log --grep='\[BUG-047\]'` | [BUG-047-jump-to-latest-pill.md](BUG-047-jump-to-latest-pill.md) |
| BUG-048 | buffer ข้อความ rename ไม่ผูกกับ group id — ของค้างจาก group A เติมกล่อง group B | minor | `git log --grep='\[BUG-048\]'` | [BUG-048-rename-buffer-keyed-by-group.md](BUG-048-rename-buffer-keyed-by-group.md) |
| BUG-049 | sidebar re-render ทั้งต้นทุก tool_call ของแชทที่กำลังดู — กล่อง rename/new-group หลุดโฟกัส | minor | `git log --grep='\[BUG-049\]'` | [BUG-049-sidebar-rerender-per-tool-call.md](BUG-049-sidebar-rerender-per-tool-call.md) |
| BUG-050 | draft ที่พิมพ์ค้างอยู่ใน Map ล้วน ๆ — reload แล้วหาย | minor | `git log --grep='\[BUG-050\]'` | [BUG-050-drafts-survive-reload.md](BUG-050-drafts-survive-reload.md) |
| BUG-051 | ไม่มีคิว prompt ต่อแชท — Enter กลางเทิร์นถูกกลืน 409 กลายเป็น error | major | `git log --grep='\[BUG-051\]'` | [BUG-051-per-chat-prompt-queue.md](BUG-051-per-chat-prompt-queue.md) |
| BUG-052 | renderTranscript mount+parse markdown ทั้งประวัติทุกครั้ง — แชทยาวหน่วง | major | `git log --grep='\[BUG-052\]'` | [BUG-052-windowed-transcript.md](BUG-052-windowed-transcript.md) |
| BUG-053 | ไม่มี slash commands — /plan /ask ถูกส่งเป็น prompt ดิบ | minor | `git log --grep='\[BUG-053\]'` | [BUG-053-slash-commands.md](BUG-053-slash-commands.md) |
| BUG-054 | เมนูแชทไม่มี "คัดลอกทั้งหมด (Markdown)" — เอา transcript ออกไม่ได้ | minor | `git log --grep='\[BUG-054\]'` | [BUG-054-copy-all-markdown.md](BUG-054-copy-all-markdown.md) |
| BUG-055 | เครื่องใหม่บันทึก theme pref เป็น 'moonlight' — เมนูติ๊กผิดและไม่ตามธีมระบบ | major | `git log --grep='\[BUG-055\]'` | [BUG-055-theme-pref-defaults-auto.md](BUG-055-theme-pref-defaults-auto.md) |
| BUG-056 | guard prefers-reduced-motion ชี้ selector ตาย (.chat-row .dot) — จุดรันใน sidebar ยังกะพริบ | minor | `git log --grep='\[BUG-056\]'` | [BUG-056-reduced-motion-dead-selector.md](BUG-056-reduced-motion-dead-selector.md) |
| BUG-057 | moonlight/daylight ไม่ประกาศ color-scheme — scrollbar/UA chrome สว่างบนธีมมืด | minor | `git log --grep='\[BUG-057\]'` | [BUG-057-color-scheme-per-theme.md](BUG-057-color-scheme-per-theme.md) |
| BUG-058 | ไม่มี ::selection นอกธีม Claude Light — selection เป็นสีฟ้าหม่น default | minor | `git log --grep='\[BUG-058\]'` | [BUG-058-base-selection-styling.md](BUG-058-base-selection-styling.md) |
| BUG-059 | โฟกัสคีย์บอร์ดมองไม่เห็นเกือบทุก control — ไม่มี --focus-ring, ปุ่ม hover-reveal ไม่ปรากฏตอน focus | minor | `git log --grep='\[BUG-059\]'` | [BUG-059-keyboard-focus-ring.md](BUG-059-keyboard-focus-ring.md) |
| BUG-060 | contrast audit ขาดคู่ --ink/--user-bubble และ --ink-dim/--muted บน --code-bg — palette พังได้เงียบ ๆ | minor | `git log --grep='\[BUG-060\]'` | [BUG-060-contrast-pairs-coverage.md](BUG-060-contrast-pairs-coverage.md) |
| BUG-061 | ไม่มี static guard: brace/comment balance, theme scoping, boot order, cache-bust, selector ตาย | minor | `git log --grep='\[BUG-061\]'` | [BUG-061-static-css-guards.md](BUG-061-static-css-guards.md) |
| BUG-062 | สลับธีมตัดภาพทันที (flash-cut) — ไม่มี crossfade ให้ shell surfaces | minor | `git log --grep='\[BUG-062\]'` | [BUG-062-theme-switch-crossfade.md](BUG-062-theme-switch-crossfade.md) |
| BUG-063 | ไม่มีธีม Claude Dark — auto-dark ตกไป moonlight โทนเย็นทั้งที่ grok จับคู่ warm dark | minor | `git log --grep='\[BUG-063\]'` | [BUG-063-claude-dark-theme.md](BUG-063-claude-dark-theme.md) |
| BUG-064 | sidebar ตายตัว 264px — ไม่ยืดตามหน้าต่าง จอแคบกินที่เกิน จอกว้างไม่ใช้ที่ | minor | `git log --grep='\[BUG-064\]'` | [BUG-064-fluid-sidebar-clamp.md](BUG-064-fluid-sidebar-clamp.md) |
| BUG-065 | ไม่มี type-scale token — font-size hardcode 51 จุด 12 ขนาด ปรับทีเดียวไม่ได้ | minor | `git log --grep='\[BUG-065\]'` | [BUG-065-type-scale-tokens.md](BUG-065-type-scale-tokens.md) |
| BUG-066 | ไม่มี version badge — app.js ตายตอน boot แล้วเห็น shell นิ่งเงียบไม่มีตัวบอก host/version | major | `git log --grep='\[BUG-066\]'` | [BUG-066-version-badge-boot-surface.md](BUG-066-version-badge-boot-surface.md) |
| BUG-067 | ไม่มี static test ปัก invariant ของ mac shell (XDG stateDir, verified pid, HTTP-first shutdown) | minor | `git log --grep='\[BUG-067\]'` | [BUG-067-mac-app-static-test.md](BUG-067-mac-app-static-test.md) |
| BUG-068 | stop fallback ของ mac-launch.sh kill pid จากไฟล์โดยไม่ verify — เสี่ยงโดน process อื่นเมื่อ pid ถูก recycle | minor | `git log --grep='\[BUG-068\]'` | [BUG-068-mac-launch-verified-stop.md](BUG-068-mac-launch-verified-stop.md) |
| BUG-069 | ไม่มี deploy pipeline — ไม่มี health-verified start / post-deploy smoke / status | major | `git log --grep='\[BUG-069\]'` | [BUG-069-deploy-pipeline.md](BUG-069-deploy-pipeline.md) |
| BUG-070 | ไม่มี notranslate guard — Chrome translate banner แทรกหน้าต่างแอปตอนเปิดผ่าน default browser | minor | `git log --grep='\[BUG-070\]'` | [BUG-070-notranslate-guard.md](BUG-070-notranslate-guard.md) |
| BUG-071 | ไม่มี debug page — ดู counters ของ host หรือ smoke endpoints จากเบราว์เซอร์ไม่ได้ | minor | `git log --grep='\[BUG-071\]'` | [BUG-071-debug-page.md](BUG-071-debug-page.md) |
| BUG-072 | status verb ระหว่างเทิร์นไม่ตาม grok — ไม่แยก subtype การ์ด/kind ของ tool, ไม่นับ agent, fallback กล่าวหา thinking | minor | `git log --grep='\[BUG-072\]'` | [BUG-072-status-verb-grok-parity.md](BUG-072-status-verb-grok-parity.md) |
| BUG-073 | คำตอบยาวแล้ว transcript ไม่มี scrollbar และ composer หายใต้จอ (min-height:auto hazard) | major | `git log --grep='\[BUG-073\]'` | [BUG-073-transcript-scroll-composer.md](BUG-073-transcript-scroll-composer.md) |
| BUG-074 | เปลี่ยน model/effort ต่อแชทไม่ได้ — ไม่มี config endpoint, effort เป็น global ตายตัว | major | `git log --grep='\[BUG-074\]'` | [BUG-074-per-chat-config-endpoint.md](BUG-074-per-chat-config-endpoint.md) |
| BUG-075 | ไม่มี UI เปลี่ยน model/effort — config_option_update ถูกทิ้ง, ไม่มี picker บน head bar | minor | `git log --grep='\[BUG-075\]'` | [BUG-075-config-picker-pills.md](BUG-075-config-picker-pills.md) |
| BUG-076 | แถว subagent หน้าเหมือน tool ธรรมดา — ไม่มี pin/glyph/subtitle, background agent อ่านว่าเสร็จแล้วทั้งที่ยังรัน | minor | `git log --grep='\[BUG-076\]'` | [BUG-076-subagent-rows.md](BUG-076-subagent-rows.md) |
| BUG-077 | ไม่มี chip บอกจำนวน subagent ที่กำลังรันในเทิร์นบน head bar | minor | `git log --grep='\[BUG-077\]'` | [BUG-077-agents-chip.md](BUG-077-agents-chip.md) |
| BUG-078 | version badge ค้างที่ 0.4.0 ตลอด — package.json ไม่เคย bump ทั้งที่ ?v= token เดินไปไกล | minor | `git log --grep='\[BUG-078\]'` | [BUG-078-version-badge-stale.md](BUG-078-version-badge-stale.md) |
| BUG-079 | pill model/effort กดไม่ได้บนแชท cold — options ผูกกับ live session ทั้งที่ catalog เป็น agent-wide | major | `git log --grep='\[BUG-079\]'` | [BUG-079-config-pills-cold-chat.md](BUG-079-config-pills-cold-chat.md) |
