#!/usr/bin/env node
// Popover placement + lifecycle: the pure flip/clamp matrix (a popup placed
// from an empty box lands off-screen once filled — the 1280x900 agents-chip
// case), and the onClose guarantee (cleanup runs on EVERY exit, including
// programmatic closePopover and replacement — timers leaked otherwise).
//
// popover.js has no top-level DOM touch, so the pure fns import cleanly;
// the lifecycle half runs against a minimal fake document/window.

import assert from 'node:assert/strict';

import {
  POPOVER_MARGIN,
  clampPlacement,
  computePlacement,
} from '../src/renderer/popover.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('computePlacement puts a fitting popup under the anchor', () => {
  const p = computePlacement(
    { right: 1200, bottom: 60, top: 20 },
    { width: 400, height: 300 },
    { width: 1280, height: 900 },
  );
  assert.deepEqual(p, { left: 800, top: 66 });
});

test('computePlacement measures the FILLED box: full height flips above (1.1.30)', () => {
  // The reproduced bug: an empty root measured ~40px, placed below the
  // low chip (y=787), then the filled 560px panel ran to y=1347.
  const anchor = { right: 1240, bottom: 781, top: 740 };
  const vp = { width: 1280, height: 900 };
  const empty = computePlacement(anchor, { width: 400, height: 40 }, vp);
  assert.equal(empty.top, 787);
  const filled = computePlacement(anchor, { width: 400, height: 560 }, vp);
  assert.deepEqual(filled, { left: 840, top: 174 }, 'real height flips above the anchor');
  assert.ok(filled.top + 560 <= 900 - POPOVER_MARGIN);
});

test('computePlacement clamps into narrow/short viewports', () => {
  const p = computePlacement(
    { right: 350, bottom: 400, top: 360 },
    { width: 600, height: 640 },
    { width: 360, height: 500 },
  );
  assert.ok(p.left >= POPOVER_MARGIN && p.top >= POPOVER_MARGIN);
  // Too big to fit either way: pinned to the margin corner, never negative.
  assert.deepEqual(p, { left: POPOVER_MARGIN, top: POPOVER_MARGIN });
  const noAnchor = computePlacement(null, { width: 100, height: 100 }, { width: 360, height: 500 });
  assert.deepEqual(noAnchor, { left: 130, top: 250 });
});

test('clampPlacement never moves a fitting popup, pulls back overflow', () => {
  assert.deepEqual(
    clampPlacement({ left: 100, top: 100 }, { width: 400, height: 300 }, { width: 1280, height: 900 }),
    { left: 100, top: 100 },
  );
  assert.deepEqual(
    clampPlacement({ left: 840, top: 787 }, { width: 400, height: 560 }, { width: 1280, height: 900 }),
    { left: 840, top: 332 },
    'grown content shifts up just enough to fit',
  );
  assert.deepEqual(
    clampPlacement({ left: -50, top: -20 }, { width: 200, height: 200 }, { width: 1280, height: 900 }),
    { left: POPOVER_MARGIN, top: POPOVER_MARGIN },
  );
});

// --------------------------------------------------------------- lifecycle
// Minimal fake DOM: just what place/arm/closePopover/openPanel touch.

function fakeNode(box = { width: 100, height: 100 }) {
  const listeners = {};
  const attrs = {};
  return {
    style: {},
    dataset: {},
    children: [],
    removed: false,
    attrs,
    classList: { add() {} },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute: (k) => attrs[k] ?? null,
    getBoundingClientRect: () => ({ ...box }),
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { for (const c of cs) this.appendChild(c); },
    contains: () => false,
    remove() { this.removed = true; },
    querySelector: () => null,
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    _listeners: listeners,
  };
}

function installFakeDom(box) {
  const docListeners = {};
  const winListeners = {};
  const body = fakeNode();
  globalThis.document = {
    body,
    activeElement: null,
    createElement: () => fakeNode(box),
    addEventListener: (t, f) => { (docListeners[t] ||= []).push(f); },
    removeEventListener: (t, f) => {
      docListeners[t] = (docListeners[t] || []).filter((g) => g !== f);
    },
    _listeners: docListeners,
  };
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener: (t, f) => { (winListeners[t] ||= []).push(f); },
    removeEventListener: (t, f) => {
      winListeners[t] = (winListeners[t] || []).filter((g) => g !== f);
    },
    _listeners: winListeners,
  };
  return { docListeners, winListeners };
}

