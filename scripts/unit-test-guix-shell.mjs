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
 *   - zombie-window recovery (1.1.34): on_activate verifies the existing
 *     window against the X server and rebuilds when the surface died
 *     externally (the 2026-10-08 "won't open" — e2e-shell-zombie.mjs)
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

console.log(`\n${c.b}== question banners + click routing (1.1.33) ==${c.x}`);
test('registers the `museNotify` script message handler', () => {
  assert(
    /webkit_user_content_manager_register_script_message_handler\(\s*ucm,\s*"museNotify"/.test(main),
    'museNotify handler not registered — the renderer can never banner natively',
  );
  assert(/script-message-received::museNotify/.test(main), 'museNotify signal not connected');
  return 'window.webkit.messageHandlers.museNotify exists';
});
test('exports a typed `open-question` (ss) GAction', () => {
  assert(/g_simple_action_new\("open-question",\s*G_VARIANT_TYPE\("\(ss\)"\)\)/.test(main),
    'open-question must carry (chatId, ixId) as a typed (ss) parameter');
  assert(/"app\.open-question"/.test(main), 'banner default action must target app.open-question');
  return 'banner taps route to the exact chat + question';
});
test('same notification id replaces; withdraw mirrors show', () => {
  assert(/g_application_send_notification\(\s*g_app,\s*notif_id/.test(main),
    'show must send through g_application_send_notification for replace-by-id dedupe');
  assert(/g_application_withdraw_notification\(\s*g_app,\s*withdraw_id/.test(main),
    'withdraw must target the same derived id or banners linger');
  assert(!/notify-send|system\(.*notif|popen.*notif/i.test(main),
    'no shell-spawned notifiers — ids must never cross a command line',
  );
});
test('bridge is same-origin guarded and routing evals the typed ids', () => {
  assert(/muse_notify_same_origin/.test(main), 'missing same-origin guard on the bridge');
  assert(/__museQuestionRoute/.test(main), 'routing must call window.__museQuestionRoute(chatId, ixId)');
  assert(!/g_strescape\(chat_id/.test(main) && !/g_strescape\(ix_id/.test(main),
    'g_strescape octal escapes are not valid JS — ids must use JSON escaping');
  assert(/js_string_escape\(g_route_chat\)/.test(main) && /js_string_escape\(g_route_ix\)/.test(main),
    'ids must be JSON-escaped into the routing JS string (UTF-8 safe)');
});
test('actions register once at startup; activate reuses the window', () => {
  assert(/g_signal_connect\(app, "startup", G_CALLBACK\(on_startup\)/.test(main),
    'startup handler not connected — actions would miss cold-start taps');
  assert(/g_simple_action_new\("open-question"[\s\S]{0,400}on_startup|on_startup[\s\S]{0,2000}g_simple_action_new\("open-question"/.test(main),
    'open-question must be registered in on_startup, not per-window');
  assert(/g_simple_action_new\("notify-question",\s*G_VARIANT_TYPE\("\(ss\)"\)\)/.test(main),
    'host-origin notify-question (op, key) action missing');
  assert(/gtk_application_get_active_window\(app\)/.test(main),
    'on_activate must present the existing window instead of building a duplicate');
});
test('banner taps queue until the page is ready (never dropped)', () => {
  assert(/"load-changed", G_CALLBACK\(on_webview_load_changed\)/.test(main),
    'route flush needs the load-changed gate');
  assert(/queue_question_route\(chat_id, ix_id\)/.test(main), 'taps must queue');
  assert(/flush_pending_route\(\);/.test(main), 'queued taps must flush on ready');
  assert(!/if \(!g_view\)\s*\n\s*return;/.test(main.split('on_open_question_action')[1] || ''),
    'on_open_question must queue when the view is missing, not return');
});
test('routes wait for hydration and clear only on receipt', () => {
  assert(/!g_view \|\| !g_page_ready \|\| !g_boot_ready/.test(main),
    'flush must gate on the hydrated ready post, not load-finished alone');
  assert(/g_strcmp0\(op, "ready"\) == 0/.test(main), 'missing {op:ready} hydration handler');
  assert(/g_strcmp0\(op, "routed"\) == 0/.test(main), 'missing {op:routed} receipt handler');
  assert(/clear_question_route\(\);/.test(main), 'receipt must clear the matching queued route');
  assert(!/on_ready_timeout|g_ready_timer/.test(main),
    'no timer may clear the queue without a receipt — a slow renderer is not legacy');
});
test('closed windows rebuild on tap instead of dangling', () => {
  assert(/"destroy", G_CALLBACK\(on_shell_window_destroy\)/.test(main),
    'window destroy must drop the dangling view');
  assert(/if \(\(!g_view \|\| !shell_view_usable\(\)\) && g_app\)\s*\n\s*g_application_activate\(g_app\);/.test(main),
    'a tap with no (usable) window must activate (create) one, not route nowhere');
  assert(/GtkNative \*native = gtk_widget_get_native/.test(main),
    'get_native returns GtkNative*, not GtkWidget* (Guix compile error)');
});
test('host payloads validate the key and parse JSON with JSC', () => {
  assert(/muse_notify_key_valid\(key\)/.test(main), 'D-Bus keys must be validated (any local caller can send)');
  assert(/jsc_context_evaluate\(ctx, expr/.test(main), 'payload JSON must parse via JSC (no new dep, UTF-8 safe)');
  assert(/muse-desktop/.test(main) && /notify-%s\.json/.test(main),
    'payload path must match the host notifier (runtime/muse-desktop/notify-<key>.json)');
});
test('installer hides the legacy entry; the app-id entry stays canonical', () => {
  const inst = read('scripts/install-desktop.sh');
  assert(/NoDisplay=true/.test(inst), 'legacy muse-desktop.desktop must install hidden');
  assert(/applications\/com\.aukkwat83\.MuseDesktop\.desktop/.test(inst),
    'canonical app-id entry must install visible');
  assert(/NoDisplay=true"; \} >"\$HOME\/\.local\/share\/applications\/muse-desktop\.desktop"/.test(inst),
    'the applications/ legacy entry must be the hidden one (no second visible duplicate)');
});
test('installer enables bus activation with a service file', () => {
  const inst = read('scripts/install-desktop.sh');
  assert(/^DBusActivatable=true$/m.test(inst), 'canonical entry must be D-Bus activatable');
  assert(!/^DBusActivatable=false$/m.test(inst), 'no entry may carry DBusActivatable=false');
  assert(/dbus-1\/services\/com\.aukkwat83\.MuseDesktop\.service/.test(inst),
    'a same-app-id .service file must launch the closed shell on bus calls');
  assert(/Name=com\.aukkwat83\.MuseDesktop/.test(inst), 'service Name must match the app id');
});
test('desktop entry ships under the app-id name (GAction dispatch)', () => {
  assert(
    fs.existsSync(path.join(ROOT, 'assets/com.aukkwat83.MuseDesktop.desktop')),
    'assets/com.aukkwat83.MuseDesktop.desktop missing — GNOME may not dispatch open-question',
  );
  const inst = read('scripts/install-desktop.sh');
  assert(/com\.aukkwat83\.MuseDesktop\.desktop/.test(inst),
    'install-desktop.sh must install the app-id desktop file',
  );
  return 'banner taps dispatch under GNOME';
});
test('python fallback shell mirrors the notify contract', () => {
  const py = read('linux/gtk-shell/muse_desktop_shell.py');
  assert(/register_script_message_handler\("museNotify"/.test(py), 'python shell missing museNotify');
  assert(/"open-question"/.test(py) && /"\(ss\)"/.test(py), 'python shell missing the typed action');
  assert(/__museQuestionRoute/.test(py), 'python shell missing routing');
  assert(/def do_startup/.test(py) && /"notify-question"/.test(py), 'python shell must register notify-question at startup');
  assert(/_flush_route/.test(py) && /load-changed/.test(py), 'python shell must queue taps until the page is ready');
  assert(/_notify_key_valid/.test(py), 'python shell must validate host keys');
  assert(/_boot_ready/.test(py) && /op == "ready"/.test(py), 'python shell must wait for the hydration handshake');
  assert(/op == "routed"/.test(py), 'python shell must clear routes only on receipt');
  assert(/self\._win = None/.test(py) && /self\.activate\(\)/.test(py), 'python shell must rebuild closed windows on tap');
});

console.log(`\n${c.b}== zombie-window recovery (1.1.34) ==${c.x}`);
test('on_activate verifies the existing window before presenting it', () => {
  assert(/if \(shell_window_usable\(existing\)\)/.test(main),
    'a dead surface still reports visible+mapped — presenting it unverified is the 2026-10-08 "won\'t open"');
  assert(/gtk_window_present\(existing\);/.test(main), 'healthy windows must still present, not rebuild');
});
test('an unusable window is destroyed and rebuilt, never presented', () => {
  const act = main.slice(main.indexOf('static void on_activate'), main.indexOf('int main('));
  assert(/gone at the X server — rebuilding/.test(act), 'the zombie path must log loudly (silent recovery hides regressions)');
  assert(/gtk_window_destroy\(existing\);/.test(act),
    'the zombie must be destroyed so the build below makes a fresh window');
});
test('the detector round-trips the X server (the only working probe)', () => {
  assert(/static gboolean shell_window_usable\(GtkWindow \*win\)/.test(main), 'shell_window_usable missing');
  assert(/GDK_IS_X11_DISPLAY/.test(main), 'the X check must be gated to X11 (Wayland has no external-destroy path)');
  assert(/XGetWindowAttributes/.test(main) && /XSync/.test(main) && /XSetErrorHandler/.test(main),
    'liveness needs attribute query + sync + a temporary error handler');
  assert(/g_x11_err_code == 3 && g_x11_err_xid == xid/.test(main),
    'only BadWindow for OUR xid proves a zombie — any other error is somebody else\'s request');
});
test('libX11 stays dlopened — no new link dependency', () => {
  assert(/dlopen\(paths\[i\]/.test(main), 'libX11 must load via dlopen');
  const build = read('linux/gtk-shell/build.sh');
  assert(!/-lX11/.test(build), 'never link -lX11 (manifest has no libX11 headers by design)');
  assert(/-ldl/.test(build), 'dlopen needs -ldl on old glibc (a stub on new)');
});
test('rebuilds do not stack a second memory meter', () => {
  assert(/if \(g_meter_src == 0\)/.test(main),
    'a second on_activate build must reuse the running meter source');
});
test('app id is overridable for e2e isolation (default unchanged)', () => {
  assert(/MUSE_DESKTOP_APP_ID", "com\.aukkwat83\.MuseDesktop"/.test(main),
    'override must default to the production app id');
  assert(/g_application_id_is_valid/.test(main), 'an invalid override must fall back, not fail to register');
});
test('python fallback shell mirrors the zombie recovery', () => {
  const py = read('linux/gtk-shell/muse_desktop_shell.py');
  assert(/_x11_own_window_alive/.test(py), 'python shell missing the liveness check');
  assert(/gone at the X server/.test(py), 'python shell must log the rebuild like the C shell');
  assert(/MUSE_DESKTOP_APP_ID/.test(py), 'python shell must take the same app-id override');
  assert(/if not self\._meter_id:/.test(py), 'python rebuilds must not stack a second meter');
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
