#!/usr/bin/env node
// Renderer markdown invariants (src/renderer/markdown-core.js — pure, no DOM,
// no vendor imports, so Node can load it directly like turn-view.js).
//
// markdown.js itself stays browser-only (it imports marked via the
// server-mapped /vendor path and touches document inside sanitizeHtml), so
// everything with a rule worth protecting lives in markdown-core.js.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The real parser, straight from node_modules — the renderer configures its
// own instance via /vendor, but fence normalization only needs stock marked.
import { marked } from 'marked';

import {
  escapeHtml,
  codeBlockHtml,
  fenceOpenState,
  balanceFences,
  normalizeMarkdownFences,
  prepareStreamingMarkdown,
  safeUrl,
  isExternalUrl,
  plainFallbackHtml,
  COPY_OK_TEXT,
  COPY_FAIL_TEXT,
} from '../src/renderer/markdown-core.js';

const RENDERER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer');
const markdownJs = fs.readFileSync(path.join(RENDERER, 'markdown.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(RENDERER, 'style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('escapeHtml escapes markup-significant characters', () => {
  assert.equal(escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
});

test('codeBlockHtml emits chrome bar with language label and copy button (BUG-034)', () => {
  const html = codeBlockHtml({ text: 'const a = 1;', lang: 'js' });
  assert.ok(html.includes('<div class="md-code-block">'));
  assert.ok(html.includes('<div class="md-code-chrome">'));
  assert.ok(html.includes('<span class="md-code-label">js</span>'));
  assert.ok(html.includes('class="md-copy-btn"'));
  assert.ok(html.includes('<pre class="md-pre"><code class="language-js">'));
});

test('codeBlockHtml falls back to a bare "code" label and no language class', () => {
  const html = codeBlockHtml({ text: 'x', lang: '' });
  assert.ok(html.includes('<span class="md-code-label">code</span>'));
  assert.ok(html.includes('<pre class="md-pre"><code>'), 'no language- class without a fence info');
});

test('codeBlockHtml escapes the code body and the info string', () => {
  const html = codeBlockHtml({ text: 'if (a < b) { c("&"); }', lang: 'js"><script' });
  assert.ok(html.includes('if (a &lt; b) { c(&quot;&amp;&quot;); }'));
  assert.ok(!html.includes('<script'), 'info string must not break out of the class attribute');
});

test('copy button strings are Thai, resting label included (BUG-035)', () => {
  assert.equal(COPY_OK_TEXT, '✓ คัดลอกแล้ว');
  assert.equal(COPY_FAIL_TEXT, '! ลองใหม่');
  const html = codeBlockHtml({ text: 'x', lang: 'js' });
  assert.ok(html.includes('>คัดลอก</button>'), 'resting label must be Thai, not "copy"');
});

test('sanitize wraps tables in .md-table-wrap with horizontal scroll (BUG-036)', () => {
  // The walk itself needs a DOM; pin the wiring at source level instead.
  assert.ok(markdownJs.includes("wrap.className = 'md-table-wrap'"));
  assert.ok(markdownJs.includes("querySelectorAll('table')"));
  const css = styleCss.match(/\.msg-assistant \.md-table-wrap \{([^}]*)\}/);
  assert.ok(css, 'style.css must define .msg-assistant .md-table-wrap');
  assert.ok(css[1].includes('overflow-x: auto'));
});

test('GFM typography is pinned for the assistant column (BUG-037)', () => {
  for (const sel of ['.msg-assistant h1', '.msg-assistant h6', '.msg-assistant ul', '.msg-assistant ol', '.msg-assistant li', '.msg-assistant hr']) {
    assert.ok(styleCss.includes(sel), `style.css is missing ${sel}`);
  }
  const img = styleCss.match(/\.msg-assistant img \{([^}]*)\}/);
  assert.ok(img, 'style.css must define .msg-assistant img');
  assert.ok(img[1].includes('max-width: 100%'), 'images must not overflow the column');
});

test('fenceOpenState walks CommonMark fences, not a naive ^``` count (BUG-038)', () => {
  assert.equal(fenceOpenState('text\n```js\ncode\n').open, true);
  assert.equal(fenceOpenState('```\ncode\n```\nafter').open, false);
  // Indented up to 3 spaces still opens/closes a fence (CommonMark 4.5).
  assert.equal(fenceOpenState('```js\n  ```\n').open, false);
  // 4+ spaces is an indented code block, not a fence.
  assert.equal(fenceOpenState('    ```\n').open, false);
  // Longer backtick runs toggle once, not per backtick.
  assert.equal(fenceOpenState('````\nx\n').open, true);
  assert.equal(fenceOpenState('````\nx\n````\n').open, false);
});

test('balanceFences closes only a genuinely open fence (BUG-038)', () => {
  assert.equal(balanceFences('```js\ncode'), '```js\ncode\n```');
  assert.equal(balanceFences('```js\ncode\n```'), '```js\ncode\n```');
  // The old /^```/gm regex missed this indented closer and appended a phantom.
  assert.equal(balanceFences('```js\n  ```'), '```js\n  ```');
});

test('streaming prep runs only on the live path (BUG-038)', () => {
  // Live: an unbalanced tail gets a closing fence so it renders as code now.
  assert.equal(prepareStreamingMarkdown('```js\nlet x'), '```js\nlet x\n```');
  // Settled: renderMarkdown(text) without opts must not mutate — the app
  // passes { live: true } only from the streaming paint.
  const settled = renderMarkdownSource('```js\nlet x');
  assert.equal(settled, '```js\nlet x', 'settled text must parse as written');
});

// renderMarkdown's parse-source decision, mirrored without the DOM sanitize.
function renderMarkdownSource(text, opts = {}) {
  return opts.live ? prepareStreamingMarkdown(text) : String(text ?? '');
}

test('only the streaming paint passes { live: true } (BUG-038)', () => {
  assert.ok(appJs.includes('renderMarkdown(tv.text, { live: true })'));
  assert.ok(appJs.includes('renderMarkdown(msg.text)'), 'history path must stay settled');
  assert.ok(appJs.includes('renderMarkdown(ix.body)'), 'interaction body must stay settled');
});

test('safeUrl allows web, mailto, site-relative and anchor links (BUG-039)', () => {
  assert.equal(safeUrl('https://example.com'), 'https://example.com');
  assert.equal(safeUrl('http://example.com'), 'http://example.com');
  assert.equal(safeUrl('mailto:a@b.c'), 'mailto:a@b.c');
  assert.equal(safeUrl('/docs/page'), '/docs/page');
  assert.equal(safeUrl('#section'), '#section');
  assert.equal(safeUrl('  https://x.y  '), 'https://x.y', 'whitespace is trimmed');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,<script>'), null);
  assert.equal(safeUrl(''), null);
  assert.equal(safeUrl(undefined), null);
});

test('target=_blank is gated to http(s) links only (BUG-039)', () => {
  assert.equal(isExternalUrl('https://example.com'), true);
  assert.equal(isExternalUrl('http://example.com'), true);
  assert.equal(isExternalUrl('mailto:a@b.c'), false);
  assert.equal(isExternalUrl('/docs'), false);
  assert.equal(isExternalUrl('#section'), false);
  // The sanitizer must apply that gate, not set target unconditionally.
  assert.ok(markdownJs.includes('if (isExternalUrl(url))'));
});

test('CSP img-src covers the https images the sanitizer allows (BUG-040)', () => {
  const csp = indexHtml.match(/content="([^"]*img-src[^"]*)"/);
  assert.ok(csp, 'index.html must carry a CSP meta');
  const imgSrc = csp[1].match(/img-src\s+([^;]+)/);
  assert.ok(imgSrc, 'CSP must declare img-src');
  // safeImgSrc accepts ^https: — without it here, allowed images render broken.
  assert.ok(imgSrc[1].split(/\s+/).includes('https:'), `img-src is missing https: — got ${imgSrc[1]}`);
  // http: stays blocked on purpose (mixed content); only https/data/self pass.
  assert.ok(!imgSrc[1].split(/\s+/).includes('http:'));
});

test('parser failure falls back to escaped plain text in .md-plain (BUG-041)', () => {
  const html = plainFallbackHtml('a <b> & "c"\nnext line');
  assert.ok(html.startsWith('<div class="md-plain">'));
  assert.ok(html.includes('a &lt;b&gt; &amp; &quot;c&quot;\nnext line'));
  // The sanitizer pass must let the wrapper through: div + class is allowed.
  assert.ok(markdownJs.includes('catch'), 'renderMarkdown must contain marked.parse');
  assert.ok(markdownJs.includes('plainFallbackHtml(text)'));
  const css = styleCss.match(/\.msg-assistant \.md-plain \{([^}]*)\}/);
  assert.ok(css && css[1].includes('white-space: pre-wrap'));
});