function uninstallFakeDom() {
  delete globalThis.document;
  delete globalThis.window;
}

test('closePopover invokes onClose on programmatic dismissal + replacement (1.1.30)', async () => {
  installFakeDom({ width: 400, height: 560 });
  try {
    const pop = await import('../src/renderer/popover.js');
    const anchor = fakeNode({ width: 40, height: 30 });
    anchor.getBoundingClientRect = () => ({ right: 1240, bottom: 781, top: 740 });
    let closes = 0;
    const node = fakeNode({ width: 400, height: 560 });
    const h = pop.openPanel(anchor, node, { onClose: () => { closes += 1; } });
    assert.equal(h.isOpen(), true);
    // Filled box → flipped above the low anchor, inside the viewport.
    assert.equal(node.style.top, '174px');
    pop.closePopover();
    assert.equal(h.isOpen(), false);
    assert.equal(closes, 1, 'programmatic close runs owner cleanup');
    pop.closePopover();
    assert.equal(closes, 1, 'closing with none open runs nothing');

    // Replacement: opening a second panel closes the first WITH cleanup.
    let first = 0;
    let second = 0;
    pop.openPanel(anchor, fakeNode(), { onClose: () => { first += 1; } });
    pop.openPanel(anchor, fakeNode(), { onClose: () => { second += 1; } });
    assert.equal(first, 1, 'replaced panel cleans up');
    assert.equal(second, 0, 'new panel stays open');
    pop.closePopover();
    assert.equal(second, 1);
  } finally {
    uninstallFakeDom();
  }
});

test('openPanel repositions on resize and drops listeners on close', async () => {
  installFakeDom({ width: 400, height: 560 });
  try {
    const pop = await import('../src/renderer/popover.js');
    const anchor = fakeNode({ width: 40, height: 30 });
    anchor.getBoundingClientRect = () => ({ right: 1240, bottom: 100, top: 60 });
    const node = fakeNode({ width: 400, height: 300 });
    pop.openPanel(anchor, node, {});
    assert.equal(globalThis.window._listeners.resize?.length, 1);
    assert.equal(globalThis.document._listeners.mousedown?.length, 1);
    // Shrink the window: the resize listener clamps the open node back in.
    globalThis.window.innerHeight = 400;
    for (const fn of [...globalThis.window._listeners.resize]) fn();
    assert.equal(node.style.top, '92px', 'clamped to fit the shorter viewport');
    assert.ok(Number.parseFloat(node.style.top) + 300 <= 400 - POPOVER_MARGIN);
    pop.closePopover();
    assert.equal(globalThis.window._listeners.resize?.length || 0, 0);
    assert.equal(globalThis.document._listeners.mousedown?.length || 0, 0);
    assert.equal(globalThis.document._listeners.keydown?.length || 0, 0);
  } finally {
    uninstallFakeDom();
  }
});

test('openMenu marks explicit checked options as menuitemradio with boolean aria-checked', async () => {
  installFakeDom({ width: 280, height: 200 });
  try {
    const pop = await import('../src/renderer/popover.js');
    const anchor = fakeNode({ width: 40, height: 30 });
    const menu = pop.openMenu(anchor, [
      { label: 'Moonlight', icon: 'moon', checked: true, action: () => {} },
      { label: 'Daylight', icon: 'sun', checked: false, action: () => {} },
      { label: 'Delete', danger: true, action: () => {} },
    ]);
    const [on, off, act] = menu.children;
    assert.equal(on.attrs.role, 'menuitemradio');
    assert.equal(on.attrs['aria-checked'], 'true');
    assert.equal(off.attrs.role, 'menuitemradio');
    assert.equal(off.attrs['aria-checked'], 'false');
    assert.equal(act.attrs.role, 'menuitem');
    assert.equal(act.attrs['aria-checked'], undefined, 'plain actions carry no tri-state');
    assert.equal(on.children.length, 3, 'icon + label + trailing check vector');
    assert.equal(act.children.length, 2, 'icon slot + label, no mark');
    pop.closePopover();
  } finally {
    uninstallFakeDom();
  }
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
console.log(`popover: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
