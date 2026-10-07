#!/usr/bin/env node
// Renderer contract guards (src/renderer/*.js).
//
// The rule these tests protect: the renderer has no bundler and no linter,
// so a misspelled helper or a stale import blank-screens the app at load
// (v1.1.26 shipped `agentToolMeta(subKindOf(t))` with no `subKindOf`
// anywhere — every transcript with tool history painted
// "Can't find variable: subKindOf"). Three static checks plus the helper
// shapes the overview/history code relies on:
//
//   1. no-undef: every bare `name(` callee resolves to an import, a
//      definition, or a known platform global.
//   2. imports resolve: every named import exists in the source module.
//   3. helper shapes: agentToolMeta/toolDisplayState/agentSubtitle keep
//      the contracts app.js consumes (tool in, no label/icon keys,
//      display state is a string).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentToolMeta, agentSubtitle, toolDisplayState } from '../src/renderer/turn-view.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(ROOT, '..', 'src', 'renderer');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Strip comments + string literals but KEEP ${...} expressions inside
// template literals (they are code). Returns code with inert spans
// blanked to spaces so line/column positions survive.
function blankInert(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let i = a; i < b; i++) if (out[i] !== '\n') out[i] = ' '; };
  let i = 0;
  const n = src.length;
  const pushCode = () => {};
  // stack of template-literal ${} depths; plain code is depth 0
  const tmpl = [];
  let mode = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; blank(i, i + 2); i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; blank(i, i + 2); i += 2; continue; }
      if (c === '/' && isRegexStart(src, i)) { i = blankRegex(src, out, blank, i); continue; }
      if (c === "'") { mode = 'sq'; blank(i, i + 1); i += 1; continue; }
      if (c === '"') { mode = 'dq'; blank(i, i + 1); i += 1; continue; }
      if (c === '`') { mode = 'tpl'; tmpl.push(0); blank(i, i + 1); i += 1; continue; }
      if (c === '}' && tmpl.length && tmpl[tmpl.length - 1] > 0) {
        tmpl[tmpl.length - 1] -= 1;
        if (tmpl[tmpl.length - 1] === 0) mode = 'tpl';
        i += 1; continue;
      }
      i += 1; continue;
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; else blank(i, i + 1); i += 1; continue; }
    if (mode === 'block') {
      if (c === '*' && d === '/') { blank(i, i + 2); i += 2; mode = 'code'; continue; }
      blank(i, i + 1); i += 1; continue;
    }
    if (mode === 'sq' || mode === 'dq') {
      const q = mode === 'sq' ? "'" : '"';
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === q) { blank(i, i + 1); i += 1; mode = 'code'; continue; }
      if (c === '\n') { i += 1; continue; } // unterminated; bail to code
      blank(i, i + 1); i += 1; continue;
    }
    // tpl: literal text is inert, ${...} is code
    if (c === '\\') { blank(i, i + 2); i += 2; continue; }
    if (c === '`' && tmpl[tmpl.length - 1] === 0) { tmpl.pop(); blank(i, i + 1); i += 1; mode = 'code'; continue; }
    if (c === '$' && d === '{') { tmpl[tmpl.length - 1] += 1; i += 2; mode = 'code'; continue; }
    blank(i, i + 1); i += 1;
  }
  void pushCode;
  return out.join('');
}

const IDENT = '[A-Za-z_$][\\w$]*';

// A `/` opens a regex literal (not division) when the previous significant
// character cannot end an expression — the standard heuristic. Without it a
// pattern like /^["']|["']$/g flips the scanner into string mode and eats
// every declaration after it.
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j -= 1;
  if (j < 0) return true;
  const c = src[j];
  if ('(,=:[!&|?{};'.includes(c)) return true;
  const kw = src.slice(Math.max(0, j - 10), j + 1).match(/(return|typeof|case|do|else|in|of|yield|await|delete|void|instanceof|new)$/);
  return !!kw;
}

// Blank a regex literal starting at src[i] === '/'; returns the index just
// past the flags. Handles escapes and [...] classes (where '/' is literal).
function blankRegex(src, out, blank, i) {
  const n = src.length;
  blank(i, i + 1);
  i += 1;
  let inClass = false;
  while (i < n) {
    const c = src[i];
    if (c === '\\') { blank(i, i + 2); i += 2; continue; }
    if (c === '\n') return i; // not a regex after all; bail to code
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      blank(i, i + 1);
      i += 1;
      while (i < n && /[a-z]/i.test(src[i])) { blank(i, i + 1); i += 1; }
      return i;
    }
    blank(i, i + 1);
    i += 1;
  }
  return i;
}

