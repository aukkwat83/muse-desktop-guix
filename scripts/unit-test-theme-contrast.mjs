#!/usr/bin/env node
// WCAG contrast for every theme, computed from the CSS token blocks.
//
// This exists because a palette regression is invisible in review: swapping a
// hex for one that "looks about the same" is exactly how a theme drifts under
// AA. The numbers here were derived from a live DOM audit in the running app
// (walking every text node, plus the form controls a text-node walk misses),
// then pinned so the same mistakes cannot come back silently.
//
// Only *text* pairs are checked. Borders, washes and drop-target outlines are
// decorative and have no contrast requirement.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'src/renderer');

// ------------------------------------------------------------ colour math

function parseHex(h) {
  const s = h.trim().replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function parseColor(value) {
  const v = String(value).trim();
  if (v.startsWith('#')) return { rgb: parseHex(v), a: 1 };
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
}

/** Flatten a translucent colour onto an opaque one. */
function over(fg, bgRgb) {
  if (fg.a >= 1) return fg.rgb;
  return fg.rgb.map((c, i) => c * fg.a + bgRgb[i] * (1 - fg.a));
}

function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// --------------------------------------------------------------- parsing

/** Pull `--name: value;` pairs out of one CSS block. */
function tokensIn(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const tokens = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
    if (m) tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

const styleCss = fs.readFileSync(path.join(RENDERER, 'style.css'), 'utf8');
const claudeCss = fs.readFileSync(path.join(RENDERER, 'theme-claude-light.css'), 'utf8');
const claudeDarkCss = fs.readFileSync(path.join(RENDERER, 'theme-claude-dark.css'), 'utf8');

const base = tokensIn(styleCss, ":root,\nhtml[data-theme='moonlight']");
const themes = {
  moonlight: base,
  daylight: { ...base, ...tokensIn(styleCss, "html[data-theme='daylight']") },
  'claude-light': { ...base, ...tokensIn(claudeCss, "html[data-theme='claude-light']") },
  'claude-dark': { ...base, ...tokensIn(claudeDarkCss, "html[data-theme='claude-dark']") },
};

function resolve(tokens, name, depth = 0) {
  const raw = tokens[name];
  assert.ok(raw, `missing token ${name}`);
  const varRef = raw.match(/^var\((--[\w-]+)\)$/);
  if (varRef) {
    assert.ok(depth < 5, `token indirection too deep at ${name}`);
    return resolve(tokens, varRef[1], depth + 1);
  }
  const c = parseColor(raw);
  assert.ok(c, `token ${name} is not a colour: ${raw}`);
  return c;
}

/** Opaque background: a wash token flattened onto the surface beneath it. */
function surface(tokens, name, underName) {
  const c = resolve(tokens, name);
  if (c.a >= 1) return c.rgb;
  assert.ok(underName, `${name} is translucent and needs a backdrop`);
  return over(c, surface(tokens, underName));
}

// ----------------------------------------------------------------- pairs

/** [label, foreground token, background token, backdrop for a translucent bg] */
const PAIRS = [
  ['body text on page', '--ink', '--bg'],
  ['body text on panel', '--ink', '--panel'],
  ['body text on raised', '--ink', '--raised'],
  ['secondary text on panel', '--ink-dim', '--panel'],
  ['secondary text on page', '--ink-dim', '--bg'],
  ['muted on panel', '--muted', '--panel'],
  ['muted on panel-2', '--muted', '--panel-2'],
  ['muted on raised', '--muted', '--raised'],
  // h6 headings in the assistant stream are muted type straight on the page.
  ['muted on page', '--muted', '--bg'],
  // The sidebar's active row tints the panel with the accent wash; muted text
  // sits on *that*, which is where #878ba3 quietly failed at 4.0.
  ['muted on active row', '--muted', '--accent-soft', '--panel'],
  // Selected text is body ink on the accent wash (BUG-058) — measure it
  // against the wash flattened onto the page, same as the active sidebar row.
  ['selected text on page', '--ink', '--accent-soft', '--bg'],
  ['accent type on page', '--accent-text', '--bg'],
  ['accent type on panel', '--accent-text', '--panel'],
  ['accent type on active row', '--accent-text', '--accent-soft', '--panel'],
  ['glyph on accent fill', '--accent-ink', '--accent'],
  ['label on danger fill', '--on-danger', '--danger'],
  ['label on warn fill', '--warn-ink', '--warn'],
  ['success text on panel', '--ok', '--panel'],
  ['success text on page', '--ok', '--bg'],
  // The copied flash on the code-block chrome button sits on the panel-2 bar.
  ['success text on panel-2', '--ok', '--panel-2'],
  ['danger text on panel', '--danger', '--panel'],
  ['warn text on page', '--warn', '--bg'],
  // Placeholders are not text nodes — a DOM walk that only reads text misses
  // them entirely, and they must be measured against the input, not the page.
  ['placeholder in input', '--placeholder', '--input-bg'],
  ['input value', '--ink', '--input-bg'],
  // The user bubble is a filled surface of its own; body ink sits straight on
  // it (.msg-user). A palette edit used to be able to regress this silently.
  ['user bubble text', '--ink', '--user-bubble'],
  // Monospace islands on --code-bg: tool output and interaction summaries are
  // ink-dim (.tool-body, .ix-summary), the auth command is muted (.auth-cmd).
  ['tool output on code', '--ink-dim', '--code-bg'],
  ['muted on code', '--muted', '--code-bg'],
];

const AA = 4.5;

let failed = 0;
for (const [theme, tokens] of Object.entries(themes)) {
  console.log(`\n▸ ${theme}`);
  for (const [label, fgName, bgName, underName] of PAIRS) {
    let ratio;
    try {
      const bg = surface(tokens, bgName, underName);
      const fg = over(resolve(tokens, fgName), bg);
      ratio = contrast(fg, bg);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${label} — ${err.message}`);
      continue;
    }
    if (ratio + 1e-9 < AA) {
      failed++;
      console.log(`  FAIL ${label}: ${ratio.toFixed(2)} < ${AA}`);
    } else {
      console.log(`  ok   ${label}: ${ratio.toFixed(2)}`);
    }
  }
}

// Structural guard: every theme must define the full token set, or a theme
// silently inherits a colour from the dark default and looks broken in one spot.
console.log('\n▸ token coverage');
const required = [
  '--bg', '--panel', '--panel-2', '--raised', '--line', '--line-soft',
  '--ink', '--ink-dim', '--muted',
  '--accent', '--accent-text', '--accent-ink', '--accent-soft', '--accent-line',
  '--focus-ring',
  '--ok', '--warn', '--warn-ink', '--danger', '--on-danger',
  '--user-bubble', '--code-bg', '--code-line', '--input-bg', '--placeholder', '--shadow',
];
for (const [theme, tokens] of Object.entries(themes)) {
  const own =
    theme === 'moonlight'
      ? base
      : theme === 'daylight'
        ? tokensIn(styleCss, "html[data-theme='daylight']")
        : theme === 'claude-light'
          ? tokensIn(claudeCss, "html[data-theme='claude-light']")
          : tokensIn(claudeDarkCss, "html[data-theme='claude-dark']");
  const missing = required.filter((t) => !(t in own));
  // Only the base block must be exhaustive; overrides may inherit deliberately.
  if (theme === 'moonlight' && missing.length) {
    failed++;
    console.log(`  FAIL ${theme} base is missing: ${missing.join(', ')}`);
  } else {
    console.log(`  ok   ${theme} defines ${Object.keys(own).length} tokens`);
  }
}

console.log(`\ntheme-contrast: ${failed ? `${failed} failure(s)` : 'all pairs pass AA'}`);
process.exit(failed ? 1 : 0);
