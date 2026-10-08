#!/usr/bin/env node
// Shared icon family + typography guards (1.1.32).
//
// The UI's chrome icons used to be Unicode symbols (◗ ＋ ▤ ◐ ⌕ ⏻ ▦ ☰ ✳ ⏳
// 📎 ◎ ⧉ ⟳ ⋮⋮ …) that render as tofu on Guix fonts — and every surface
// picked a different symbol for the same verb. icons.js is now the one
// closed vector vocabulary; this suite pins that:
//
//   1. registry shape: closed names, 24px viewBox, currentColor stroke in
//      the 1.7–1.9 band, inert markup only (no script/event surface);
//   2. every icon name referenced anywhere in the renderer resolves;
//   3. hand-duplicated copies (static index.html SVGs, debug.js smoke
//      markers, style.css mask data-URIs) match the registry byte for byte;
//   4. no UI-owned tofu glyph survives in code, static HTML, or CSS
//      `content:` — the only exceptions carry an explicit `tofu-ok` note;
//   5. icon + label state transitions repaint as vectors (source-pinned:
//      send morph, queue chip, goal verbs, chrome flashes, marker strips);
//   6. every icon-only button in index.html has an accessible name;
//   7. the type ladder keeps its floor, ratio, and token stacks.
//
// Pure + source-level checks only — no DOM needed.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ICON_NAMES,
  ICON_STROKE,
  ICON_VIEWBOX,
  getIconBody,
  iconLabelHtml,
  iconSvgString,
  isIconName,
  setIcon,
  updateIconLabel,
} from '../src/renderer/icons.js';
import { taskIcon, SUBAGENT_ACTION_ICON, SUBAGENT_ACTION_LABEL } from '../src/renderer/rightbar.js';
import { stripMarkerGlyph, interruptedMarkerText } from '../src/renderer/turn-view.js';
import { diagramActionButtonsHtml } from '../src/renderer/viz-contract.js';
import { chromeRestingIcon, codeBlockHtml } from '../src/renderer/markdown-core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'src/renderer');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const read = (f) => fs.readFileSync(path.join(RENDERER, f), 'utf8');
const rendererJs = () => fs.readdirSync(RENDERER).filter((f) => f.endsWith('.js'));

/** Glyphs that tofu on Guix fonts and must never appear as UI chrome. */
const RARE_TOFU = '◗＋▤◐⌕⏻▦☰✳⏳📎📄📁◎■⏸⏹✉⎘◈🖼☾🌘☕☀🔧⚠⧉⟳⋮⋯✎▴◀－';
/** Common arrows/checks: banned from static surfaces and paint literals. */
const COMMON_ICONS = '✓✗✕↑↓→←▶▸▾›‹○';

/**
 * Strip // line comments, block comments, and HTML comments. Comments blank
 * to spaces (never removed) so line numbers survive for the tofu-ok gate,
 * and // is only a comment outside quotes, so URLs in strings stay intact.
 */
function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  let out = String(src).replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
  out = out.split('\n').map((line) => {
    let q = null;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (q) {
        if (c === '\\') j++;
        else if (c === q) q = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') q = c;
      else if (c === '/' && line[j + 1] === '/') return `${line.slice(0, j)}${' '.repeat(line.length - j)}`;
    }
    return line;
  }).join('\n');
  return out;
}

// ------------------------------------------------------- registry shape

test('registry is a non-trivial closed vocabulary', () => {
  assert.ok(ICON_NAMES.length >= 25, `only ${ICON_NAMES.length} icons`);
  assert.deepEqual([...ICON_NAMES].sort(), ICON_NAMES, 'ICON_NAMES must be sorted');
  for (const name of ['plus', 'minus', 'x', 'check', 'chevDown', 'search', 'power', 'grid', 'panel', 'contrast', 'clip', 'file', 'folder', 'image', 'clock', 'target', 'spark', 'stop', 'play', 'pause', 'refresh', 'copy', 'popout', 'download', 'ellipsis', 'grip', 'warn', 'alert', 'brand']) {
    assert.ok(isIconName(name), `missing core icon: ${name}`);
  }
});

