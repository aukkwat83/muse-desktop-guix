#!/usr/bin/env node
// Visualize contract (src/renderer/viz-contract.js — pure, no DOM): fence
// language routing, figure/soft-block HTML, hero promotion, and the fence
// walks the live diagram paint relies on. Ported with grok-desktop's module;
// the muse-viz alias is the only deliberate extension.

import assert from 'node:assert/strict';

import {
  VIZ_HERO_CLASS,
  VIZ_MERMAID_ONLY,
  VIZ_SOFTBLOCK_CLASS,
  applyHeroFromSourceComment,
  buildEchartsSoftBlockHtml,
  buildVizFigureHtml,
  checkVisFirst,
  classifyVizLang,
  escapeHtml,
  fenceOpenState,
  findStreamingStableEnd,
  hasOpenFence,
  markdownHasVizHero,
  normalizeMarkdownFences,
  parseGrokVizBody,
  planIncrementalStreamRender,
  renderVizFence,
} from '../src/renderer/viz-contract.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('mermaid-only policy is on', () => {
  assert.equal(VIZ_MERMAID_ONLY, true);
});

test('classifyVizLang routes fence languages', () => {
  assert.deepEqual(classifyVizLang('mermaid'), { kind: 'mermaid', hero: false, title: null });
  assert.deepEqual(classifyVizLang('mermaid hero'), { kind: 'mermaid', hero: true, title: null });
  assert.deepEqual(classifyVizLang('mermaid-hero'), { kind: 'mermaid', hero: true, title: null });
  assert.deepEqual(classifyVizLang('echarts'), { kind: 'echarts', hero: false, title: null });
  assert.deepEqual(classifyVizLang('chart'), { kind: 'echarts', hero: false, title: null });
  assert.deepEqual(classifyVizLang('viz'), { kind: 'mermaid', hero: true, title: null });
  assert.deepEqual(classifyVizLang('grok-viz'), { kind: 'mermaid', hero: true, title: null });
  assert.deepEqual(classifyVizLang('muse-viz'), { kind: 'mermaid', hero: true, title: null });
  assert.deepEqual(classifyVizLang('js'), { kind: 'none', hero: false, title: null });
  assert.deepEqual(classifyVizLang(''), { kind: 'none', hero: false, title: null });
  assert.deepEqual(classifyVizLang(null), { kind: 'none', hero: false, title: null });
});

test('renderVizFence builds a mermaid figure with actions', () => {
  const html = renderVizFence('mermaid', 'graph TD\n  A-->B');
  assert.ok(html.includes('class="md-diagram md-viz-mermaid"'));
  assert.ok(html.includes('data-viz-kind="mermaid"'));
  assert.ok(html.includes('<div class="md-mermaid">'));
  assert.ok(html.includes('A--&gt;B'));
  assert.ok(html.includes('data-dl="mermaid"'));
  assert.ok(html.includes('data-dl="svg"'));
  assert.ok(html.includes('data-dl="png"'));
  // Text-only by trust design: the sanitizer strips all svg, and markdown.js
  // rebuilds the registry icons onto these buttons after the walk — the
  // buttons must carry readable labels and no baked shapes or glyphs.
  assert.ok(html.includes('>Mermaid</button>'));
  assert.ok(html.includes('>SVG</button>'));
  assert.ok(html.includes('>PNG</button>'));
  assert.ok(!html.includes('<svg'), 'no baked svg past the sanitizer');
  assert.ok(!html.includes(VIZ_HERO_CLASS));
});

test('renderVizFence hero variants get the hero class + Visualize label', () => {
  for (const lang of ['mermaid-hero', 'mermaid hero', 'viz', 'grok-viz', 'muse-viz']) {
    const html = renderVizFence(lang, 'graph TD\n  A-->B');
    assert.ok(html.includes(VIZ_HERO_CLASS), lang);
    assert.ok(html.includes('>Visualize<'), lang);
  }
});

test('renderVizFence soft-blocks echarts under the policy', () => {
  const html = renderVizFence('echarts', '{"series":[]}');
  assert.ok(html.includes(VIZ_SOFTBLOCK_CLASS));
  assert.ok(html.includes('ไม่ paint ECharts'));
  // No live paint host — only the static source preview (md-mermaid-source).
  assert.ok(!html.includes('<div class="md-mermaid">'));
  assert.ok(!html.includes('md-viz-mermaid'));
});

test('renderVizFence returns null for non-viz languages', () => {
  assert.equal(renderVizFence('js', 'x'), null);
  assert.equal(renderVizFence('', 'x'), null);
});

test('renderVizFence escapes titles and parses viz frontmatter', () => {
  const html = renderVizFence('muse-viz', 'title: "A<B>"\n---\ngraph TD\n  A-->B');
  assert.ok(html.includes('data-viz-title="A&lt;B&gt;"'));
  assert.ok(html.includes('<span class="md-diagram-title">A&lt;B&gt;</span>'));
  assert.ok(html.includes('A--&gt;B'));
});

