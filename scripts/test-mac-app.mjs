#!/usr/bin/env node
// macOS shell + host-supervision static checks (BUG-067), ported from
// the kimi lineage's test-mac-app.mjs, adapted to muse's paths.
// Pins the load-bearing Swift invariants so a future edit cannot quietly drop
// them: XDG-only state dir, verified-pid-before-kill, HTTP-first shutdown.
//
//   node scripts/test-mac-app.mjs
//   npm run test:mac-app
//
// Live host probes are optional (skipped when the host is down) and NEVER
// POST /api/host/shutdown — a GET probe proves the verb gate holds instead.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.MUSE_DESKTOP_URL || 'http://127.0.0.1:3850';

const hostSupervisor = fs.readFileSync(
  path.join(ROOT, 'macos/MuseDesktopShell/Sources/MuseDesktopShell/HostSupervisor.swift'),
  'utf8',
);
const contentView = fs.readFileSync(
  path.join(ROOT, 'macos/MuseDesktopShell/Sources/MuseDesktopShell/ContentView.swift'),
  'utf8',
);
const appSwift = fs.readFileSync(
  path.join(ROOT, 'macos/MuseDesktopShell/Sources/MuseDesktopShell/MuseDesktopShellApp.swift'),
  'utf8',
);
const macLaunch = fs.readFileSync(path.join(ROOT, 'scripts/mac-launch.sh'), 'utf8');
const indexJs = fs.readFileSync(path.join(ROOT, 'src/server/index.js'), 'utf8');
const deploySh = fs.readFileSync(path.join(ROOT, 'scripts/deploy.sh'), 'utf8');
const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let passed = 0;
let failed = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── HostSupervisor.swift ─────────────────────────────────────────
ok(
  'stateDir is XDG ~/.local/state only (no Application Support code path)',
  /~\/\.local\/state/.test(hostSupervisor) &&
    !/applicationSupportDirectory/.test(hostSupervisor) &&
    /XDG_STATE_HOME/.test(hostSupervisor),
  'XDG only',
);
ok(
  'HostSupervisor posts /api/host/shutdown',
  /\/api\/host\/shutdown/.test(hostSupervisor) && /requestShutdown|stopHostAndAgents/.test(hostSupervisor),
);
ok(
  'PID ownership via /api/state pid before kill',
  /fetchStatePid|verifiedOursPid/.test(hostSupervisor) &&
    /refusing|not killing|mismatch/i.test(hostSupervisor),
);
ok(
  'restart serializes + polls port free',
  /func restart\(/.test(hostSupervisor) &&
    /lifecycleGate|LifecycleGate/.test(hostSupervisor) &&
    /waitUntilUnhealthy/.test(hostSupervisor),
);
ok(
  'stopHostAndAgents uses HTTP first',
  /func stopHostAndAgents/.test(hostSupervisor) &&
    /requestShutdown\(killAgents:\s*true\)/.test(hostSupervisor),
);

// ── App / ContentView wiring ─────────────────────────────────────
ok(
  'Host menu uses stopHostAndAgents',
  /stopHostAndAgents/.test(appSwift),
);
ok(
  'toolbar still uses /api/memory meter',
  /\/api\/memory/.test(contentView),
);

// ── mac-launch.sh LSEnvironment proxy vars ───────────────────────
ok(
  'mac-launch exports proxy vars at top',
  /export https_proxy=/.test(macLaunch) &&
    /export http_proxy=/.test(macLaunch) &&
    /export HTTPS_PROXY=/.test(macLaunch) &&
    /export HTTP_PROXY=/.test(macLaunch),
);
ok(
  'wrap_app LSEnvironment includes proxy keys',
  /LSEnvironment/.test(macLaunch) &&
    /<key>http_proxy<\/key>/.test(macLaunch) &&
    /<key>https_proxy<\/key>/.test(macLaunch) &&
    /<key>HTTP_PROXY<\/key>/.test(macLaunch) &&
    /<key>HTTPS_PROXY<\/key>/.test(macLaunch) &&
    /<key>no_proxy<\/key>/.test(macLaunch) &&
    /<key>NO_PROXY<\/key>/.test(macLaunch),
);
ok(
  'mac-launch STATE is XDG muse-desktop',
  /XDG_STATE_HOME[^)]*\/muse-desktop|\$HOME\/\.local\/state\}\/muse-desktop/.test(macLaunch),
);

