#!/usr/bin/env node
// Question form DOM behavior: real click sequences through buildQuestionForm
// against a minimal fake document (no browser, no jsdom — the builders only
// need elements, listeners and simple selectors).
//
// The P1 this guards: multi-select handlers derived each update from a set
// captured once at build, so click-x-then-y showed [x, y] checked while the
// POST carried only [y]. These tests drive change/input events like the
// browser would and assert draft + DOM + collected POST together, plus
// Other mutual exclusion in both directions and reopen fidelity.

import assert from 'node:assert/strict';

// ------------------------------------------------------- minimal fake DOM
class FakeNode {
  constructor(tag) {
    this.nodeType = tag === '#fragment' ? 11 : tag === '#text' ? 3 : 1;
    this.tagName = this.nodeType === 1 ? String(tag).toUpperCase() : null;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this._listeners = {};
    this._text = '';
    this.className = '';
    // Form state the builders read/write.
    this.value = '';
    this.checked = false;
    this.type = '';
    this.name = '';
    this.disabled = false;
    this.hidden = false;
  }
  get firstElementChild() {
    return this.children.find((c) => c.nodeType === 1) || null;
  }
  get textContent() {
    if (this.nodeType === 3) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  set innerHTML(v) {
    this._text = String(v); // no markup parsing — builders never read it back
    this.children = [];
  }
  get innerHTML() { return this._text; }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
    return this;
  }
  appendChild(n) {
    if (n && n.nodeType === 11) {
      for (const c of [...n.children]) this.appendChild(c);
      n.children = [];
      return n;
    }
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  prepend(...nodes) {
    const flat = [];
    for (const n of nodes) {
      if (n && n.nodeType === 11) flat.push(...n.children.splice(0));
      else flat.push(n);
    }
    for (const n of flat) n.parentNode = this;
    this.children.unshift(...flat);
    return this;
  }
  replaceChildren(...nodes) {
    this.children = [];
    if (nodes.length) this.append(...nodes);
  }
  setAttribute(k, v) { this.attributes[String(k)] = String(v); }
  getAttribute(k) { return this.attributes[String(k)] ?? null; }
  addEventListener(type, fn, opts = {}) {
    (this._listeners[type] ||= []).push({ fn, once: !!opts?.once });
  }
  /** Test driver: run the listeners the browser would run for this event. */
  _fire(type) {
    const list = this._listeners[type] || [];
    this._listeners[type] = list.filter((l) => !l.once);
    for (const l of list) l.fn({ type, target: this });
  }
  _match(part) {
    if (this.nodeType !== 1) return false;
    const m = part.match(/^([a-zA-Z][a-zA-Z0-9]*)?((?:\.[a-zA-Z0-9_-]+)*)(?:\[([a-zA-Z0-9_-]+)="([^"]*)"\])?$/);
    if (!m) return false;
    const [, tag, classes, attr, attrVal] = m;
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    const have = this.className.split(/\s+/).filter(Boolean);
    for (const c of (classes || '').split('.').filter(Boolean)) {
      if (!have.includes(c)) return false;
    }
    if (attr) {
      const v = attr === 'value' ? this.value : this.getAttribute(attr);
      if (String(v ?? '') !== attrVal) return false;
    }
    return true;
  }
  querySelectorAll(sel) {
    const parts = String(sel).split(/\s+/).filter(Boolean);
    let frontier = [this];
    for (const part of parts) {
      const next = [];
      for (const root of frontier) {
        const walk = (n) => {
          for (const c of n.children || []) {
            if (c._match?.(part)) next.push(c);
            walk(c);
          }
        };
        walk(root);
      }
      frontier = next;
    }
    return frontier;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}

function installFakeDocument() {
  const doc = {
    activeElement: null,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => {
      const n = new FakeNode('#text');
      n._text = String(text);
      return n;
    },
    createDocumentFragment: () => new FakeNode('#fragment'),
  };
  globalThis.document = doc;
  return doc;
}

installFakeDocument();
const { buildQuestionForm, draftToAnswers } = await import('../src/renderer/question-inbox.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const MULTI_IX = {
  id: 'ix-m',
  subtype: 'ask',
  questions: [{
    id: 'm', header: 'Flags', question: 'Pick flags', mode: 'multiple',
    minSelections: 1, maxSelections: 2, freeText: false,
    options: [{ label: 'x', description: '' }, { label: 'y', description: '' }],
  }],
};

function drive(ix, initial = {}) {
  const values = JSON.parse(JSON.stringify(initial));
  const engaged = [];
  const cbs = {
    onDraft: (ixId, qid, patch) => {
      values[qid] = { ...(values[qid] || {}), ...patch };
    },
    onEngage: (ixId) => engaged.push(ixId),
    onSubmit: () => {},
    onCancel: () => {},
  };
  const form = buildQuestionForm(ix, values, null, cbs);
  const inputs = () => form.querySelectorAll('input');
  const byValue = (v) => inputs().find((i) => i.value === v);
  return {
    form, values, engaged, inputs, byValue,
    check: (v) => {
      const el = byValue(v);
      el.checked = true;
      el._fire('change');
      return el;
    },
    uncheck: (v) => {
      const el = byValue(v);
      el.checked = false;
      el._fire('change');
      return el;
    },
    typeOther: (text) => {
      const ta = form.querySelector('textarea.qform-other-text');
      ta.value = text;
      ta._fire('input');
      return ta;
    },
    post: () => draftToAnswers(ix.questions, values),
  };
}

test('multi clicks accumulate: x then y drafts [x, y], DOM and POST agree', () => {
  const d = drive(MULTI_IX);
  d.check('x');
  assert.deepEqual(d.values.m.selectedLabels, ['x']);
  d.check('y');
  assert.deepEqual(d.values.m.selectedLabels, ['x', 'y'], 'second click must accumulate, not replace');
  assert.deepEqual(d.inputs().filter((i) => i.checked).map((i) => i.value).sort(), ['x', 'y']);
  const post = d.post();
  assert.equal(post.ok, true);
  assert.deepEqual(post.answers, [{ questionId: 'm', selectedLabels: ['x', 'y'] }]);
});

test('multi uncheck removes one pick; draft, DOM and POST stay in sync', () => {
  const d = drive(MULTI_IX);
  d.check('x');
  d.check('y');
  d.uncheck('x');
  assert.deepEqual(d.values.m.selectedLabels, ['y']);
  assert.equal(d.byValue('x').checked, false);
  assert.equal(d.byValue('y').checked, true);
  assert.deepEqual(d.post().answers[0].selectedLabels, ['y']);
});

test('Other unchecks options (state + DOM); a later pick unchecks Other', () => {
  const d = drive(MULTI_IX);
  d.check('x');
  d.check('y');
  d.check('__other__');
  assert.equal(d.values.m.other, true);
  assert.deepEqual(d.values.m.selectedLabels, [], 'Other clears the picks in the draft');
  assert.equal(d.byValue('x').checked, false, 'Other must uncheck the option inputs');
  assert.equal(d.byValue('y').checked, false);
  assert.equal(d.byValue('__other__').checked, true);
  d.typeOther('zed');
  assert.equal(d.values.m.freeText, 'zed');
  const post = d.post();
  assert.equal(post.ok, true);
  assert.deepEqual(post.answers, [{ questionId: 'm', freeText: 'zed' }]);
  // Vice versa: picking an option un-selects Other, DOM included.
  d.check('x');
  assert.equal(d.values.m.other, false);
  assert.equal(d.byValue('__other__').checked, false);
  assert.deepEqual(d.values.m.selectedLabels, ['x']);
  assert.deepEqual(d.post().answers[0].selectedLabels, ['x']);
});

test('typing in Other selects it and clears option DOM without losing the text', () => {
  const d = drive(MULTI_IX);
  d.check('x');
  d.typeOther('custom answer');
  assert.equal(d.byValue('__other__').checked, true, 'typing auto-selects Other');
  assert.equal(d.byValue('x').checked, false);
  assert.deepEqual(d.values.m.selectedLabels, []);
  const ta = d.form.querySelector('textarea.qform-other-text');
  assert.equal(ta.value, 'custom answer', 'the typed text survives (no rebuild on input)');
});

test('reopen renders the saved draft: picks checked, Other exclusive', () => {
  const d = drive(MULTI_IX, { m: { selectedLabels: ['y'], other: false } });
  assert.equal(d.byValue('y').checked, true);
  assert.equal(d.byValue('x').checked, false);
  assert.equal(d.byValue('__other__').checked, false);
  const d2 = drive(MULTI_IX, { m: { selectedLabels: ['x'], other: true, freeText: 'z' } });
  assert.equal(d2.byValue('__other__').checked, true);
  assert.equal(d2.byValue('x').checked, false, 'an Other draft must not render options checked');
  assert.equal(d2.form.querySelector('textarea.qform-other-text').value, 'z');
});

test('single-select mutually excludes the Other row both ways', () => {
  const ix = {
    id: 'ix-s', subtype: 'ask',
    questions: [{
      id: 's', header: 'DB', question: 'Pick one', mode: 'single', freeText: false,
      options: [{ label: 'a', description: '' }, { label: 'b', description: '' }],
    }],
  };
  const d = drive(ix);
  d.check('a');
  assert.equal(d.values.s.selectedLabel, 'a');
  d.check('__other__');
  d.typeOther('mine');
  assert.deepEqual(d.post().answers, [{ questionId: 's', freeText: 'mine' }]);
  d.check('b'); // the pick handler explicitly unchecks Other (the fake has no native radio groups)
  assert.equal(d.values.s.other, false);
  assert.equal(d.byValue('__other__').checked, false);
  assert.deepEqual(d.post().answers, [{ questionId: 's', selectedLabel: 'b' }]);
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
console.log(`question-dom: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
