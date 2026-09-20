#!/usr/bin/env node
// Theme pref normalisation: missing/unknown → 'auto' (BUG-055).
//
// theme-boot.js is a blocking classic script (no imports, on purpose — it runs
// before first paint), so the suite executes the real file in a vm sandbox
// with a fake DOM and inspects what the boot wrote: the dataset, localStorage
// and the window.__museTheme API that app.js reuses.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOT = fs.readFileSync(path.join(ROOT, 'src/renderer/theme-boot.js'), 'utf8');
const KEY = 'muse-desktop.theme';

function boot({ stored = null, dark = true, throwingStorage = false } = {}) {
  const data = {};
  if (stored !== null) data[KEY] = stored;
  const localStorage = throwingStorage
    ? {
        getItem() {
          throw new Error('denied');
        },
        setItem() {
          throw new Error('denied');
        },
      }
    : {
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => {
          data[k] = String(v);
        },
      };
  const window = {
    matchMedia: (query) => ({ matches: dark && query.includes('dark') }),
  };
  const dataset = {};
  const sandbox = { window, document: { documentElement: { dataset } }, localStorage };
  vm.createContext(sandbox);
  vm.runInContext(BOOT, sandbox);
  return { dataset, data, api: window.__museTheme };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('a fresh install records auto and paints per-OS (dark)', () => {
  const { dataset, data } = boot({ stored: null, dark: true });
  assert.equal(dataset.themePref, 'auto');
  assert.equal(dataset.theme, 'claude-dark');
  assert.equal(data[KEY], 'auto');
});

test('a fresh install on a light OS paints claude-light', () => {
  const { dataset } = boot({ stored: null, dark: false });
  assert.equal(dataset.themePref, 'auto');
  assert.equal(dataset.theme, 'claude-light');
});

test('a valid stored pref survives untouched', () => {
  const { dataset, data } = boot({ stored: 'daylight' });
  assert.equal(dataset.themePref, 'daylight');
  assert.equal(dataset.theme, 'daylight');
  assert.equal(data[KEY], 'daylight');
});

test('an unknown stored pref migrates to auto and is persisted', () => {
  const { dataset, data } = boot({ stored: 'neon', dark: true });
  assert.equal(dataset.themePref, 'auto');
  assert.equal(dataset.theme, 'claude-dark');
  assert.equal(data[KEY], 'auto');
});

test("stored 'auto' stays auto and follows the OS", () => {
  assert.equal(boot({ stored: 'auto', dark: true }).dataset.theme, 'claude-dark');
  assert.equal(boot({ stored: 'auto', dark: false }).dataset.theme, 'claude-light');
});

test('a throwing localStorage (private mode) still boots as auto', () => {
  const { dataset } = boot({ throwingStorage: true });
  assert.equal(dataset.themePref, 'auto');
});

test('the exposed normalize/resolve share the one rule', () => {
  const { api } = boot({});
  assert.equal(api.normalize('moonlight'), 'moonlight');
  assert.equal(api.normalize('claude-light'), 'claude-light');
  assert.equal(api.normalize('claude-dark'), 'claude-dark');
  assert.equal(api.normalize('auto'), 'auto');
  assert.equal(api.normalize(null), 'auto');
  assert.equal(api.normalize(''), 'auto');
  assert.equal(api.normalize('AUTO'), 'auto');
  assert.equal(api.resolve('daylight'), 'daylight');
  assert.equal(api.resolve('garbage'), 'claude-dark'); // dark sandbox → auto paints claude-dark
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
console.log(`theme-boot: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
