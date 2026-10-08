# Release index (chain)

อ่านจาก **บนลงล่าง** = ใหม่ → เก่า
ทุก note ต้องมี `Previous:` ชี้แถวก่อนหน้า

| Tag | Date | One-liner | Previous | Note |
|-----|------|-----------|----------|------|
| **v1.1.32** | 2026-10-08 | Popup-only goal/task/subagent overview (live union drill-down, native transcripts, persisted goals) + shared 44-icon SVG family, Inter/Sarabun type rebalance, sanitized chrome, safe diagram export, narrow header wrap. `npm test` 45/45, e2e 78/78, contrast AA | v1.1.29 | [v1.1.32-activity-overview-and-icons.md](./v1.1.32-activity-overview-and-icons.md) |
| **v1.1.23-result-stack** | 2026-10-07 | ChatGPT-like result stack: quiet divider lines between turn blocks (activity → answer → cards), one CSS rule covering live + history. Tag cut after Guix QC | v1.1.22-child-activity | [v1.1.23-result-stack.md](./v1.1.23-result-stack.md) |
| **v1.1.22-child-activity** | 2026-10-07 | Inline child activity in transcript agent rows (nested delegate view): server `agentLink` per row + new child-activity.js block fed by the drill endpoint, live tail while running. Reference repo has no UI source — approximation, disclosed in note. Tag cut after Guix QC | v1.1.21-guix-sync | [v1.1.22-child-activity.md](./v1.1.22-child-activity.md) |
| **v1.1.21-guix-sync** | 2026-10-07 | Forward-port mac v1.1.1–v1.1.21 (queue, right rail, subagent drill-down, reminder live windows, BUG-081–084) onto the Guix stack; 8 overlap files 3-way merged, `?v=`=1.1.21, `test:guix` version pin relaxed to ≥1.1.0. Tag cut after Guix QC | v1.1.0-guix-parity | [v1.1.21-guix-sync.md](./v1.1.21-guix-sync.md) |
| **v1.1.0-guix-parity** | 2026-09-21 | Guix port of mac v1.0.0 in a new repo: native GTK4/WebKitGTK shell (R39 reload, dormant R50 cardDrag bridge, R58-guix restart-host + Inspector), Guix manifest, `bin/muse-desktop`, native/linux launchers, desktop install, systemd unit, zenity attach picker, darwin-only PAC fallback, Ctrl+N; `test:guix` 18/18 + `test:guix-shell` 16/16. Modelled on grok-desktop `deploy/v0.8.9-guix` @ `35dac5c` (`v0.9.4-guix-shell-host`). Nothing mac removed. Tag cut after first Guix QC | v1.0.0 (mac) | [v1.1.0-guix-parity.md](./v1.1.0-guix-parity.md) |