test('stroke sits in the 1.7–1.9 band on a 24px grid', () => {
  assert.equal(ICON_VIEWBOX, '0 0 24 24');
  assert.ok(ICON_STROKE >= 1.7 && ICON_STROKE <= 1.9, `stroke ${ICON_STROKE}`);
});

test('every body is inert shape markup only', () => {
  for (const name of ICON_NAMES) {
    const body = getIconBody(name);
    assert.ok(body && body.length > 10, `${name}: empty body`);
    assert.ok(!/<\/?(script|style|image|a|foreignObject|animate)\b/i.test(body), `${name}: live element`);
    assert.ok(!/\son\w+\s*=/i.test(body), `${name}: event attribute`);
    assert.ok(!/javascript:/i.test(body), `${name}: javascript: url`);
    const tags = [...body.matchAll(/<(\/?)([a-zA-Z]+)/g)].map((m) => m[2].toLowerCase());
    assert.ok(tags.length > 0, `${name}: no shapes`);
    for (const t of tags) assert.ok(['path', 'circle', 'rect'].includes(t), `${name}: <${t}>`);
    // Balanced tags: every opener closes (self-closed or paired).
    const opens = (body.match(/<(path|circle|rect)\b/g) || []).length;
    const closes = (body.match(/\/>/g) || []).length + (body.match(/<\/(path|circle|rect)>/g) || []).length;
    assert.equal(opens, closes, `${name}: unbalanced tags`);
  }
});

test('iconSvgString shapes a full svg, rejects unknown names', () => {
  const svg = iconSvgString('check');
  assert.ok(svg.startsWith('<svg '));
  assert.ok(svg.includes('viewBox="0 0 24 24"'));
  assert.ok(svg.includes('stroke="currentColor"'));
  assert.ok(svg.includes(`stroke-width="${ICON_STROKE}"`));
  assert.ok(svg.includes('aria-hidden="true"'));
  assert.ok(svg.endsWith('</svg>'));
  assert.equal(iconSvgString('no-such-icon'), '');
  assert.equal(iconSvgString(null), '');
  assert.equal(getIconBody('no-such-icon'), null);
  assert.equal(isIconName('no-such-icon'), false);
});

test('class and label inputs cannot break out of the markup', () => {
  assert.ok(iconSvgString('check', 'ico"><script>alert(1)</script>').includes('class="ico"'));
  assert.ok(!iconSvgString('check', 'x" onload="evil()').includes('onload'));
  const labelled = iconLabelHtml('x', '<img src=x onerror=evil()>');
  assert.ok(!labelled.includes('<img'));
  assert.ok(labelled.includes('&lt;img'));
  assert.ok(labelled.includes('<span class="ic-label">'));
  assert.equal(iconLabelHtml('bogus', 't'), '<span class="ic-label">t</span>');
});

test('DOM helpers are null-safe without a document', () => {
  assert.doesNotThrow(() => setIcon(null, 'check'));
  assert.doesNotThrow(() => updateIconLabel(null, 'x'));
});

// ------------------------------------------------- names-used resolution

