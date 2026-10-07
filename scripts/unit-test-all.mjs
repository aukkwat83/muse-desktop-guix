#!/usr/bin/env node
// Runs every suite in sequence. `npm test`.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['session-mode', 'unit-test-session-mode.mjs'],
  ['session-store', 'unit-test-session-store.mjs'],
  ['groups', 'unit-test-groups.mjs'],
  ['ap-title', 'unit-test-ap-title.mjs'],
  ['pricing', 'unit-test-pricing.mjs'],
  ['notify', 'unit-test-notify.mjs'],
  ['goal-tasks', 'unit-test-goal-tasks.mjs'],
  ['subagents', 'unit-test-subagents.mjs'],
  ['child-activity', 'unit-test-child-activity.mjs'],
  ['text', 'unit-test-text.mjs'],
  ['usage-cache', 'unit-test-usage-cache.mjs'],
  ['theme-contrast', 'unit-test-theme-contrast.mjs'],
  ['theme-boot', 'unit-test-theme-boot.mjs'],
  ['css-guards', 'unit-test-css-guards.mjs'],
  ['mac-app', 'test-mac-app.mjs'],
  ['guix-shell', 'unit-test-guix-shell.mjs'],
  ['guix-platform', 'unit-test-guix-platform.mjs'],
  ['debug-info', 'unit-test-debug-info.mjs'],
  ['sse-wire', 'unit-test-sse-wire.mjs'],
  ['permission-host', 'unit-test-permission-host.mjs'],
  ['config-options', 'unit-test-config-options.mjs'],
  ['msp-client', 'unit-test-msp-client.mjs'],
  ['turn-core', 'unit-test-turn-core.mjs'],
  ['turn-view', 'unit-test-turn-view.mjs'],
  ['scroll-pin', 'unit-test-scroll-pin.mjs'],
  ['composer-draft', 'unit-test-composer-draft.mjs'],
  ['prompt-queue', 'unit-test-prompt-queue.mjs'],
  ['history-window', 'unit-test-history-window.mjs'],
  ['slash-commands', 'unit-test-slash-commands.mjs'],
  ['transcript-markdown', 'unit-test-transcript-markdown.mjs'],
  ['markdown', 'unit-test-markdown.mjs'],
  ['mcp', 'unit-test-mcp.mjs'],
  ['ctx-meter', 'unit-test-ctx-meter.mjs'],
  ['sidebar-resize', 'unit-test-sidebar-resize.mjs'],
  ['rightbar-resize', 'unit-test-rightbar-resize.mjs'],
  ['viz-contract', 'unit-test-viz-contract.mjs'],
  ['search', 'unit-test-search.mjs'],
  ['attach', 'unit-test-attach.mjs'],
  ['e2e (mock agent)', 'e2e-mock-agent.mjs'],
];

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

let failed = 0;
for (const [name, file] of SUITES) {
  console.log(`\n▸ ${name}`);
  const code = await run(file);
  if (code !== 0) failed++;
}

console.log(`\n${failed ? `✗ ${failed} suite(s) failed` : `✓ all ${SUITES.length} suites passed`}`);
process.exit(failed ? 1 : 0);
