#!/usr/bin/env node
// Static CSS guards (BUG-061), ported from grok-desktop's
// unit-test-css-balance.mjs / unit-test-theme-r11.mjs and adapted to muse.
//
// Pins seven things that are invisible in review but break the app quietly:
//   1. brace/comment balance of every renderer stylesheet — one stray `}` and
//      WebKit silently drops every rule after it;
//   2. theme override files stay fully scoped under html[data-theme='…'] —
//      an unscoped selector leaks onto every other theme;
//   3. theme-boot.js loads before the stylesheets in index.html, or the first
//      paint flashes the default palette;
//   4. every renderer asset in index.html carries the same non-empty ?v=
//      token — WKWebView serves a stale bundle otherwise;
//   5. classes named inside @media (prefers-reduced-motion) blocks actually
//      exist in the renderer — the BUG-056 dead-selector class of bug;
//   6. flex/grid scroll containers declare min-height: 0 — the default
//      min-height:auto refuses to shrink below content, so the container
//      never overflows, never scrolls, and pushes the composer off-screen
//      (BUG-073);
//   7. package.json version equals the shared ?v= token — the badge paints
//      pkg.version; a drift means the badge lies about the build (BUG-078).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'src/renderer');

const styleCss = fs.readFileSync(path.join(RENDERER, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const themeFiles = fs
  .readdirSync(RENDERER)
  .filter((f) => /^theme-.*\.css$/.test(f))
  .sort();

/**
 * Walk CSS source tracking depth, strings and block comments.
 * Returns balance facts plus the top-level selectors (for the scoping check).
 */
function walkCss(text) {
  let depth = 0;
  let minDepth = 0;
  let inComment = false;
  let inString = null;
  let firstNegative = null;
  let unclosedCommentLine = null;
  let commentLine = null;
  const selectors = [];
  let sel = '';
  let selLine = 1;
  const lines = text.split('\n');

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (inComment) {
        if (ch === '*' && next === '/') {
          inComment = false;
          i++;
        }
        continue;
      }
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === inString) inString = null;
        if (depth === 0) sel += ch;
        continue;
      }
      if (ch === '/' && next === '*') {
        inComment = true;
        commentLine = li + 1;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        if (depth === 0) sel += ch;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) {
          selectors.push(sel.replace(/\s+/g, ' ').trim());
          sel = '';
        }
        depth++;
        continue;
      }
      if (ch === '}') {
        depth--;
        if (depth < minDepth) minDepth = depth;
        if (depth < 0 && !firstNegative) firstNegative = `L${li + 1}: ${line.trim().slice(0, 80)}`;
        continue;
      }
      if (depth === 0) {
        if (sel === '' && /\S/.test(ch)) selLine = li + 1;
        sel += ch;
      }
      void selLine;
    }
    if (depth === 0 && !inComment && !inString) sel += ' ';
  }
  if (inComment) unclosedCommentLine = commentLine;
  return { depth, minDepth, firstNegative, unclosedCommentLine, inStringAtEof: inString, selectors };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ------------------------------------------------------------- balance

function balanceSuite(label, css) {
  test(`${label}: braces balanced, no stray close`, () => {
    const w = walkCss(css);
    assert.equal(w.depth, 0, `final depth ${w.depth}`);
    assert.ok(w.minDepth >= 0 && !w.firstNegative, `first stray } at ${w.firstNegative}`);
  });
  test(`${label}: no unclosed comment or string`, () => {
    const w = walkCss(css);
    assert.ok(!w.unclosedCommentLine, `unclosed /* opened at L${w.unclosedCommentLine}`);
    assert.ok(!w.inStringAtEof, `unclosed string ${w.inStringAtEof} at EOF`);
  });
}

balanceSuite('style.css', styleCss);
for (const f of themeFiles) {
  balanceSuite(f, fs.readFileSync(path.join(RENDERER, f), 'utf8'));
}

// ------------------------------------------------------------- scoping