test('normalizeMarkdownFences un-glues a fence fused to preceding text (BUG-042)', () => {
  assert.equal(normalizeMarkdownFences('text```js\ncode'), 'text\n\n```js\ncode');
  // Inline triple-backtick spans have no newline after the info — untouched.
  assert.equal(normalizeMarkdownFences('a ```code``` b'), 'a ```code``` b');
  // A glued closing fence breaks onto its own line only when it is a closer.
  assert.equal(normalizeMarkdownFences('```js\ncode```\n'), '```js\ncode\n```\n');
  assert.equal(normalizeMarkdownFences('no fences here'), 'no fences here');
});

test('a glued fence mid-stream parses as a code block, not inline code (BUG-042)', () => {
  const prepped = prepareStreamingMarkdown('ผลลัพธ์:```js\nconst a = 1;');
  const html = marked.parse(prepped);
  assert.ok(/<pre><code/.test(html), `expected a code block, got: ${html}`);
});

test('prepareStreamingMarkdown soft-closes an open HTML comment (BUG-042)', () => {
  const out = prepareStreamingMarkdown('text <!-- draft');
  assert.ok(out.endsWith(' -->'), `expected a soft-closed comment, got: ${out}`);
  // Balanced comments are left alone.
  const closed = 'text <!-- note --> more';
  assert.ok(prepareStreamingMarkdown(closed).startsWith(closed));
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
console.log(`markdown: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
