#!/usr/bin/env node
// Contributor billing mode: the CLI moved the mode out of the model list
// into its own settings.json, so the desktop reads/ensures the flag.
// Default is contributor ON and locked on (standard billing disabled);
// only MUSE_DESKTOP_CONTRIBUTOR_LOCK=0 honors an explicit false; a
// malformed file is never rewritten. Hermetic: XDG_CONFIG_HOME points at a
// temp dir, the developer's real CLI config is never touched.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cliSettingsPath,
  contributorLocked,
  enforceContributorLock,
  ensureContributorDefault,
  readContributorState,
  setContributorEnabled,
} from '../src/server/contributor.js';

const UNLOCKED = { MUSE_DESKTOP_CONTRIBUTOR_LOCK: '0' };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-contrib-'));
  return { dir, file: path.join(dir, 'muse', 'settings.json') };
}

function withXdg(dir, fn) {
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    fn();
  } finally {
    if (saved == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
}

test('settings path lives under XDG_CONFIG_HOME/muse', () => {
  withXdg('/tmp/xdg-test', () => {
    assert.equal(cliSettingsPath(), path.join('/tmp/xdg-test', 'muse', 'settings.json'));
  });
});

test('missing file resolves to contributor default', () => {
  const { dir } = tmpConfig();
  withXdg(dir, () => {
    const st = readContributorState();
    assert.equal(st.enabled, true);
    assert.equal(st.source, 'default');
  });
});

test('absent key resolves to contributor default', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1 }));
  withXdg(dir, () => {
    const st = readContributorState();
    assert.equal(st.enabled, true);
    assert.equal(st.source, 'default');
  });
});

test('explicit false is honored, explicit true is kept', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withXdg(dir, () => {
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, contributor_mode_enabled: false }));
    assert.equal(readContributorState().enabled, false);
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, contributor_mode_enabled: true }));
    const st = readContributorState();
    assert.equal(st.enabled, true);
    assert.equal(st.source, 'settings');
  });
});

test('malformed file resolves to default without throwing', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{nope');
  withXdg(dir, () => {
    const st = readContributorState();
    assert.equal(st.enabled, true);
    assert.equal(st.source, 'default');
    assert.equal(fs.readFileSync(file, 'utf8'), '{nope');
  });
});

test('ensure creates a minimal file when missing', () => {
  const { dir, file } = tmpConfig();
  withXdg(dir, () => {
    const st = ensureContributorDefault();
    assert.equal(st.enabled, true);
    assert.equal(st.source, 'default-written');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.contributor_mode_enabled, true);
    assert.equal(doc.schema_version, 1);
  });
});

test('ensure adds the key and keeps a .bak of the original', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = { schema_version: 1, model: 'muse-spark-1.3' };
  fs.writeFileSync(file, JSON.stringify(before));
  withXdg(dir, () => {
    const st = ensureContributorDefault();
    assert.equal(st.enabled, true);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(after.contributor_mode_enabled, true);
    assert.equal(after.model, 'muse-spark-1.3');
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), before);
  });
});

test('unlocked ensure never rewrites an explicit opt-out', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, contributor_mode_enabled: false }));
  withXdg(dir, () => {
    const st = ensureContributorDefault({ env: UNLOCKED });
    assert.equal(st.enabled, false);
    assert.equal(st.source, 'settings');
    assert.equal(st.locked, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).contributor_mode_enabled, false);
  });
});

test('ensure never touches a malformed file', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{nope');
  withXdg(dir, () => {
    const st = ensureContributorDefault();
    assert.equal(st.enabled, true);
    assert.equal(st.source, 'default');
    assert.equal(fs.readFileSync(file, 'utf8'), '{nope');
  });
});

test('switch writes the mode, preserves other keys, records disclosure on enable', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, model: 'muse-spark-1.3' }));
  withXdg(dir, () => {
    const on = setContributorEnabled(true);
    assert.equal(on.enabled, true);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.contributor_mode_enabled, true);
    assert.equal(doc.contributor_mode_disclosure_acknowledged, true);
    assert.equal(doc.model, 'muse-spark-1.3');
    const off = setContributorEnabled(false, { env: UNLOCKED });
    assert.equal(off.enabled, false);
    const doc2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc2.contributor_mode_enabled, false);
    assert.equal(readContributorState().enabled, false);
  });
});

