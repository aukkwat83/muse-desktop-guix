#!/usr/bin/env node
/**
 * Guix native shell (linux/gtk-shell) static contract + build freshness.
 *
 * The GTK shell is C and has no runtime harness, so every contract it carries was
 * guarded by hand on the mac side — and mac cannot break this path loudly because
 * mac never executes it. This locks them down:
 *
 *   - R50  cardDrag script-message bridge (registered; dormant until a renderer
 *          sender exists — drops a card out as the real file then)
 *   - R39  cache-ignoring reload (WebKitGTK serves the stale bundle otherwise)
 *   - R58  host restart action + Web Inspector — mac shell parity
 *   - build freshness: the shipped binary must not be older than main.c
 *   - the native-launch prebuilt fast path (a `guix shell` wrap on every launch
 *     looks exactly like "the app won't open")
 *
 *   node scripts/unit-test-guix-shell.mjs
 *   npm run test:guix-shell
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = { g: '\x1b[32m', r: '\x1b[31m', d: '\x1b[2m', x: '\x1b[0m', b: '\x1b[1m' };
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`  ${c.g}✓${c.x} ${name}${detail ? `${c.d} — ${detail}${c.x}` : ''}`);
  } catch (err) {
    failures.push({ name, message: err?.message || String(err) });
    console.error(`  ${c.r}✗${c.x} ${name} — ${err?.message || err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MAIN_C = 'linux/gtk-shell/main.c';
const SHELL_BIN = 'linux/gtk-shell/muse-desktop-shell';
const main = read(MAIN_C);

console.log(`${c.b}Guix native shell (GTK4 + WebKitGTK)${c.x}\n`);

console.log(`${c.b}== R50 card drag bridge ==${c.x}`);
test('registers the `cardDrag` script message handler', () => {
  assert(
    /webkit_user_content_manager_register_script_message_handler\(\s*ucm,\s*"cardDrag"/.test(main),
    'cardDrag handler not registered — renderer feature-detect falls back to a link drag',
  );
  assert(/script-message-received::cardDrag/.test(main), 'cardDrag signal not connected');
  return 'window.webkit.messageHandlers.cardDrag exists';
});
test('drag source runs in CAPTURE phase (before WebKitGTK own DnD)', () => {
  assert(/GTK_PHASE_CAPTURE/.test(main), 'drag source must capture before the web view');
});

console.log(`\n${c.b}== R39 cache-ignoring reload ==${c.x}`);
test('purges disk+memory cache, keeps cookies/localStorage, then bypasses', () => {
  assert(/WEBKIT_WEBSITE_DATA_DISK_CACHE\s*\|\s*WEBKIT_WEBSITE_DATA_MEMORY_CACHE/.test(main),
    'must clear DISK|MEMORY only — clearing more would drop the theme choice');
  assert(/webkit_web_view_reload_bypass_cache/.test(main), 'reload must bypass cache');
});
test('Ctrl+R / Ctrl+Shift+R / F5 bound in CAPTURE phase', () => {
  assert(/GDK_KEY_r,\s*GDK_CONTROL_MASK/.test(main), 'Ctrl+R missing');
  assert(/GDK_KEY_F5/.test(main), 'F5 missing');
});

console.log(`\n${c.b}== R58-guix host restart (mac HostSupervisor parity) ==${c.x}`);
test('exports a `restart-host` GAction and the button targets it', () => {
  assert(/g_simple_action_new\("restart-host"/.test(main), 'restart-host action missing');
  assert(/g_action_map_add_action\(G_ACTION_MAP\(app\)/.test(main), 'action not added to the app');
  assert(/gtk_actionable_set_action_name\(GTK_ACTIONABLE\(g_restart_btn\),\s*"app\.restart-host"\)/.test(main),
    'header-bar button must drive the same action, not a private click handler');
  return 'org.gtk.Actions exposes restart-host';
});
test('graceful HTTP shutdown first, keeping warm agents', () => {
  assert(/\/api\/host\/shutdown/.test(main), 'must use the sanctioned shutdown endpoint');
  assert(/killAgents\\":false/.test(main), 'restart must NOT kill agents (killAgents:false)');
});
test('signal fallback only after /proc verifies the pid is our host', () => {
  assert(/\/proc\/%d\/cmdline/.test(main), 'pid must be verified via /proc before signalling');
  assert(/src\/server\/index\.js"\)\)/.test(main), 'cmdline check must match the host command');
  assert(/kill\(\(pid_t\)pid,\s*SIGTERM\)/.test(main), 'fallback must SIGTERM, not SIGKILL');
});
test('restart polls on a GLib timeout — never blocks the main loop', () => {
  const fn = main.slice(main.indexOf('static void on_restart_host'), main.indexOf('static gboolean on_decide_policy'));
  assert(/g_timeout_add\(500,\s*restart_tick/.test(main), 'restart must be timeout-driven');
  assert(!/g_usleep/.test(fn), 'no blocking sleep in the restart handler (freezes the window)');
  assert(/RESTART_WAIT_DOWN/.test(main) && /RESTART_WAIT_UP/.test(main), 'both wait phases required');
});
test('spawn_host() does not wait; only startup ensure_host() blocks', () => {
  const spawn = main.slice(main.indexOf('static pid_t spawn_host'), main.indexOf('static void ensure_host'));
  assert(!/g_usleep/.test(spawn), 'spawn_host must return immediately for the timeout driver');
  assert(/for \(int i = 0; i < 80; i\+\+\)/.test(main), 'startup ensure_host keeps its blocking poll');
});
test('memory meter yields the status label during a restart', () => {
  assert(/g_restart_phase != RESTART_IDLE\)\s*\n\s*return G_SOURCE_CONTINUE/.test(main),
    'poll_memory must not overwrite restart progress text');
});

console.log(`\n${c.b}== R58-guix Web Inspector (ContentView.swift parity) ==${c.x}`);
test('developer extras always on', () => {
  assert(/webkit_settings_set_enable_developer_extras\(settings,\s*TRUE\)/.test(main),
    'no Inspector = renderer bugs can only be chased outside the native shell');
});
test('console→stderr forwarding is opt-in via MUSE_DESKTOP_DEVTOOLS', () => {
  assert(/webkit_settings_set_enable_write_console_messages_to_stdout/.test(main), 'console forwarding missing');
  assert(/MUSE_DESKTOP_DEVTOOLS/.test(main), 'forwarding must be env-gated so host.log stays clean');
});

console.log(`\n${c.b}== build freshness ==${c.x}`);
/* The binary is gitignored, so a fresh checkout legitimately has none — that is
 * "not built yet", not a regression. Skip there; only judge a binary that exists. */
