#!/usr/bin/env node
/**
 * Guix platform contracts (everything around the C shell).
 *
 * The C shell itself is guarded by scripts/unit-test-guix-shell.mjs; this
 * locks the rest of the Linux/Guix surface, all of which mac never executes:
 *
 *   - linux/gtk-shell/manifest.scm carries the runtime + build closure
 *   - assets/muse-desktop.desktop + linux/systemd/muse-desktop-host.service
 *   - src/server/file-picker.js pure rules (argv/parse/cancel)
 *   - defaultPacProxy: the PAC fallback is darwin-only (a dead 127.0.0.1:39080
 *     on Guix would break agent TLS)
 *   - /api/pick-files drives a freedesktop dialog off-darwin
 *   - launchers stay executable; package.json keeps the guix scripts
 *
 *   node scripts/unit-test-guix-platform.mjs
 *   npm run test:guix
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveDialog,
  dialogArgs,
  dialogKindFor,
  parsePickerPaths,
  isPickerCancel,
  noDialogMessage,
} from '../src/server/file-picker.js';
import { defaultPacProxy } from '../src/server/msp-client.js';

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

console.log(`${c.b}Guix platform (manifest · desktop · service · picker · proxy)${c.x}\n`);

console.log(`${c.b}== manifest.scm ==${c.x}`);
test('manifest carries the GTK runtime + curl + build closure', () => {
  const scm = read('linux/gtk-shell/manifest.scm');
  for (const pkg of ['"gtk"', '"libadwaita"', '"webkitgtk"', '"curl"']) {
    assert(scm.includes(pkg), `runtime package missing: ${pkg}`);
  }
  for (const pkg of ['"gcc-toolchain"', '"pkg-config"', '"gobject-introspection"']) {
    assert(scm.includes(pkg), `build package missing: ${pkg}`);
  }
  return 'shell builds standalone against /gnu/store';
});

console.log(`\n${c.b}== desktop entry + systemd service ==${c.x}`);
test('desktop entry points at the Guix checkout + native shell class', () => {
  const d = read('assets/muse-desktop.desktop');
  assert(/Name=Muse Desktop/.test(d), 'Name missing');
  assert(/muse-desktop-guix\/bin\/muse-desktop/.test(d), 'Exec must launch bin/muse-desktop');
  assert(/StartupWMClass=com\.aukkwat83\.MuseDesktop/.test(d), 'WMClass must match the GTK app id');
});
test('host service starts node directly with the muse env set', () => {
  const s = read('linux/systemd/muse-desktop-host.service');
  assert(/ExecStart=\/usr\/bin\/env node src\/server\/index\.js/.test(s), 'ExecStart must run the host');
  assert(/WorkingDirectory=%h\/muse-desktop-guix/.test(s), 'WorkingDirectory must be the checkout');
  assert(/Environment=NO_OPEN=1/.test(s), 'NO_OPEN=1 required (launcher opens the window)');
  assert(/Environment=MUSE_DESKTOP_KEEP_ON_EXIT=1/.test(s), 'host must survive UI close');
  assert(!/GROK/.test(s), 'no grok env leftovers');
});

console.log(`\n${c.b}== file-picker.js pure rules ==${c.x}`);
test('dialogKindFor maps clones to their argv dialect', () => {
  assert(dialogKindFor('/run/current-system/profile/bin/zenity') === 'zenity', 'zenity');
  assert(dialogKindFor('/x/qarma') === 'zenity', 'qarma shares zenity argv');
  assert(dialogKindFor('/x/yad') === 'zenity', 'yad shares zenity argv');
  assert(dialogKindFor('/usr/bin/kdialog') === 'kdialog', 'kdialog');
  assert(dialogKindFor('/usr/bin/whatever') === 'zenity', 'unknown defaults to zenity');
});
test('zenity argv uses a REAL newline separator (execFile, no shell)', () => {
  const args = dialogArgs('zenity', {});
  assert(args.includes('--file-selection'), '--file-selection');
  assert(args.includes('--multiple'), '--multiple');
  const sep = args.find((a) => a.startsWith('--separator='));
  assert(sep === '--separator=\n', `separator must be a real newline, got ${JSON.stringify(sep)}`);
  assert(!args.includes('--directory'), 'file mode must not pass --directory');
  const dir = dialogArgs('zenity', { folder: true });
  assert(dir.includes('--directory'), 'folder mode needs --directory');
});
test('kdialog argv splits multi-select output', () => {
  const args = dialogArgs('kdialog', {});
  assert(args.includes('--multiple') && args.includes('--separate-output'), 'multi+separate');
  assert(args.includes('--getopenfilename'), 'open-file verb');
  const dir = dialogArgs('kdialog', { folder: true });
  assert(dir.includes('--getexistingdirectory'), 'folder verb');
});
test('parsePickerPaths splits/trims/drops blanks', () => {
  const out = parsePickerPaths('/a/b.svg\n\n  /c/d.png\n');
  assert(out.length === 2 && out[0] === '/a/b.svg' && out[1] === '/c/d.png', JSON.stringify(out));
});
test('isPickerCancel: non-zero + nothing selected = dismiss', () => {
  assert(isPickerCancel({ code: 1 }, '') === true, 'zenity cancel');
  assert(isPickerCancel({ code: 255 }, '') === true, 'kdialog cancel');
  assert(isPickerCancel(null, '') === false, 'clean exit is not a cancel');
  assert(isPickerCancel({ code: 1 }, '/x.svg\n') === false, 'paths produced = success');
  assert(isPickerCancel({ code: -1 }, '') === false, 'spawn failure is not a cancel');
});
test('noDialogMessage tells the user to install zenity', () => {
  assert(noDialogMessage().includes('zenity'), 'must name the fix');
});
test('resolveDialog honors MUSE_DESKTOP_FILE_DIALOG when it exists', () => {
  const found = resolveDialog({ MUSE_DESKTOP_FILE_DIALOG: process.execPath, PATH: '' });
  assert(found && found.bin === process.execPath, 'override must win over the probe');
});
test('resolveDialog never throws on an unreadable PATH', () => {
  const found = resolveDialog({ PATH: '/nonexistent-dir-xyz' });
  assert(found === null || typeof found.bin === 'string', 'null or a probe hit');
});

console.log(`\n${c.b}== proxy fallback (darwin-only) ==${c.x}`);
test('explicit SCB_PAC_PROXY always wins, on any platform', () => {
  const pac = 'http://proxy.example:8080';
  assert(defaultPacProxy({ SCB_PAC_PROXY: pac }, 'linux') === pac, 'linux explicit');
  assert(defaultPacProxy({ SCB_PAC_PROXY: pac }, 'darwin') === pac, 'darwin explicit');
});
test('darwin falls back to the local PAC bridge', () => {
  assert(
    defaultPacProxy({}, 'darwin') === 'http://127.0.0.1:39080',
    'mac keeps its existing default',
  );
});
test('linux defaults to direct (no dead 127.0.0.1:39080)', () => {
  assert(defaultPacProxy({}, 'linux') === '', 'guix has no PAC bridge to point at');
});

console.log(`\n${c.b}== host wiring ==${c.x}`);
test('/api/pick-files drives a freedesktop dialog off-darwin', () => {
  const js = read('src/server/index.js');
  assert(/from '\.\/file-picker\.js'/.test(js), 'index.js must import file-picker.js');
  assert(/resolveDialog\(\)/.test(js), 'must resolve the dialog per request');
  assert(/dialogArgs\(dialog\.kind/.test(js), 'must use the dialect argv');
  assert(!/native picker available on macOS only/.test(js), 'the dead-end message must be gone');
});
test('spawnEnv uses the darwin-only fallback', () => {
  const js = read('src/server/msp-client.js');
  assert(/defaultPacProxy\(this\.env\)/.test(js), 'spawnEnv must go through defaultPacProxy');
});

console.log(`\n${c.b}== launchers + scripts ==${c.x}`);
test('launchers and build.sh stay executable', () => {
  for (const rel of [
    'bin/muse-desktop',
    'scripts/native-launch.sh',
    'scripts/linux-launch.sh',
    'scripts/install-desktop.sh',
    'linux/gtk-shell/build.sh',
  ]) {
    const st = fs.statSync(path.join(ROOT, rel));
    assert((st.mode & 0o111) !== 0, `${rel} lost its +x bit`);
  }
  return '5 files';
});
test('package.json keeps the guix scripts', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const s of ['desktop:install', 'test:guix', 'test:guix-shell']) {
    assert(pkg.scripts && pkg.scripts[s], `missing script: ${s}`);
  }
  assert(/^1\.1\.0/.test(pkg.version), `guix line starts at 1.1.0, got ${pkg.version}`);
});

console.log(
  `\n${failures.length ? c.r : c.g}${c.b}guix-platform: ${passed} passed, ${failures.length} failed${c.x}`,
);
if (failures.length) {
  for (const f of failures) console.error(`  ${c.r}- ${f.name}: ${f.message}${c.x}`);
  process.exit(1);
}