test('theme override files are fully scoped under their data-theme', () => {
  for (const f of themeFiles) {
    const theme = f.replace(/^theme-/, '').replace(/\.css$/, '');
    const css = fs.readFileSync(path.join(RENDERER, f), 'utf8');
    const leaks = [];
    for (const sel of walkCss(css).selectors) {
      if (!sel) continue;
      // @keyframes/@font-face cannot be scoped — they must not live here.
      if (sel.startsWith('@keyframes') || sel.startsWith('@font-face')) {
        leaks.push(sel.slice(0, 60));
        continue;
      }
      if (sel.startsWith('@media') || sel.startsWith('@supports')) continue;
      for (const part of sel.split(',').map((p) => p.trim())) {
        if (!part.includes(`[data-theme='${theme}']`) && !part.includes(`[data-theme="${theme}"]`)) {
          leaks.push(part.slice(0, 80));
        }
      }
    }
    assert.equal(leaks.length, 0, `${f} leaks: ${leaks.slice(0, 4).join(' | ')}`);
  }
});

// ---------------------------------------------------------- index.html

test('theme-boot.js loads before the stylesheets', () => {
  const boot = html.search(/theme-boot\.js/);
  const firstCss = html.search(/<link rel="stylesheet"/);
  assert.ok(boot >= 0, 'theme-boot.js not linked');
  assert.ok(firstCss >= 0, 'no stylesheet linked');
  assert.ok(boot < firstCss, 'theme-boot.js must come before the stylesheets');
});

test('index.html opts out of browser translation (BUG-070)', () => {
  // The host opens the default browser when NO_OPEN is unset — without these,
  // Chrome's translate banner hijacks the app window.
  assert.ok(/<html[^>]*translate="no"/.test(html), 'missing translate="no" on <html>');
  assert.ok(/<html[^>]*class="[^"]*\bnotranslate\b/.test(html), 'missing class="notranslate" on <html>');
  assert.ok(/<meta name="google" content="notranslate"/.test(html), 'missing google notranslate meta');
  assert.ok(/<meta name="googlebot" content="notranslate"/.test(html), 'missing googlebot notranslate meta');
});

test('every renderer script/stylesheet carries the same non-empty ?v= token', () => {
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"?]*\.(?:js|css))(?:\?v=([^"]*))?"/g)];
  assert.ok(refs.length >= 3, `expected several renderer assets, found ${refs.length}`);
  const tokens = new Set();
  for (const [, asset, v] of refs) {
    assert.ok(v && v.length > 0, `${asset} is missing its ?v= cache-bust token`);
    tokens.add(v);
  }
  assert.equal(tokens.size, 1, `mixed ?v= tokens: ${[...tokens].join(', ')}`);
});