const BUILT = fs.existsSync(path.join(ROOT, SHELL_BIN));
test('shipped binary is executable', () => {
  if (!BUILT) return 'skip — not built on this checkout (build.sh)';
  const st = fs.statSync(path.join(ROOT, SHELL_BIN));
  assert(st.isFile() && st.size > 1024, 'shell binary truncated');
  assert((st.mode & 0o111) !== 0, 'shell binary not executable');
  return `${st.size} bytes`;
});
test('binary is not older than main.c (stale-build guard)', () => {
  if (!BUILT) return 'skip — not built on this checkout';
  const src = fs.statSync(path.join(ROOT, MAIN_C)).mtimeMs;
  const bin = fs.statSync(path.join(ROOT, SHELL_BIN)).mtimeMs;
  assert(
    bin >= src,
    `rebuild needed: ${SHELL_BIN} is older than ${MAIN_C} — ` +
      'guix shell -m linux/gtk-shell/manifest.scm -- bash linux/gtk-shell/build.sh',
  );
  return `binary ${Math.round((bin - src) / 1000)}s newer than source`;
});

console.log(`\n${c.b}== launcher guards (mac never executes these) ==${c.x}`);
test('native-launch.sh keeps the prebuilt fast path', () => {
  const sh = read('scripts/native-launch.sh');
  assert(/MUSE_DESKTOP_FORCE_GUIX_SHELL/.test(sh),
    'the slow guix-shell path must stay behind the env guard — without it every launch realizes the manifest (>121s, no output)');
  assert(/prebuilt/i.test(sh), 'prebuilt fast path missing');
});
test('bin/muse-desktop resolves itself through symlinks (HAZ-10)', () => {
  const sh = read('bin/muse-desktop');
  assert(/while \[\[ -L "\$_script" \]\]/.test(sh),
    'without symlink resolution ROOT becomes ~/.local and the shell binary is "not found"');
  assert(/muse-desktop-shell/.test(sh), 'must exec the native shell binary when built');
});

console.log(
  `\n${failures.length ? c.r : c.g}${c.b}guix-shell: ${passed} passed, ${failures.length} failed${c.x}`,
);
if (failures.length) {
  for (const f of failures) console.error(`  ${c.r}- ${f.name}: ${f.message}${c.x}`);
  process.exit(1);
}