/** Every icon position in renderer JS must name a registry icon. */
test('every icon name referenced in renderer JS resolves', () => {
  const pos = [
    /\bsetIcon\s*\(\s*[^,]+,\s*['"]([\w]+)['"]/g,
    /\bsetIconLabel\s*\(\s*[^,]+,\s*['"]([\w]+)['"]/g,
    /\biconSvgString\s*\(\s*['"]([\w]+)['"]/g,
    /\biconElement\s*\(\s*['"]([\w]+)['"]/g,
    /\biconLabelHtml\s*\(\s*['"]([\w]+)['"]/g,
    /[{,]\s*icon\s*:\s*['"]([\w]+)['"]/g, // menu items + theme options
    /data-icon=\\?"([\w]+)\\?"/g, // chrome builders
    /\bpaintChromeBtn\s*\(\s*[^,]+,\s*['"]([\w]+)['"]/g,
  ];
  const unknown = [];
  for (const f of rendererJs()) {
    const src = stripComments(read(f));
    for (const re of pos) {
      for (const m of src.matchAll(re)) {
        if (!isIconName(m[1])) unknown.push(`${f}: ${m[1]}`);
      }
    }
  }
  assert.equal(unknown.length, 0, `unresolved icon names:\n  ${unknown.join('\n  ')}`);
});

test('action + task mappings only use registry icons', () => {
  assert.deepEqual(Object.keys(SUBAGENT_ACTION_ICON).sort(), Object.keys(SUBAGENT_ACTION_LABEL).sort());
  for (const name of Object.values(SUBAGENT_ACTION_ICON)) {
    assert.ok(isIconName(name), `action icon ${name}`);
  }
  for (const status of ['completed', 'in_progress', 'cancelled', 'pending', 'failed', 'bogus', null, undefined]) {
    assert.ok(isIconName(taskIcon(status)), `taskIcon(${status})`);
  }
  assert.equal(taskIcon('completed'), 'check');
  assert.equal(taskIcon('in_progress'), 'arrowRight');
  assert.equal(taskIcon('cancelled'), 'x');
  assert.equal(taskIcon('pending'), 'circle');
});

// ------------------------------------------------------- copy sync

/** Normalize an inline svg body for byte comparison. */
const norm = (s) => String(s).replace(/>\s+</g, '><').trim();

test('index.html inline SVGs match the registry byte for byte', () => {
  const html = read('index.html');
  const svgs = [...html.matchAll(/<svg\b[^>]*data-icon="([\w]+)"[^>]*>([\s\S]*?)<\/svg>/g)];
  assert.ok(svgs.length >= 10, `only ${svgs.length} static svgs`);
  for (const [, name, body] of svgs) {
    assert.ok(isIconName(name), `static svg names unknown icon ${name}`);
    assert.equal(norm(body), norm(getIconBody(name)), `static ${name} drifted from the registry`);
  }
});

test('debug.js smoke markers match the registry', () => {
  const src = read('debug.js');
  const marks = [...src.matchAll(/smokeIcon\('([\w]+)',\s*'([^']*)'\)/g)];
  assert.equal(marks.length, 2, 'expected check + x smoke markers');
  for (const [, name, body] of marks) {
    assert.equal(norm(body), norm(getIconBody(name)), `debug ${name} drifted`);
  }
});

test('style.css mask data-URIs only use registry path data', () => {
  const css = read('style.css');
  // d='...' inside the svg masks (stroke black / fill black markers).
  const ds = [...css.matchAll(/data:image\/svg\+xml,[^)]*?d='([^']+)'/g)].map((m) => m[1]);
  assert.ok(ds.length >= 3, `only ${ds.length} mask paths`);
  const bodies = ICON_NAMES.map(getIconBody);
  for (const d of ds) {
    assert.ok(bodies.some((b) => b.includes(`d="${d}"`)), `mask path drifted: ${d.slice(0, 40)}…`);
  }
});

// ------------------------------------------------------- tofu scans

test('no rare tofu glyph survives outside tofu-ok lines', () => {
  const bad = [];
  for (const f of [...rendererJs(), 'index.html', 'child.html', 'debug.html', 'style.css', 'theme-claude-light.css', 'theme-claude-dark.css']) {
    const raw = read(f).split('\n');
    const code = stripComments(raw.join('\n')).split('\n');
    code.forEach((line, i) => {
      if (raw[i].includes('tofu-ok')) return;
      for (const ch of line) {
        if (RARE_TOFU.includes(ch)) {
          bad.push(`${f}:${i + 1}: ${ch}`);
          break;
        }
      }
    });
  }
  assert.equal(bad.length, 0, `tofu in code:\n  ${bad.join('\n  ')}`);
});

test('index.html carries no common icon glyphs at all', () => {
  const html = stripComments(read('index.html'));
  const bad = [...html].filter((ch) => COMMON_ICONS.includes(ch));
  assert.deepEqual([...new Set(bad)], [], `static glyphs: ${[...new Set(bad)].join(' ')}`);
});

test('style.css content: values carry no icon glyphs', () => {
  const css = stripComments(read('style.css'));
  const bad = [];
  for (const m of css.matchAll(/content:\s*["']([^"']*)["']/g)) {
    for (const ch of m[1]) {
      if (RARE_TOFU.includes(ch) || COMMON_ICONS.includes(ch)) bad.push(m[0].slice(0, 40));
    }
  }
  assert.equal(bad.length, 0, `glyph content: ${bad.join(' | ')}`);
});

test('JS paint literals carry no common icon glyphs', () => {
  const bad = [];
  for (const f of rendererJs()) {
    const raw = read(f).split('\n');
    const code = stripComments(raw.join('\n')).split('\n');
    code.forEach((line, i) => {
      if (raw[i].includes('tofu-ok')) return;
      for (const ch of line) {
        if (COMMON_ICONS.includes(ch)) {
          bad.push(`${f}:${i + 1}: ${ch} ${raw[i].trim().slice(0, 60)}`);
          break;
        }
      }
    });
  }
  assert.equal(bad.length, 0, `glyph literals:\n  ${bad.join('\n  ')}`);
});

// ------------------------------------------- vector state transitions

test('send morphs by vector, never by textContent', () => {
  const src = read('app.js');
  assert.ok(src.includes("setIcon(el.send, running ? (cancelling ? 'ellipsis' : 'stop') : 'arrowUp'"));
  assert.ok(!/el\.send\.textContent\s*=/.test(stripComments(src)), 'send still paints text');
});

test('queue chip updates its label span, not the whole button', () => {
  const src = read('app.js');
  assert.ok(src.includes('updateIconLabel(el.promptQueueChip,'));
  assert.ok(!/promptQueueChip\.textContent\s*=/.test(stripComments(src)));
});

test('goal verbs repaint icon + label together', () => {
  const app = read('app.js');
  const ov = read('overview-panel.js');
  assert.ok(app.includes('setIconLabel(el.goalBarBtn,'));
  assert.ok(!/goalBarBtn\.textContent\s*=/.test(stripComments(app)));
  assert.ok(ov.includes("setIconLabel(btn, control === 'pause' ? 'pause' : 'play'"));
});

test('collapsible chevrons paint through one helper', () => {
  const src = read('app.js');
  assert.ok(src.includes('function paintGlyph(el, open)'));
  assert.ok(!/glyphEl\.textContent\s*=/.test(stripComments(src)));
  assert.ok(!/\.glyph['"]?\)?\.textContent\s*=/.test(stripComments(src)));
});

test('markdown chrome flashes preserve the icon', () => {
  const src = read('markdown.js');
  assert.ok(src.includes('function paintChromeBtn(btn, icon, text)'));
  assert.ok(!/btn\.textContent\s*=/.test(stripComments(src)), 'chrome still paints bare text');
  assert.ok(src.includes("paintChromeBtn(btn, ok ? 'check' : 'alert'"));
});

test('sanitizer keeps its trust boundary: no svg shapes allowlisted', () => {
  const src = read('markdown.js');
  const tags = src.match(/const ALLOWED_TAGS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(tags, 'ALLOWED_TAGS block not found');
  for (const tag of ['svg', 'path', 'circle', 'rect']) {
    assert.ok(!tags[1].includes(`'${tag}'`), `sanitizer must not allow <${tag}>`);
  }
  // Untrusted model output can never smuggle shapes through; our own icons
  // are rebuilt from the registry after the walk (see below).
  assert.ok(src.includes('decorateChromeIcons(tpl.content)'), 'sanitize tail must decorate');
  assert.ok(src.includes('decorateChromeIcons(fig)'), 'direct-DOM inserts must decorate');
  assert.ok(src.includes('if (btn.querySelector?.(\'svg\')) continue;'), 'decoration must be idempotent');
  assert.ok(src.includes('const svg = iconElement(icon, \'ico\');'), 'decoration must use registry vectors');
});

test('chrome builders are text-only; the pure mapping picks the vector', () => {
  const chrome = codeBlockHtml({ text: 'x', lang: 'js' });
  assert.ok(!chrome.includes('<svg'), 'code button must not bake svg past the sanitizer');
  assert.ok(chrome.includes('>คัดลอก</button>'), 'resting label shape pinned');
  const btns = diagramActionButtonsHtml(true);
  assert.ok(!btns.includes('<svg'), 'diagram buttons must not bake svg past the sanitizer');
  assert.ok(btns.includes('>Mermaid</button>'));
  assert.ok(btns.includes('>SVG</button>'));
  assert.ok(btns.includes('>PNG</button>'));
  assert.ok(!diagramActionButtonsHtml(false).includes('data-dl="mermaid"'));
  assert.equal(chromeRestingIcon({}), 'copy');
  assert.equal(chromeRestingIcon({ dl: 'mermaid' }), 'copy');
  assert.equal(chromeRestingIcon({ dl: 'svg' }), 'download');
  assert.equal(chromeRestingIcon({ dl: 'png' }), 'download');
  assert.ok(isIconName(chromeRestingIcon({ dl: 'svg' })));
  const src = read('markdown.js');
  assert.ok(src.includes('function restingIconFor(btn)'));
});

test('diagram export only ever sees painted content, never toolbar icons', () => {
  const src = read('markdown.js');
  // The lookup is scoped to diagram bodies and excludes toolbar shapes —
  // the old bare querySelector('svg') fallback exported a 16px copy arrow
  // whenever the real diagram was pending, failed, or missing.
  assert.ok(src.includes("card.querySelector('.md-mermaid svg:not(.ico)')"));
  assert.ok(src.includes("card.querySelector('.md-echarts svg:not(.ico)')"));
  assert.ok(!/querySelector\('svg'\)/.test(src), 'bare svg lookup would catch toolbar icons');
  // A missing diagram is an explicit failure: the delegation flash reads
  // result.ok, and the old undefined return fell into the success path.
  const dl = src.slice(src.indexOf('export async function downloadDiagramFromCard'));
  assert.ok(dl.includes('if (!svgEl)'), 'missing-svg guard');
  assert.ok(dl.includes('return { ok: false'), 'missing diagram must report failure');
});

test('interruption markers strip the glyph, mount the vector', () => {
  assert.equal(stripMarkerGlyph(interruptedMarkerText('cancelled')), 'หยุดโดยผู้ใช้');
  assert.equal(stripMarkerGlyph(interruptedMarkerText('watchdog')), 'ระบบหยุดให้ (เงียบเกินเพดาน watchdog)');
  assert.ok(stripMarkerGlyph(interruptedMarkerText('interrupted')).startsWith('host หยุด'));
  assert.equal(stripMarkerGlyph('plain text'), 'plain text');
  const src = read('app.js');
  assert.ok(src.includes('stripMarkerGlyph(interruptedMarkerText(reason))'));
  assert.ok(src.includes("setIcon(ico, reason === 'watchdog' ? 'warn' : 'stop'"));
});

// ------------------------------------------- accessible names + type

test('attach picker swaps labels without erasing its icon', () => {
  const src = read('app.js');
  assert.ok(src.includes("updateIconLabel(btn, 'กำลังเปิด…'"), 'loading state must keep the svg');
  assert.ok(src.includes('updateIconLabel(btn, was)'), 'restore must keep the svg');
  assert.ok(!src.includes("btn.textContent = 'กำลังเปิด…'"), 'loading must not wipe chrome');
  assert.ok(!/btn\.textContent = was;/.test(src), 'restore must not wipe chrome');
});

test('every icon-only button in index.html has an accessible name', () => {
  const html = read('index.html');
  // Text-bearing controls name from their visible dynamic text (title while
  // empty) — a static aria-label would override and hide the real name, so
  // these three must NOT carry one. Icon-only controls keep their labels.
  const DYNAMIC_TEXT = ['goal-bar-btn', 'chat-cwd', 'goal-chip'];
  for (const id of DYNAMIC_TEXT) {
    const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(tag, `${id} button not found`);
    assert.ok(!/aria-label/.test(tag[0]), `${id} must name from visible text, not an override`);
  }
  const bad = [];
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const id = (attrs.match(/id="([^"]+)"/) || [])[1];
    if (DYNAMIC_TEXT.includes(id)) continue; // named by runtime text/title
    const inner = m[2].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    if (inner) continue; // text label present
    if (/aria-label\s*=\s*"[^"]+"/.test(attrs)) continue;
    bad.push(attrs.slice(0, 60));
  }
  assert.equal(bad.length, 0, `nameless buttons: ${bad.join(' | ')}`);
});

test('narrow header wraps: title + actions on line 1, chips below', () => {
  const css = read('style.css');
  const html = read('index.html');
  // Chips/actions grouping exists in markup and is display:contents at
  // wide widths (zero visual change vs the old single row).
  assert.ok(html.includes('<div class="head-chips">'));
  assert.ok(html.includes('<div class="head-actions">'));
  const chipsIdx = html.indexOf('<div class="head-chips">');
  const actionsIdx = html.indexOf('<div class="head-actions">');
  assert.ok(chipsIdx > 0 && chipsIdx < actionsIdx, 'chips group precedes actions group');
  assert.ok(css.includes('.head-chips,\n.head-actions {\n  display: contents;\n}'));
  // The icon-centering rule must follow the buttons into their new group —
  // .head-right > .btn no longer matches anything after the regroup.
  assert.ok(css.includes('.head-actions > .btn.ghost,'), 'action buttons keep centering');
  assert.ok(!css.includes('.head-right > .btn.ghost,'), 'stale direct-child selector');
  // The ≤900px wrap (560px pushed the action buttons out of the viewport):
  // two flex lines, title + actions first, wrapping chips second.
  const mq = css.indexOf('@media (max-width: 900px)');
  assert.ok(mq > 0, 'narrow header breakpoint');
  const block = css.slice(mq, mq + 1400);
  assert.ok(block.includes('flex-wrap: wrap'), 'header must wrap');
  assert.ok(block.includes('.head-right {') && block.includes('display: contents'));
  assert.ok(block.includes('.head-actions {') && block.includes('order: 1'));
  assert.ok(block.includes('flex: 1 1 100%;') && block.includes('order: 2'));
  assert.ok(block.includes('.head-chips .pill {'), 'chips must ellipsise, not push out');
});

test('type ladder keeps its floor, console ratio, and stacks', () => {
  const css = read('style.css');
  const px = (name) => {
    const m = css.match(new RegExp(`${name}:\\s*([\\d.]+)px`));
    assert.ok(m, `${name} token not found`);
    return Number(m[1]);
  };
  assert.equal(px('--fs-caption-1') / px('--fs-body'), 0.75, 'console 3:4 ratio');
  assert.ok(px('--fs-caption-2') >= 11, 'secondary floor must read, not whisper');
  assert.ok(px('--fs-body-sm') >= 13 && px('--fs-body-sm') <= 14, 'controls 13–14px');
  assert.ok(px('--fs-body') >= 14 && px('--fs-body') <= 15, 'body 14–15px');
  assert.equal(px('--fs-headline'), 16, 'headings 16px');
  assert.ok(css.includes('--font-ui:'), 'font stack token');
  assert.ok(css.includes('--font-mono:'), 'mono stack token');
  assert.ok(css.includes('--lh-snug:'), 'line-height tokens');
  assert.ok(css.includes('font-family: var(--font-mono);'), 'mono token is used');
  // Latin faces first, Thai fallback after: Inter must win Latin before
  // Sarabun is ever consulted, and Sarabun must win Thai before system-ui
  // (which on Guix resolves to DejaVu Sans) can capture the Thai range.
  const stack = css.match(/--font-ui:\s*([^;]+);/)[1];
  const at = (f) => stack.indexOf(f);
  assert.ok(at('Inter') > 0 && at('Sarabun') > 0 && at('Thonburi') > 0, 'Inter + Thai faces present');
  assert.ok(at('Inter') < at('Sarabun'), 'Inter must precede Sarabun');
  assert.ok(at('Sarabun') < at('system-ui'), 'Sarabun must precede system-ui');
  // The 10.5px console token belongs to the tool console alone — visible
  // metadata reads at 12px (subhead) and sidebar titles at 13px (body-sm).
  const capUses = [...css.matchAll(/([^{}]+)\{\s*[^}]*?font-size:\s*var\(--fs-caption-1\)/g)]
    .map((m) => m[1].trim().split('\n').pop().trim());
  assert.deepEqual(capUses, ['.tool-body'], `caption-1 leaked: ${capUses.join(', ')}`);
  assert.ok(css.includes('.s-title {\n  font-size: var(--fs-body-sm);'), 'sidebar titles 13px');
  for (const sel of ['.mcp-meta {', '.drill-text {', '.child-live {', '.cwd {']) {
    const i = css.indexOf(sel);
    assert.ok(i > 0, `${sel} not found`);
    assert.ok(css.slice(i, i + 160).includes('var(--fs-subhead)'), `${sel} must read at 12px`);
  }
});

test('sidebar row actions overlay without consuming title width', () => {
  const css = read('style.css');
  // The 230px regression: three 28px in-flow targets squeezed 'Group 1' to
  // 'Gro...'. Actions now float over the row end with zero flex width.
  assert.ok(css.includes('.group-row .group-btn,\n.group-row > .group-menu {\n  position: absolute;'));
  assert.ok(css.includes('.session-item .s-del,\n.session-item > .s-menu {\n  position: absolute;'));
  // At rest the invisible overlay must not swallow title clicks; hover or
  // keyboard focus within the row brings the targets back.
  assert.ok(css.includes('.group-row:focus-within .group-btn'));
  assert.ok(css.includes('.session-item:focus-within .s-del'));
  assert.ok(css.includes('pointer-events: none;'), 'rest must be click-through');
  assert.ok(css.includes('pointer-events: auto;'), 'reveal must restore clicks');
  // Fixed header budget: two 32px squares leave the brand its ~108px.
  assert.ok(css.includes('#new-chat,\n#new-group {\n  width: 32px;\n  height: 32px;'));
});

test('icon CSS system is present with 28px hit areas', () => {
  const css = read('style.css');
  for (const sel of ['svg.ico {', 'svg.ico-sm {', 'svg.ico-lg {', '.ic-label {']) {
    assert.ok(css.includes(sel), `missing ${sel}`);
  }
  assert.ok(css.includes('min-width: 28px;'), 'icon hit area');
  assert.ok(css.includes('min-height: 28px;'), 'icon hit area');
  // The small-button row and goal label keep their vector + ellipsis shape.
  assert.ok(css.includes('.goal-btn .ic-label'), 'goal label ellipsis');
  assert.ok(css.includes('.msg-assistant .md-copy-btn .ico'), 'chrome icon scale');
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
console.log(`icons: ${summary.pass}/${tests.length} passed`);
process.exit(summary.fail ? 1 : 0);