test('switch refuses a non-boolean and a malformed file', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  withXdg(dir, () => {
    assert.throws(() => setContributorEnabled('yes'));
    fs.writeFileSync(file, '{nope');
    assert.throws(() => setContributorEnabled(true), /refusing/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{nope');
  });
});

test('MUSE_DESKTOP_CONTRIBUTOR_DEFAULT=0 skips the write only when unlocked', () => {
  const { dir, file } = tmpConfig();
  const saved = process.env.MUSE_DESKTOP_CONTRIBUTOR_DEFAULT;
  const savedLock = process.env.MUSE_DESKTOP_CONTRIBUTOR_LOCK;
  process.env.MUSE_DESKTOP_CONTRIBUTOR_DEFAULT = '0';
  process.env.MUSE_DESKTOP_CONTRIBUTOR_LOCK = '0';
  try {
    withXdg(dir, () => {
      const st = ensureContributorDefault();
      assert.equal(st.enabled, true);
      assert.equal(st.source, 'default');
      assert.ok(!fs.existsSync(file));
    });
  } finally {
    if (saved == null) delete process.env.MUSE_DESKTOP_CONTRIBUTOR_DEFAULT;
    else process.env.MUSE_DESKTOP_CONTRIBUTOR_DEFAULT = saved;
    if (savedLock == null) delete process.env.MUSE_DESKTOP_CONTRIBUTOR_LOCK;
    else process.env.MUSE_DESKTOP_CONTRIBUTOR_LOCK = savedLock;
  }
});

test('contributor is locked on by default; only an explicit 0 unlocks', () => {
  assert.equal(contributorLocked({}), true);
  assert.equal(contributorLocked({ MUSE_DESKTOP_CONTRIBUTOR_LOCK: '1' }), true);
  assert.equal(contributorLocked({ MUSE_DESKTOP_CONTRIBUTOR_LOCK: '0' }), false);
});

test('locked ensure forces a stored opt-out back to contributor', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, contributor_mode_enabled: false }));
  withXdg(dir, () => {
    const st = ensureContributorDefault({ env: {} });
    assert.equal(st.enabled, true);
    assert.equal(st.source, 'lock-forced');
    assert.equal(st.locked, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).contributor_mode_enabled, true);
    assert.equal(readContributorState().locked, true);
  });
});

test('the lock wins over MUSE_DESKTOP_CONTRIBUTOR_DEFAULT=0', () => {
  const { dir, file } = tmpConfig();
  withXdg(dir, () => {
    const st = ensureContributorDefault({ env: { MUSE_DESKTOP_CONTRIBUTOR_DEFAULT: '0' } });
    assert.equal(st.enabled, true);
    assert.equal(st.locked, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).contributor_mode_enabled, true);
  });
});

test('locked switch refuses to turn contributor off and moves nothing', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, contributor_mode_enabled: true }));
  withXdg(dir, () => {
    assert.throws(
      () => setContributorEnabled(false, { env: {} }),
      (err) => err.status === 403 && /locked/.test(err.message),
    );
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).contributor_mode_enabled, true);
    // Turning it on again stays allowed under lock.
    assert.equal(setContributorEnabled(true, { env: {} }).enabled, true);
  });
});

test('enforce reverts an external standard flip; unlocked it only reads', () => {
  const { dir, file } = tmpConfig();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, contributor_mode_enabled: false }));
  withXdg(dir, () => {
    const unlocked = enforceContributorLock({ env: UNLOCKED });
    assert.equal(unlocked.flipped, false);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).contributor_mode_enabled, false);
    const locked = enforceContributorLock({ env: {} });
    assert.equal(locked.flipped, true);
    assert.equal(locked.enabled, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).contributor_mode_enabled, true);
    // Steady state: nothing left to revert.
    assert.equal(enforceContributorLock({ env: {} }).flipped, false);
  });
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(`contributor: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
