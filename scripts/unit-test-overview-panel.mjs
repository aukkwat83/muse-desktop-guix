#!/usr/bin/env node
// Overview popup: live sections, drill navigation, and state preservation
// against a minimal fake DOM (the panel module has no top-level DOM touch,
// so it imports cleanly; the fake covers exactly the selectors it uses).
//
// Covers: open/toggle/replacement lifecycle, same-chat rebind preserving
// the drill, status-transition reloads (incl. repeated resume), workflow
// rec refresh, focus/fold/scroll/draft preservation across renders,
// in-place delta patching, session-title headings, and the poll matrix.

import assert from 'node:assert/strict';

// ------------------------------------------------------------ fake DOM
function makeDom(box = { width: 480, height: 560 }) {
  const docListeners = {};
  const winListeners = {};
  const doc = { activeEl: null };

  function parseCompound(part) {
    const tag = (/^[a-zA-Z][a-zA-Z0-9]*/.exec(part) || [])[0] || null;
    const classes = [...part.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    const attrs = [...part.matchAll(/\[([^\]=]+)(?:="((?:[^"\\]|\\.)*)")?\]/g)]
      .map((m) => [m[1], m[2] == null ? null : m[2].replace(/\\"/g, '"')]);
    return { tag, classes, attrs };
  }

  function matches(el, part) {
    const { tag, classes, attrs } = parseCompound(part);
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    for (const c of classes) {
      if (!el._classes.has(c)) return false;
    }
    for (const [k, v] of attrs) {
      const got = el.getAttribute(k);
      if (v == null) {
        if (got == null) return false;
      } else if (got !== v) return false;
    }
    return true;
  }

  function findAll(root, sel, out) {
    // One descendant level is all the panel uses ('A B').
    const parts = sel.split(' ').filter(Boolean);
    const walk = (el, depth) => {
      for (const c of el.children) {
        if (depth === parts.length - 1) {
          if (matches(c, parts[depth])) out.push(c);
          walk(c, depth); // deeper matches of the final part still count
        } else if (matches(c, parts[depth])) {
          walk(c, depth + 1);
        } else {
          walk(c, depth);
        }
      }
    };
    walk(root, 0);
    return out;
  }

  class FakeEl {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parent = null;
      this.dataset = {};
      this.attrs = {};
      this.style = {};
      this.textContent = '';
      this.title = '';
      this.scrollTop = 0;
      this.value = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.selectionDirection = 'none';
      this.open = false;
      this.removed = false;
      this._classes = new Set();
      this._listeners = {};
    }
    get className() { return [...this._classes].join(' '); }
    set className(v) { this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
    get classList() {
      const self = this;
      return {
        add: (...cs) => { for (const c of cs) self._classes.add(c); },
        contains: (c) => self._classes.has(c),
      };
    }
    get isConnected() {
      let n = this;
      while (n) {
        if (n === doc.body) return true;
        n = n.parent;
      }
      return false;
    }
    getAttribute(name) {
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return this.dataset[key] ?? null;
      }
      return this.attrs[name] ?? null;
    }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    append(...nodes) {
      for (const n of nodes) {
        if (typeof n === 'string') { this.textContent += n; continue; }
        n.parent = this;
        this.children.push(n);
      }
      return this.children[this.children.length - 1];
    }
    appendChild(node) {
      this.append(node);
      return node;
    }
    prepend(node) {
      node.parent = this;
      this.children.unshift(node);
    }
    replaceChildren(...nodes) {
      for (const c of this.children) c.parent = null;
      this.children = [];
      if (nodes.length) this.append(...nodes);
    }
    remove() {
      this.removed = true;
      if (this.parent) {
        this.parent.children = this.parent.children.filter((c) => c !== this);
        this.parent = null;
      }
    }
    contains(node) {
      let n = node;
      while (n) {
        if (n === this) return true;
        n = n.parent;
      }
      return false;
    }
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
    focus() { doc.activeEl = this; }
    setSelectionRange(s, e, d) {
      this.selectionStart = s;
      this.selectionEnd = e;
      if (d) this.selectionDirection = d;
    }
    getBoundingClientRect() { return { ...box }; }
    querySelector(sel) { return findAll(this, sel, [])[0] || null; }
    querySelectorAll(sel) { return findAll(this, sel, []); }
  }

  const document = {
    body: null,
    createElement: (tag) => new FakeEl(tag),
    get activeElement() { return doc.activeEl; },
    addEventListener: (t, f) => { (docListeners[t] ||= []).push(f); },
    removeEventListener: (t, f) => { docListeners[t] = (docListeners[t] || []).filter((g) => g !== f); },
    _listeners: docListeners,
  };
  document.body = new FakeEl('body');
  // Widen body matching: selectors never target it, containment only.
  const window = {
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener: (t, f) => { (winListeners[t] ||= []).push(f); },
    removeEventListener: (t, f) => { winListeners[t] = (winListeners[t] || []).filter((g) => g !== f); },
    _listeners: winListeners,
  };
  return { document, window, FakeEl };
}

function install(dom) {
  globalThis.document = dom.document;
  globalThis.window = dom.window;
}

function uninstall() {
  delete globalThis.document;
  delete globalThis.window;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function kid(over = {}) {
  return {
    itemId: 'sub-1', kind: 'subagent', status: 'inProgress', subagentId: 'sub-a',
    agentPath: 'researcher', role: 'research', objective: 'research caches',
    depth: 1, controlStatus: 'running', childSessionId: 'child-1',
    updatedAt: 1000, ...over,
  };
}

function plan8() {
  const entries = [];
  for (let i = 0; i < 8; i++) {
    entries.push({ content: `task-${i}`, status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending' });
  }
  return entries;
}

function snap(over = {}) {
  return {
    chatTitle: 'chat-a',
    goal: { objective: 'ship', percentComplete: 10, status: 'running', currentWork: 'w', nextWork: 'n' },
    goalCold: false,
    plan: plan8(),
    toolRows: [],
    agents: new Map([['sub-1', kid()]]),
    ...over,
  };
}

function anchor(dom, rect = { right: 1200, bottom: 60, top: 20 }) {
  const a = dom.document.createElement('button');
  a.getBoundingClientRect = () => ({ ...rect });
  return a;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('open paints sections; second open toggles closed with cleanup', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    const panel = createOverviewPanel({ api: async () => { throw new Error('no fetch on open'); } });
    try {
      panel.open(anchor(dom), 'chat-a', snap());
      assert.equal(panel.isOpen(), true);
      assert.equal(panel.openChat(), 'chat-a');
      const root = dom.document.body.children[0];
      const heads = root.querySelectorAll('.panel-sect').map((n) => n.textContent);
      assert.ok(heads.some((h) => h.startsWith('goal')), `goal section painted: ${heads}`);
      assert.ok(heads.some((h) => h.startsWith('tasks')), `tasks section painted: ${heads}`);
      assert.ok(heads.some((h) => h.startsWith('subagents')), `subagents section painted: ${heads}`);
      assert.ok(root.style.left, 'placed with a real box');
      panel.open(anchor(dom), 'chat-a', snap());
      assert.equal(panel.isOpen(), false, 'second open toggles closed');
      assert.equal(panel.openChat(), null, 'onClose reset the binding');
      assert.equal(dom.document.body.children.length, 0);
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('open for another chat replaces with cleanup (no orphan timers/state)', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    let reads = 0;
    const panel = createOverviewPanel({
      api: async () => {
        reads += 1;
        return { mode: 'inline', session: { status: 'running' }, items: [], droppedFromHead: 0 };
      },
    });
    try {
      panel.openDrill(anchor(dom), 'chat-a', 'sub-1', snap());
      await flush();
      const first = dom.document.body.children[0];
      assert.ok(first.querySelector('.agent-drill-title'), 'drilled view painted');
      panel.open(anchor(dom), 'chat-b', snap({ chatTitle: 'chat-b', agents: new Map() }));
      assert.equal(panel.openChat(), 'chat-b');
      assert.equal(first.removed, true, 'previous root removed');
      assert.equal(dom.document.body.children.length, 1, 'exactly one popover survives');
      assert.equal(dom.document.body.children[0].querySelector('.agent-drill-title'), null);
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('same-chat rebind preserves the drill; other-chat rebind resets', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    const panel = createOverviewPanel({
      api: async () => ({ mode: 'inline', session: { status: 'running' }, items: [], droppedFromHead: 0 }),
    });
    try {
      panel.openDrill(anchor(dom), 'chat-a', 'sub-1', snap());
      await flush();
      await flush();
      const root = () => dom.document.body.children[0];
      assert.ok(root().querySelector('.agent-drill-title'), 'drill painted');
      panel.rebind('chat-a', snap({ plan: [{ content: 'fresh', status: 'pending' }] }));
      assert.ok(root().querySelector('.agent-drill-title'), 'same-chat rebind keeps the drill');
      panel.rebind('chat-b', snap({ chatTitle: 'chat-b' }));
      assert.equal(root().querySelector('.agent-drill-title'), null, 'chat switch drops the drill');
      assert.ok(root().querySelector('.panel-sect'), 'sections painted for the new chat');
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('status transitions reload the drill (incl. repeated resume), chrome otherwise', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    let reads = 0;
    const panel = createOverviewPanel({
      api: async () => {
        reads += 1;
        return { mode: 'inline', session: { status: 'running' }, items: [], droppedFromHead: 0 };
      },
    });
    try {
      panel.openDrill(anchor(dom), 'chat-a', 'sub-1', snap());
      await flush();
      await flush();
      assert.equal(reads, 1, 'initial drill read');
      const pill = () => dom.document.body.children[0].querySelector('[data-role="ov-status"]').textContent;
      assert.equal(pill(), 'กำลังรัน');
      // Same status, new live text: chrome sync only, no refetch.
      panel.applyAgents('chat-a', new Map([['sub-1', kid({ liveText: 'working' })]]));
      assert.equal(reads, 1, 'no refetch without a transition');
      // Landed: quiet reload to pick up terminal items.
      panel.applyAgents('chat-a', new Map([['sub-1', kid({ status: 'completed', controlStatus: 'done' })]]));
      await flush();
      await flush();
      assert.equal(reads, 2, 'transition triggers a quiet reload');
      assert.equal(pill(), 'เสร็จ');
      // Resumed: reload again — the poll re-arms off the fresh drill.
      panel.applyAgents('chat-a', new Map([['sub-1', kid({ status: 'inProgress', controlStatus: 'running' })]]));
      await flush();
      await flush();
      assert.equal(reads, 3, 'repeated resume reloads again');
      assert.equal(pill(), 'กำลังรัน');
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('workflow frame refreshes its captured rec on registry updates', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    const panel = createOverviewPanel({ api: async () => { throw new Error('workflow needs no read'); } });
    try {
      const wf = (label) => ({
        itemId: 'wf-1', kind: 'workflow', status: 'inProgress', updatedAt: 5,
        children: [{ childId: 'c1', label, status: 'running' }],
      });
      panel.open(anchor(dom), 'chat-a', snap({ agents: new Map([['wf-1', wf('step-one')]]) }));
      const root = () => dom.document.body.children[0];
      const row = root().querySelector('[data-focus-key="child:wf-1"]');
      assert.ok(row, 'workflow row painted');
      row._listeners.click[0](); // push the workflow frame
      assert.ok(root().querySelector('.agent-drill-title'), 'workflow drill painted');
      panel.applyAgents('chat-a', new Map([['wf-1', wf('step-two')]]));
      const names = root().querySelectorAll('.mcp-name').map((n) => n.textContent);
      assert.ok(names.includes('step-two'), `captured rec refreshed: ${names}`);
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('render preserves focus, folds, scroll, and send draft + caret', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    const panel = createOverviewPanel({
      api: async () => ({ mode: 'inline', session: { status: 'running' }, items: [], droppedFromHead: 0 }),
    });
    try {
      panel.openDrill(anchor(dom), 'chat-a', 'sub-1', snap());
      await flush();
      await flush();
      const root = () => dom.document.body.children[0];
      // Open the send form, type, and place the caret mid-text.
      root().querySelector('[data-focus-key="act:send"]')?._listeners.click[0]();
      const input = root().querySelector('.agent-send-input');
      assert.ok(input, 'send form painted');
      input.value = 'hello child';
      input.setSelectionRange(5, 5, 'forward');
      input.focus();
      root().querySelector('[data-role="ov-body"]').scrollTop = 42;
      panel.rebind('chat-a', snap()); // loud render on the same chat
      const input2 = root().querySelector('.agent-send-input');
      assert.ok(input2, 'send form survives the render');
      assert.equal(input2.value, 'hello child', 'draft preserved');
      assert.deepEqual([input2.selectionStart, input2.selectionEnd], [5, 5], 'caret preserved');
      assert.equal(dom.document.activeElement, input2, 'focus returns to the input');
      assert.equal(root().querySelector('[data-role="ov-body"]').scrollTop, 42, 'scroll preserved');
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('task folds and row focus survive a sections re-render', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    const panel = createOverviewPanel({ api: async () => ({}) });
    try {
      panel.open(anchor(dom), 'chat-a', snap());
      const root = () => dom.document.body.children[0];
      const fold = root().querySelector('details[data-fold-key="tasks:preceding"]');
      assert.ok(fold, 'preceding fold painted for 8 tasks');
      fold.open = true;
      root().querySelector('[data-focus-key="child:sub-1"]').focus();
      panel.applyPlan('chat-a', plan8()); // loud sections re-render
      assert.equal(
        root().querySelector('details[data-fold-key="tasks:preceding"]').open,
        true,
        'expanded fold stays open',
      );
      assert.equal(
        dom.document.activeElement,
        root().querySelector('[data-focus-key="child:sub-1"]'),
        'row focus restored by key',
      );
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('deltas patch list rows and the open drill in place', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    const panel = createOverviewPanel({
      api: async () => ({ mode: 'inline', session: { status: 'running' }, items: [], droppedFromHead: 0 }),
    });
    try {
      panel.open(anchor(dom), 'chat-a', snap());
      const root = () => dom.document.body.children[0];
      panel.applyAgentDelta('chat-a', 'sub-1', 'streaming work');
      const live = root().querySelector('[data-role="ov-live"]');
      assert.ok(live, 'live line mounted on the list row');
      assert.equal(live.textContent, 'streaming work');
      panel.openDrill(anchor(dom), 'chat-a', 'sub-1', snap());
      await flush();
      await flush();
      panel.applyAgentDelta('chat-a', 'sub-1', 'drill streaming');
      const box = root().querySelector('[data-role="ov-drill-live"] .drill-text');
      assert.ok(box, 'drill live box painted');
      assert.equal(box.textContent, 'drill streaming');
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('drill heading adopts the trusted session title; provenance stays Thai', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    const panel = createOverviewPanel({
      api: async () => ({
        mode: 'inline',
        session: { status: 'running', title: 'What the child actually did' },
        items: [],
        droppedFromHead: 0,
      }),
    });
    try {
      const rec = kid({ kind: 'reminderChild', role: null, agentPath: null, objective: null, reminderAgentId: null, entryId: null, fallbackText: 'Reminder child session' });
      panel.openDrill(anchor(dom), 'chat-a', 'sub-1', snap({ agents: new Map([['sub-1', rec]]) }));
      await flush();
      await flush();
      const root = dom.document.body.children[0];
      assert.equal(
        root.querySelector('.agent-drill-title').textContent,
        'What the child actually did',
        'session title replaces the generic reminder heading',
      );
      const tags = root.querySelectorAll('.kind-tag').map((n) => n.textContent);
      assert.ok(tags.includes('งานระบบ'), `Thai provenance tag present: ${tags}`);
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('native active run reads running for status even with a stale record', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    const panel = createOverviewPanel({
      api: async () => ({
        mode: 'native-log',
        nativeRun: { state: 'running', terminal: null },
        session: null,
        items: [],
        droppedFromHead: 0,
      }),
    });
    try {
      const rec = kid({ kind: 'native', status: 'completed', controlStatus: 'done' });
      panel.openDrill(anchor(dom), 'chat-a', 'sub-1', snap({ agents: new Map([['sub-1', rec]]) }));
      await flush();
      await flush();
      const pill = dom.document.body.children[0].querySelector('[data-role="ov-status"]');
      assert.equal(pill.textContent, 'กำลังรัน', 'transcript liveness overrides the stale record');
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('native terminal run determines the heading, not the fossil record', async () => {
  const dom = makeDom();
  install(dom);
  try {
    const { createOverviewPanel } = await import('../src/renderer/overview-panel.js');
    const panel = createOverviewPanel({
      api: async () => ({
        mode: 'native-log',
        nativeRun: { state: 'terminal', terminal: 'completed' },
        session: null,
        items: [{ kind: 'terminal', status: 'completed', text: 'run completed' }],
        droppedFromHead: 0,
      }),
    });
    try {
      // The registry still says inProgress (no transition relayed yet) but
      // the log's latest run completed — the heading must say so, not spin
      // กำลังรัน forever over a body that says the run completed.
      const rec = kid({ kind: 'native', status: 'inProgress', controlStatus: null });
      panel.openDrill(anchor(dom), 'chat-a', 'sub-1', snap({ agents: new Map([['sub-1', rec]]) }));
      await flush();
      await flush();
      const pill = dom.document.body.children[0].querySelector('[data-role="ov-status"]');
      assert.equal(pill.textContent, 'เสร็จ', 'terminal outcome overrides the stale record');
    } finally {
      panel.close();
    }
  } finally {
    uninstall();
  }
});

test('nativeRunStatus resolves the latest run in both directions', async () => {
  const { nativeRunStatus } = await import('../src/renderer/rightbar.js');
  assert.equal(nativeRunStatus(null), null);
  assert.equal(nativeRunStatus(undefined), null);
  assert.equal(nativeRunStatus('running'), null);
  assert.equal(nativeRunStatus({ state: 'running', terminal: null }), 'inProgress');
  assert.equal(nativeRunStatus({ state: 'terminal', terminal: 'completed' }), 'completed');
  assert.equal(nativeRunStatus({ state: 'terminal', terminal: 'failed' }), 'failed');
  assert.equal(nativeRunStatus({ state: 'terminal', terminal: 'cancelled' }), 'cancelled');
  assert.equal(
    nativeRunStatus({ state: 'terminal', terminal: 'weird-future' }),
    'weird-future',
    'unknown outcomes pass through, never mislabelled completed',
  );
  assert.equal(nativeRunStatus({ state: 'terminal' }), 'completed');
  assert.equal(nativeRunStatus({ state: 'something-else' }), null);
});

test('drillShouldPoll keeps active native runs, stops landed drills', async () => {
  const { drillShouldPoll } = await import('../src/renderer/overview-panel.js');
  assert.equal(drillShouldPoll(null), false);
  assert.equal(drillShouldPoll({ type: 'workflow', drill: null }, 'inProgress'), false);
  assert.equal(drillShouldPoll({ type: 'item', error: 'x', drill: null }, 'inProgress'), false);
  assert.equal(drillShouldPoll({ type: 'item', drill: null }, ''), true, 'first read races the spawn');
  const landed = { type: 'item', drill: { items: [{ status: 'completed' }], session: { status: 'idle' } } };
  assert.equal(drillShouldPoll(landed, 'completed'), false, 'landed drill stops');
  assert.equal(drillShouldPoll(landed, 'inProgress'), true, 'running record keeps polling');
  const noTools = {
    type: 'item',
    drill: { items: [], session: null, nativeRun: { state: 'running', terminal: null } },
  };
  assert.equal(drillShouldPoll(noTools, 'completed'), true, 'active run without tools still polls');
  const termRun = {
    type: 'item',
    drill: { items: [], session: null, nativeRun: { state: 'terminal', terminal: 'completed' } },
  };
  assert.equal(drillShouldPoll(termRun, 'completed'), false, 'terminal run stops');
  assert.equal(
    drillShouldPoll(termRun, 'inProgress'),
    true,
    'terminal run + running record keeps a bounded refresh to discover a resumed run',
  );
  const termFail = {
    type: 'item',
    drill: { items: [], session: null, nativeRun: { state: 'terminal', terminal: 'failed' } },
  };
  assert.equal(drillShouldPoll(termFail, 'completed'), false, 'failed run stops when nothing claims liveness');
  const liveItem = { type: 'item', drill: { items: [{ status: 'inProgress' }] } };
  assert.equal(drillShouldPoll(liveItem, 'completed'), true, 'live items keep polling');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n       ') : err}`);
  }
}
const ran = tests.length - failed;
console.log(`overview-panel: ${ran}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
