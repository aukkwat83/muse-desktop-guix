#!/usr/bin/env node
// E2E: the native GTK shell recovers from an externally-destroyed window.
//
// Incident 2026-10-08: the shell's X surface died outside GTK
// ("GdkSurface unexpectedly destroyed" — NOT a normal close, so the process
// lived on holding a dead GtkWindow). Every launcher Activate then hit
// on_activate's `existing != NULL` branch and presented the zombie: the app
// "wouldn't open" with zero errors. The fix verifies the existing window
// against the X server and rebuilds when it is gone.
//
// What it proves, with a REAL shell binary + REAL host + REAL X server:
//   1. the shell maps a window for a fresh app id (MUSE_DESKTOP_APP_ID keeps
//      the test instance off the user's live app bus name);
//   2. externally XDestroyWindow-ing that toplevel leaves the shell process
//      alive (the zombie precondition — a normal close would exit);
//   3. a launcher-style D-Bus Activate then maps a NEW window (pre-fix:
//      nothing maps — the suite fails here);
//   4. the rebuild goes through on_activate's build path (bridge markers
//      appear twice) and serves the test host.
//
// Preconditions (else SKIP, exit 0): an X11 display, the built shell binary,
// python3, gdbus. A window flashes on the live desktop for ~20s — this box
// has no Xvfb, so the live display is the only stage.

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_BIN = path.join(ROOT, 'linux/gtk-shell/muse-desktop-shell');
const FIXTURE = path.join(ROOT, 'scripts/fixture-x11-ctl.py');
const MOCK = path.join(ROOT, 'scripts/mock-msp-agent.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function have(cmd, probeArgs) {
  // `command -v` is a shell builtin — execFile has no shell, so probe the
  // binary itself (also proves it RUNS, not just that a path exists).
  try {
    await run(cmd, probeArgs, { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

function req(base, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const r = http.request(
      url,
      { method, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, ...(text ? JSON.parse(text) : {}) });
          } catch {
            resolve({ status: res.statusCode, raw: text });
          }
        });
      },
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ok   ${name}`);
  } catch (err) {
    results.push([false, name]);
    console.log(`  FAIL ${name}\n       ${String(err?.message || err).split('\n').join('\n       ')}`);
  }
}

function skip(why) {
  console.log(`e2e-shell-zombie: SKIP — ${why}`);
  process.exit(0);
}

// ---- preconditions (all must hold, else this stage cannot run) ----
if (!process.env.DISPLAY) skip('no X11 DISPLAY (headless/CI without X)');
if (!fs.existsSync(SHELL_BIN)) skip('shell binary not built (linux/gtk-shell/build.sh)');
try {
  fs.accessSync(SHELL_BIN, fs.constants.X_OK);
} catch {
  skip('shell binary not executable');
}
if (!(await have('python3', ['--version']))) skip('python3 missing (fixture needs it)');
if (!(await have('gdbus', ['help']))) skip('gdbus missing (Activate probe needs it)');
try {
  await run('python3', [FIXTURE, 'probe'], { timeoutMs: 10_000 });
} catch (err) {
  skip(`X11 fixture cannot reach the display (${String(err?.stderr || err).trim().split('\n')[0]})`);
}

// ---- hermetic stage: own host, own state, own bus name ----
const port = 3900 + Math.floor(Math.random() * 400);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-zombie-'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-zombie-cfg-'));
fs.mkdirSync(path.join(configDir, 'muse'), { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'muse', 'settings.json'),
  JSON.stringify({ schema_version: 1, mcpServers: {} }),
);
const APP_ID = `com.aukkwat83.MuseDesktop.E2E${process.pid}`;
const OBJ_PATH = `/${APP_ID.replace(/\./g, '/')}`;

const host = spawn(process.execPath, [path.join(ROOT, 'src/server/index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    MUSE_DESKTOP_PORT: String(port),
    MUSE_DESKTOP_HOST: '127.0.0.1',
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: path.join(stateDir, 'xdg'),
    NO_OPEN: '1',
    MUSE_BIN: MOCK,
    MUSE_DESKTOP_CREATE_WARM: '0',
    MUSE_DESKTOP_NOTIFY: 'on',
    MUSE_DESKTOP_NOTIFY_LOG: path.join(stateDir, 'notify.log'),
  },
  stdio: ['ignore', 'ignore', 'ignore'],
});
const base = `http://127.0.0.1:${port}`;
let hostUp = false;
for (let i = 0; i < 100; i++) {
  try {
    const r = await req(base, 'GET', '/api/state');
    if (r.ok) {
      hostUp = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await sleep(100);
}
if (!hostUp) {
  try { host.kill('SIGKILL'); } catch { /* gone */ }
  console.log('e2e-shell-zombie: FAIL — test host never became healthy');
  process.exit(1);
}

// Same env shape as scripts/native-launch.sh run_shell (esp. the WebKit
// sandbox flag — bubblewrap breaks under guix store paths, localhost UI).
const shellLogs = [];
const shell = spawn(SHELL_BIN, [], {
  env: {
    ...process.env,
    MUSE_DESKTOP_PORT: String(port),
    MUSE_DESKTOP_HOST: '127.0.0.1',
    MUSE_DESKTOP_ROOT: ROOT,
    MUSE_DESKTOP_APP_ID: APP_ID,
    XDG_STATE_HOME: stateDir,
    NO_OPEN: '1',
    MUSE_DESKTOP_KEEP_ON_EXIT: '1',
    WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
shell.stdout.on('data', (b) => shellLogs.push(b.toString()));
shell.stderr.on('data', (b) => shellLogs.push(b.toString()));

let xid1 = null;
let xid2 = null;
try {
  await step('shell maps a first window for the test app id', async () => {
    const { stdout } = await run(
      'python3',
      [FIXTURE, 'wait', '--pid', String(shell.pid), '--title', 'Muse Desktop', '--timeout', '40'],
      { timeoutMs: 50_000 },
    );
    xid1 = stdout.trim();
    assert.match(xid1, /^\d+$/, `no XID from fixture (got: ${JSON.stringify(xid1)})`);
  });

  await step('external destroy leaves the shell process alive (zombie)', async () => {
    assert.ok(xid1, 'no first window — the kill step cannot run');
    await run('python3', [FIXTURE, 'destroy', '--xid', xid1], { timeoutMs: 10_000 });
    const { stdout } = await run('python3', [FIXTURE, 'state', '--xid', xid1], { timeoutMs: 10_000 });
    assert.equal(stdout.trim(), 'gone', `the kill must land (state: ${stdout.trim()})`);
    await sleep(1200);
    assert.equal(shell.exitCode, null, 'shell exited — that is a normal close, not the zombie state');
    assert.equal(shell.signalCode, null, 'shell was signalled — expected it alive but windowless');
  });

  await step('a launcher-style Activate maps a NEW window (recovery)', async () => {
    assert.ok(xid1, 'no first window — recovery cannot be tested');
    await run(
      'gdbus',
      ['call', '--session', '--dest', APP_ID, '--object-path', OBJ_PATH,
        '--method', 'org.freedesktop.Application.Activate', '{}'],
      { timeoutMs: 10_000 },
    );
    const { stdout } = await run(
      'python3',
      [FIXTURE, 'wait', '--pid', String(shell.pid), '--title', 'Muse Desktop',
        '--not-xid', xid1, '--timeout', '15'],
      { timeoutMs: 25_000 },
    );
    xid2 = stdout.trim();
    assert.match(xid2, /^\d+$/, 'no new window mapped after Activate (zombie not recovered)');
    assert.notEqual(xid2, xid1, 'the "new" window is the destroyed XID');
  });

  await step('the rebuild goes through the build path and serves the host', async () => {
    const log = shellLogs.join('');
    const builds = (log.match(/cardDrag bridge registered/g) || []).length;
    assert.ok(
      builds >= 2,
      `expected two window builds (initial + recovery), saw ${builds}.\n--- shell log ---\n${log}`,
    );
    const r = await req(base, 'GET', '/');
    assert.equal(r.status, 200, `test host must serve / (got ${r.status})`);
  });
} finally {
  try { shell.kill('SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + 3000;
  while (shell.exitCode === null && Date.now() < deadline) await sleep(100);
  try { shell.kill('SIGKILL'); } catch { /* already gone */ }
  await req(base, 'POST', '/api/host/shutdown', { killAgents: true }).catch(() => {});
  await sleep(300);
  try { host.kill('SIGKILL'); } catch { /* already gone */ }
  for (const dir of [stateDir, configDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`e2e-shell-zombie: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