function definedNames(code) {
  const defs = new Set();
  const addIdents = (s) => { for (const m of s.matchAll(new RegExp(IDENT, 'g'))) defs.add(m[0]); };
  // imports
  for (const m of code.matchAll(/import\s+(?:(\w+)\s*,\s*)?(?:\*\s*as\s+(\w+)|{([^}]*)})?\s*from\b/g)) {
    if (m[1]) defs.add(m[1]);
    if (m[2]) defs.add(m[2]);
    if (m[3]) for (const part of m[3].split(',')) {
      const mm = part.trim().match(new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`));
      if (mm) defs.add(mm[2] || mm[1]);
    }
  }
  for (const m of code.matchAll(new RegExp(`function\\s+(${IDENT})`, 'g'))) defs.add(m[1]);
  for (const m of code.matchAll(new RegExp(`class\\s+(${IDENT})`, 'g'))) defs.add(m[1]);
  for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s+(${IDENT})`, 'g'))) defs.add(m[1]);
  // destructuring: every identifier in the pattern counts (safe direction)
  for (const m of code.matchAll(/(?:const|let|var)\s*[{[]([^;{}[\]]*)[}\]]/g)) addIdents(m[1]);
  for (const m of code.matchAll(new RegExp(`catch\\s*\\(\\s*(${IDENT})`, 'g'))) defs.add(m[1]);
  // params: function f(a, b) + arrows (a, b) => / x =>
  for (const m of code.matchAll(/function\s*(?:\w+\s*)?\(([^()]*)\)/g)) addIdents(m[1]);
  for (const m of code.matchAll(new RegExp(`(\\([^()]*\\)|${IDENT})\\s*=>`, 'g'))) addIdents(m[1]);
  return defs;
}

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'import', 'export', 'new', 'delete', 'void', 'in', 'of', 'do', 'else',
]);

// Platform globals the renderer legitimately calls bare. Deliberately
// explicit: anything NOT here and NOT defined/imported fails the test.
const GLOBALS = new Set([
  'document', 'window', 'navigator', 'location', 'history', 'screen',
  'fetch', 'Headers', 'Request', 'Response', 'EventSource', 'WebSocket',
  'Worker', 'Audio', 'Image', 'localStorage', 'sessionStorage',
  'console', 'alert', 'confirm', 'prompt',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
  'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData',
  'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'KeyboardEvent',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
  'DOMParser', 'XMLSerializer', 'TextEncoder', 'TextDecoder',
  'getComputedStyle', 'matchMedia', 'crypto', 'performance',
  'structuredClone', 'btoa', 'atob',
  'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
  'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'globalThis', 'self', 'top', 'parent', 'frames', 'super',
  'mermaid', // vendor bundle, loaded via <script> before app modules
  'Notification', 'Uint8Array', 'unescape', // verified bare uses in app/markdown
]);

function calledNames(code) {
  const found = [];
  const re = new RegExp(`(?<![\\w$.])(${IDENT})(\\s*)\\(`, 'g');
  let m;
  while ((m = re.exec(code))) {
    if (KEYWORDS.has(m[1])) continue;
    // `?.(` optional call on a value, not a bare callee
    if (code[m.index - 1] === '?' || code[m.index - 1] === '.') continue;
    // A `name(...) {` is a method/getter definition (or constructor), and
    // `name(...) =>` / `async (...) =>` are arrow params — not calls.
    const after = afterParens(code, m.index + m[1].length + m[2].length);
    if (after === '{' || after === '=>') continue;
    const line = code.slice(0, m.index).split('\n').length;
    found.push([m[1], line]);
  }
  return found;
}

// The next significant token after the balanced parens starting at `open`:
// '{', '=>', or '' when it is neither.
function afterParens(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        const rest = code.slice(i + 1).match(/^\s*(\{|=>)?/);
        return (rest && rest[1]) || '';
      }
    }
  }
  return '';
}

function rendererFiles() {
  // argv override points the scan at scratch copies (negative control).
  const arg = process.argv.find((a) => a.startsWith('--scan='));
  if (arg) return arg.slice('--scan='.length).split(',').filter(Boolean);
  return fs.readdirSync(RENDERER).filter((f) => f.endsWith('.js')).map((f) => path.join(RENDERER, f));
}