// One number, one meaning (BUG-078): the badge paints pkg.version from
// /api/version, WKWebView cache-busts on the shared ?v= token — 77 fixes
// went out while the badge still read 0.4.0 because nothing tied the two.
test('package.json version matches the shared ?v= token (BUG-078)', () => {
  const tokens = new Set(
    [...html.matchAll(/(?:src|href)="\/[^"?]*\.(?:js|css)\?v=([^"]*)"/g)].map((m) => m[1]),
  );
  assert.equal(tokens.size, 1, `mixed ?v= tokens: ${[...tokens].join(', ')}`);
  assert.equal(
    pkg.version,
    [...tokens][0],
    `package.json is ${pkg.version} but index.html busts at ${[...tokens][0]} — bump them together`,
  );
});

// ------------------------------------------------- min-height: 0 guards

// Flex/grid children default to min-height:auto and refuse to shrink below
// their content — the container then never overflows, never shows a
// scrollbar, and grows its parent past the viewport (BUG-073: long answer →
// no transcript scrollbar, composer pushed off-screen; grok-desktop pins the
// same hazard class, style.css:768-772 + .main-col:2163 + .sidebar:850).
// Blocks that scroll via an explicit max-height cap (tool output, ix bodies)
// use a different mechanism and are deliberately NOT in this list.
test('flex/grid scroll containers declare min-height: 0 (BUG-073)', () => {
  const mustShrink = ['#main', '.transcript', '#sidebar', '.sidebar-nav', '#rightbar', '.rb-scroll'];
  for (const sel of mustShrink) {
    const re = new RegExp(`${sel.replace(/[.]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
    const m = styleCss.match(re);
    assert.ok(m, `${sel} rule not found in style.css`);
    assert.ok(/min-height:\s*0\s*;/.test(m[1]), `${sel} is missing min-height: 0`);
  }
});

// ------------------------------------------------------- console type
// Console output reads at 3:4 of the answer text: the .tool-body rule must
// ride the caption token, and that token must resolve to exactly 3/4 of the
// body token — a quiet px edit on either side breaks the ratio silently.
test('console text is 3:4 of the result text', () => {
  const bodyRule = styleCss.match(/\.tool-body\s*\{([^}]*)\}/);
  assert.ok(bodyRule, '.tool-body rule not found in style.css');
  assert.ok(
    /font-size:\s*var\(--fs-caption-1\)\s*;/.test(bodyRule[1]),
    '.tool-body must use font-size: var(--fs-caption-1)',
  );
  const px = (name) => {
    const m = styleCss.match(new RegExp(`${name}:\\s*([\\d.]+)px`));
    assert.ok(m, `${name} token not found`);
    return Number(m[1]);
  };
  const ratio = px('--fs-caption-1') / px('--fs-body');
  assert.equal(ratio, 0.75, `console/result ratio is ${ratio}, want 0.75`);
});

// ------------------------------------------------------- reduced motion

test('reduced-motion blocks only name classes that exist in the renderer', () => {
  // Selector check, not a render: a class that no JS/HTML produces means the
  // guard is dead weight (BUG-056 shipped exactly that for months).
  const sources = fs
    .readdirSync(RENDERER)
    .filter((f) => f === 'index.html' || f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(RENDERER, f), 'utf8'))
    .join('\n');
  const noComments = styleCss.replace(/\/\*[^]*?\*\//g, '');
  const blocks = noComments.match(/@media[^{]*prefers-reduced-motion[^{]*\{[^]*?\n\}/g) || [];
  assert.ok(blocks.length > 0, 'no reduced-motion block found in style.css');
  const missing = [];
  for (const block of blocks) {
    for (const m of block.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      const cls = m[1];
      if (!new RegExp(`['"\`\\s]${cls}['"\`\\s)]`).test(sources) && !sources.includes(cls)) {
        missing.push(`.${cls}`);
      }
    }
  }
  assert.equal(missing.length, 0, `dead selectors: ${[...new Set(missing)].join(', ')}`);
});

// ------------------------------------------------------- goal strip
// The composer goal strip is a sibling ABOVE the form (own row), never a
// flex item inside the prompt row — inside, it shared the prompt line and
// overflowed the edge. Its styles are id-scoped: the `.goal-bar` /
// `.goal-objective` classes belong to the panel progress rows, which live
// under `.goal-block` (1.1.28 un-collided the two).
test('goal strip sits outside the composer form on its own row (1.1.28)', () => {
  const formOpen = html.indexOf('<form id="composer"');
  const formClose = html.indexOf('</form>');
  assert.ok(formOpen !== -1 && formClose > formOpen, 'composer form not found in index.html');
  const strip = html.indexOf('id="goal-bar"');
  assert.ok(strip !== -1, '#goal-bar not found in index.html');
  assert.ok(
    strip < formOpen || strip > formClose,
    '#goal-bar is inside form#composer — it must be a sibling above it',
  );
});

test('goal strip styles are id-scoped, panel rows under .goal-block (1.1.28)', () => {
  assert.ok(/^#goal-bar\s*\{/m.test(styleCss), 'missing id-scoped #goal-bar rule');
  assert.ok(!/^\.goal-bar\s*\{/m.test(styleCss), 'unscoped .goal-bar block rule — the strip and the panel track collide again');
  assert.ok(/^\.goal-block \.goal-bar\s*\{/m.test(styleCss), 'panel progress track must live under .goal-block');
  assert.ok(!/^\.goal-objective\s*\{/m.test(styleCss), 'unscoped .goal-objective block rule — panel/strip text rules collide again');
});

test('goal strip never overflows at any width: squeeze order + narrow fallback', () => {
  const noComments = styleCss.replace(/\/\*[^]*?\*\//g, '');
  const rule = (sel) => {
    const m = noComments.match(new RegExp(`${sel}\\s*\\{([^}]*)\\}`));
    assert.ok(m, `missing ${sel} rule`);
    return m[1];
  };
  // Container: shrinkable, gutter-capped, clipped — margins can never push it
  // past #main no matter how narrow the window gets.
  const bar = rule('#goal-bar');
  assert.ok(/min-width:\s*0/.test(bar), '#goal-bar needs min-width: 0');
  assert.ok(/max-width:\s*calc\(100%\s*-\s*40px\)/.test(bar), '#goal-bar needs max-width: calc(100% - 40px)');
  assert.ok(/overflow:\s*hidden/.test(bar), '#goal-bar needs overflow: hidden');
  // Squeeze order: objective ellipsizes first, meta shrinks next, button intact.
  const obj = rule('#goal-bar \\.goal-objective');
  assert.ok(/flex:\s*1\s+1\s+auto/.test(obj), 'objective needs flex: 1 1 auto');
  assert.ok(/min-width:\s*0/.test(obj), 'objective needs min-width: 0');
  assert.ok(/text-overflow:\s*ellipsis/.test(obj), 'objective needs ellipsis');
  const meta = rule('#goal-bar \\.goal-meta');
  assert.ok(/flex:\s*0\s+1\s+auto/.test(meta), 'meta needs flex: 0 1 auto');
  assert.ok(/min-width:\s*0/.test(meta), 'meta needs min-width: 0');
  const btn = rule('#goal-bar \\.goal-btn');
  assert.ok(/flex:\s*none/.test(btn), 'button must never shrink (flex: none)');
  assert.ok(/white-space:\s*nowrap/.test(btn), 'button text must stay single-line');
  // Narrow screens: meta drops out and gutters tighten so the button survives.
  assert.ok(
    /@media[^{]*max-width:\s*480px[^]*?#goal-bar\s+\.goal-meta[^]*?display:\s*none/.test(noComments),
    'missing ≤480px fallback hiding #goal-bar .goal-meta',
  );
  assert.ok(
    /@media[^{]*max-width:\s*480px[^]*?#goal-bar\s*\{[^}]*margin:\s*0\s+12px/.test(noComments),
    'missing ≤480px fallback tightening #goal-bar margins',
  );
});

test('overview popup stays inside narrow/short viewports (1.1.30)', () => {
  const css = styleCss.replace(/\/\*[^]*?\*\//g, '');
  // Viewport-relative width + a capped scroll column: placement clamps the
  // box, CSS keeps the column usable once clamped.
  assert.ok(
    /\.pop\.panel\.overview-panel\s*\{[^}]*width:\s*min\(600px,\s*calc\(100vw - 32px\)\)/.test(css),
    'missing viewport-relative .overview-panel width',
  );
  assert.ok(
    /\.pop\.panel\.overview-panel\s*\{[^}]*max-height:\s*min\(80vh,\s*640px\)/.test(css),
    'missing viewport-relative .overview-panel max-height',
  );
  assert.ok(
    /\.ov-body\s*\{[^}]*overflow-y:\s*auto/.test(css),
    'missing .ov-body scroll column',
  );
  assert.ok(
    /@media[^{]*max-width:\s*480px[^]*?\.pop\.panel\.overview-panel\s*\{[^}]*width:\s*calc\(100vw - 16px\)/.test(css),
    'missing ≤480px fallback widening the overview popup',
  );
  // Thai-safe clamped titles: 2-line clamp with breathing room, never a
  // bare overflow:hidden + tight line-height on tone-marked text.
  assert.ok(
    /\.ov-child \.ov-title\s*\{[^}]*-webkit-line-clamp:\s*2[^}]*line-height:\s*1\.5/.test(css),
    'missing Thai-safe 2-line overview child titles',
  );
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(`css-guards: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