// ── mac-launch.sh stop fallback (BUG-068) ────────────────────────
ok(
  'stop fallback verifies the pid via /api/state before signalling',
  /curl[^|\n]*\/api\/state/.test(macLaunch) && /kill -TERM "\$api_pid"/.test(macLaunch),
);
ok(
  'never signals a pid read only from the pid file',
  !/kill -TERM "\$\(cat /.test(macLaunch) && /refusing to signal/.test(macLaunch),
);

// ── deploy.sh (BUG-069) ──────────────────────────────────────────
ok(
  'deploy stops the old host before starting (shutdown-first)',
  // The teardown itself lives in mac-launch.sh stop (HTTP-first, verified
  // pid) — deploy must route through it rather than re-implement signals.
  /mac-launch\.sh" stop/.test(deploySh) && /stop_host/.test(deploySh),
);
ok(
  'deploy has a /api/state health gate that fails the run',
  /\/api\/state/.test(deploySh) &&
    /healthy/.test(deploySh) &&
    /health gate within 15s/.test(deploySh) &&
    /LOG_FILE/.test(deploySh),
);
ok(
  'deploy starts the host detached with nohup',
  /nohup node /.test(deploySh) && /NO_OPEN=1/.test(deploySh),
);
ok(
  'deploy asserts Node >= 20 and installs deps only when marked is missing',
  /-ge 20/.test(deploySh) && /node_modules\/marked/.test(deploySh),
);
ok(
  'deploy runs the post-deploy e2e smoke',
  /npm run test:e2e/.test(deploySh),
);
ok(
  'deploy never manages processes by name/port (no pkill/fuser/lsof/nc probe)',
  !/pkill/.test(deploySh) && !/fuser/.test(deploySh) &&
    !/lsof/.test(deploySh) && !/nc -z/.test(deploySh),
  'proxy process untouched — URL is env-only',
);
ok(
  'package.json exposes deploy / deploy:stop / deploy:status',
  !!pkgJson.scripts?.deploy && !!pkgJson.scripts?.['deploy:stop'] && !!pkgJson.scripts?.['deploy:status'],
);

// ── Server route table ───────────────────────────────────────────
ok(
  'index.js registers POST /api/host/shutdown',
  /pathname === '\/api\/host\/shutdown' && method === 'POST'/.test(indexJs) &&
    /killAgents/.test(indexJs),
);
ok(
  '/api/state exposes pid',
  /pid:\s*process\.pid/.test(indexJs),
);
ok(
  'host writes host.pid on listen',
  /writeFileSync\(PID_FILE, String\(process\.pid\)/.test(indexJs),
);

// ── Live probes (never POST shutdown) ────────────────────────────
async function live() {
  let hostUp = false;
  try {
    const r = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(2500) });
    hostUp = r.ok;
  } catch {
    hostUp = false;
  }

  if (!hostUp) {
    console.log(`\n(host down at ${BASE} — skipping live probes)`);
    return;
  }

  console.log(`\n  live probes @ ${BASE} (no shutdown POST)`);

  try {
    const st = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(2500) }).then((r) =>
      r.json(),
    );
    ok('live GET /api/state has numeric pid', typeof st.pid === 'number' && st.pid > 1, `pid=${st.pid}`);
  } catch (e) {
    ok('live GET /api/state has numeric pid', false, e.message);
  }

  try {
    const ver = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(2500) }).then((r) =>
      r.json(),
    );
    ok('live GET /api/version ok', ver.ok === true && !!ver.version, ver.version || '');
  } catch (e) {
    ok('live GET /api/version ok', false, e.message);
  }

  // A stray GET must never tear the host down — only POST may.
  try {
    const r = await fetch(`${BASE}/api/host/shutdown`, { signal: AbortSignal.timeout(2500) });
    ok('live GET /api/host/shutdown is refused', r.status !== 200 && r.status !== 202, `status=${r.status}`);
    const still = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(2500) });
    ok('host still healthy after the GET probe', still.ok);
  } catch (e) {
    ok('live GET /api/host/shutdown is refused', false, e.message);
  }

  // Explicit guard: this file must never POST shutdown live.
  ok('test does not POST /api/host/shutdown live', true, 'source-only + GET probes');
}

await live();

console.log(`\nmac-app: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