function exportedNames(file) {
  const code = blankInert(fs.readFileSync(file, 'utf8'));
  const names = new Set();
  for (const m of code.matchAll(new RegExp(`export\\s+(?:async\\s+)?function\\s+(${IDENT})`, 'g'))) names.add(m[1]);
  for (const m of code.matchAll(new RegExp(`export\\s+(?:const|let|var|class)\\s+(${IDENT})`, 'g'))) names.add(m[1]);
  for (const m of code.matchAll(/export\s*{([^}]*)}/g)) {
    for (const part of m[3 - 2].split(',')) {
      const mm = part.trim().match(new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`));
      if (mm) names.add(mm[2] || mm[1]);
    }
  }
  return names;
}

function resolveImport(fromFile, spec) {
  const clean = spec.split('?')[0];
  if (!clean.startsWith('.')) return null; // node: / bare imports are out of scope
  const abs = path.resolve(path.dirname(fromFile), clean);
  return fs.existsSync(abs) ? abs : (fs.existsSync(abs + '.js') ? abs + '.js' : null);
}

test('no-undef: every bare callee in the renderer resolves', () => {
  const bad = [];
  for (const file of rendererFiles()) {
    const code = blankInert(fs.readFileSync(file, 'utf8'));
    const defs = definedNames(code);
    for (const [name, line] of calledNames(code)) {
      if (defs.has(name) || GLOBALS.has(name)) continue;
      bad.push(`${path.basename(file)}:${line}: ${name}`);
    }
  }
  assert.equal(bad.length, 0, `unresolved callees:\n  ${bad.join('\n  ')}`);
});

test('imports resolve: named imports exist in their source module', () => {
  const bad = [];
  for (const file of rendererFiles()) {
    const code = blankInert(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/import\s+(?:\w+\s*,\s*)?(?:\*\s*as\s+\w+|{([^}]*)})?\s*from\s*['"]([^'"]+)['"]/g)) {
      if (!m[1]) continue; // default / namespace imports are out of scope
      const target = resolveImport(file, m[2]);
      if (!target) { bad.push(`${path.basename(file)}: cannot resolve ${m[2]}`); continue; }
      const exports = exportedNames(target);
      for (const part of m[1].split(',')) {
        const mm = part.trim().match(new RegExp(`^(${IDENT})(?:\\s+as\\s+${IDENT})?$`));
        if (mm && !exports.has(mm[1])) bad.push(`${path.basename(file)}: ${mm[1]} not exported by ${path.basename(target)}`);
      }
    }
  }
  assert.equal(bad.length, 0, `broken imports:\n  ${bad.join('\n  ')}`);
});

test('agentToolMeta takes the tool and carries no label/icon keys', () => {
  assert.equal(agentToolMeta(null), null);
  assert.equal(agentToolMeta({}), null);
  assert.equal(agentToolMeta({ rawInput: {} }), null);
  assert.deepEqual(Object.keys(agentToolMeta({ rawInput: { subagent_type: 'explore' } })).sort(), ['background', 'count', 'swarm', 'type']);
  assert.deepEqual(agentToolMeta({ rawInput: { subagent_type: 'explore' } }), { swarm: false, type: 'explore', count: 1, background: false });
});

test('agentSubtitle + toolDisplayState keep their scalar contracts', () => {
  assert.equal(agentSubtitle({ rawInput: { subagent_type: 'explore' } }), 'explore');
  assert.equal(agentSubtitle({}), '');
  for (const status of ['pending', 'in_progress', 'running', 'completed', 'failed', 'cancelled']) {
    assert.equal(typeof toolDisplayState({ status }), 'string', status);
  }
  assert.equal(toolDisplayState({ status: 'completed', rawInput: { subagent_type: 'x', run_in_background: true } }), 'background');
});

const summary = { pass: 0, fail: 0 };
for (const [name, fn] of tests) {
  try {
    await fn();
    summary.pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    summary.fail += 1;
    console.log(`  FAIL ${name}\n       ${String(err?.message || err).split('\n').join('\n       ')}`);
  }
}
console.log(`renderer-contracts: ${summary.pass}/${tests.length} passed`);
process.exit(summary.fail ? 1 : 0);