test('viz frontmatter type echarts soft-blocks', () => {
  const html = renderVizFence('viz', 'type: echarts\n---\n{}');
  assert.ok(html.includes(VIZ_SOFTBLOCK_CLASS));
});

test('parseGrokVizBody detects bare echarts JSON', () => {
  assert.deepEqual(parseGrokVizBody('{"a":1}'), { type: 'echarts', title: null, body: '{"a":1}' });
  assert.deepEqual(parseGrokVizBody('graph TD'), { type: 'mermaid', title: null, body: 'graph TD' });
});

test('soft-block card caps the source preview', () => {
  const html = buildEchartsSoftBlockHtml('x'.repeat(5000), 'T');
  assert.ok(html.includes('data-viz-title="T"'));
  assert.ok(!html.includes('x'.repeat(2000)));
});

test('buildVizFigureHtml never builds live echarts under the policy', () => {
  const html = buildVizFigureHtml({ kind: 'echarts', body: '{}' });
  assert.ok(html.includes(VIZ_SOFTBLOCK_CLASS));
});

test('escapeHtml covers attributes', () => {
  assert.equal(escapeHtml('a<b>"c"&'), 'a&lt;b&gt;&quot;c&quot;&amp;');
});

test('markdownHasVizHero sees comments and hero fences', () => {
  assert.equal(markdownHasVizHero('<!--muse-viz-hero-->\ntext'), true);
  assert.equal(markdownHasVizHero('<!-- grok-viz-hero -->'), true);
  assert.equal(markdownHasVizHero('```mermaid-hero\nx\n```'), true);
  assert.equal(markdownHasVizHero('```mermaid hero\nx\n```'), true);
  assert.equal(markdownHasVizHero('```viz\nx\n```'), true);
  assert.equal(markdownHasVizHero('```mermaid\nx\n```'), false);
  assert.equal(markdownHasVizHero('plain'), false);
});

test('applyHeroFromSourceComment promotes the first diagram once', () => {
  const html = '<figure class="md-diagram">a</figure><figure class="md-diagram">b</figure>';
  const out = applyHeroFromSourceComment(html, '<!--muse-viz-hero-->');
  assert.equal(out.match(new RegExp(VIZ_HERO_CLASS, 'g')).length, 1);
  assert.ok(out.startsWith(`<figure class="md-diagram ${VIZ_HERO_CLASS}">`));
  assert.equal(applyHeroFromSourceComment(html, 'plain'), html);
  assert.equal(applyHeroFromSourceComment(out, '<!--muse-viz-hero-->'), out);
});

test('fenceOpenState toggles symmetrically', () => {
  assert.deepEqual(fenceOpenState('```js\nx\n```'), { open: false, info: '' });
  assert.deepEqual(fenceOpenState('```mermaid\nx'), { open: true, info: 'mermaid' });
  assert.deepEqual(fenceOpenState('   ```js\nx'), { open: true, info: 'js' });
  assert.deepEqual(fenceOpenState('no fences'), { open: false, info: '' });
});

test('hasOpenFence filters by info string', () => {
  assert.equal(hasOpenFence('```mermaid\nx'), true);
  assert.equal(hasOpenFence('```mermaid\nx', /^mermaid\b/), true);
  assert.equal(hasOpenFence('```js\nx', /^mermaid\b/), false);
  assert.equal(hasOpenFence('```mermaid\nx\n```'), false);
});

test('normalizeMarkdownFences un-glues block fences, keeps inline spans', () => {
  assert.equal(
    normalizeMarkdownFences('แผนภาพ```mermaid\nx\n```'),
    'แผนภาพ\n\n```mermaid\nx\n```',
  );
  assert.equal(normalizeMarkdownFences('use ```code``` here'), 'use ```code``` here');
  assert.equal(normalizeMarkdownFences('no fences'), 'no fences');
});

test('streaming stable-end splits complete blocks from the tail', () => {
  const md = 'para one.\n\n```mermaid\nA-->B\n```\n\ntail here';
  const end = findStreamingStableEnd(md);
  assert.equal(md.slice(end), 'tail here');
  assert.equal(findStreamingStableEnd(''), 0);
});

test('planIncrementalStreamRender re-renders the tail only when stable', () => {
  const full = 'para one.\n\ntail here';
  const first = planIncrementalStreamRender('', full);
  assert.equal(first.mode, 'append');
  const second = planIncrementalStreamRender(first.nextStableSrc, full);
  assert.equal(second.mode, 'tail');
  assert.equal(second.renderedChars, 'tail here'.length);
});

test('checkVisFirst wants the fence before long prose', () => {
  assert.deepEqual(checkVisFirst('# T\n```mermaid\nx\n```'), { ok: true, reason: 'vis-first' });
  assert.deepEqual(checkVisFirst('plain'), { ok: false, reason: 'no-viz-fence' });
  assert.deepEqual(checkVisFirst(`${'x'.repeat(300)}\n\`\`\`mermaid\nx\n\`\`\``), {
    ok: false,
    reason: 'prose-before-viz',
  });
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}
console.log(`viz-contract: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
