// Markdown → sanitized HTML for the transcript.
//
// `marked` produces HTML from model output, which is untrusted by definition:
// anything the agent read off the web or out of a file can end up here. So the
// output goes through an allowlist walk before it touches the DOM — tags,
// attributes and URL schemes are opt-in, everything else is dropped.

import { marked } from '/vendor/marked.esm.js';
import {
  chromeRestingIcon,
  codeBlockHtml,
  prepareStreamingMarkdown,
  safeUrl,
  isExternalUrl,
  plainFallbackHtml,
  COPY_OK_TEXT,
  COPY_FAIL_TEXT,
} from './markdown-core.js?v=0.5.1';
import {
  renderVizFence,
  diagramActionButtonsHtml,
  applyHeroFromSourceComment,
  parseEchartsOption,
  applyEchartsTheme,
  markdownHasVizHero,
  hasOpenFence,
  buildEchartsSoftBlockHtml,
  VIZ_HERO_CLASS,
  VIZ_MERMAID_ONLY,
} from './viz-contract.js?v=1.1.1';
import { iconElement } from './icons.js?v=1.0.0';

marked.setOptions({ gfm: true, breaks: true });
// Viz fences (mermaid / mermaid-hero / viz …) become diagram cards, every
// other fence keeps the chrome bar (grok-desktop markdown.js:354-358).
marked.use({
  renderer: {
    code: ({ text, lang }) => renderVizFence(lang, text) || codeBlockHtml({ text, lang }),
  },
});

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'span', 'div', 'button',
  'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'figure', 'figcaption', // diagram cards (see viz-contract.js)
  'input', // task-list checkboxes only (see below)
]);

const ALLOWED_ATTRS = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title']),
  code: new Set(['class']),
  span: new Set(['class']),
  div: new Set(['class', 'data-viz-kind']),
  pre: new Set(['class']),
  button: new Set(['type', 'class', 'data-dl', 'title', 'aria-label']),
  figure: new Set(['class', 'role', 'aria-label', 'data-viz-kind', 'data-viz-title']),
  figcaption: new Set(['class']),
  th: new Set(['align']),
  td: new Set(['align']),
  input: new Set(['type', 'checked', 'disabled']),
};

function safeImgSrc(raw) {
  const v = String(raw || '').trim();
  if (/^https:/i.test(v)) return v;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(v)) return v;
  return null;
}

/** Walk the parsed tree and delete anything not explicitly permitted. */
export function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html ?? '');

  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        continue;
      }
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        // Keep the text, drop the element — a stripped <script> should not
        // take a paragraph of prose with it.
        const text = document.createTextNode(child.textContent || '');
        child.replaceWith(text);
        continue;
      }
      const allowed = ALLOWED_ATTRS[tag] || new Set();
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (!allowed.has(name)) {
          child.removeAttribute(attr.name);
          continue;
        }
        if (tag === 'a' && name === 'href') {
          const url = safeUrl(attr.value);
          if (!url) child.removeAttribute('href');
          else {
            child.setAttribute('href', url);
            // Only web links get a new tab (grok-desktop markdown.js:387) —
            // target=_blank on mailto: or an in-page #anchor is wrong.
            if (isExternalUrl(url)) child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer');
          }
        }
        if (tag === 'img' && name === 'src') {
          const url = safeImgSrc(attr.value);
          if (!url) child.remove();
          else child.setAttribute('src', url);
        }
        if (tag === 'input' && name === 'type' && attr.value.toLowerCase() !== 'checkbox') {
          child.remove();
        }
      }
      if (tag === 'input') child.setAttribute('disabled', 'disabled');
      walk(child);
    }
  };
  walk(tpl.content);

  // Wrap every table in a horizontal scroller so a wide table cannot stretch
  // the transcript column (grok-desktop markdown.js:182-191).
  for (const table of [...tpl.content.querySelectorAll('table')]) {
    if (table.parentElement?.classList?.contains('md-table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'md-table-wrap';
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  }

  // Convert bare mermaid / echarts code fences → diagram cards (fallback path
  // for fences that bypassed the marked renderer — grok markdown.js:193-214).
  const fenceSelectors = [
    'pre > code.language-mermaid',
    'pre > code.language-mermaid-hero',
    'pre > code.language-echarts',
    'pre > code.language-echarts-hero',
    'pre > code.language-chart',
    'pre > code.language-grok-viz',
    'pre > code.language-muse-viz',
    'pre > code.language-viz',
  ];
  for (const sel of fenceSelectors) {
    for (const code of [...tpl.content.querySelectorAll(sel)]) {
      const pre = code.parentElement;
      const lang = (code.className.match(/language-([^\s]+)/) || [])[1] || 'mermaid';
      const figureHtml = renderVizFence(lang, code.textContent || '');
      if (!figureHtml) continue;
      const wrap = document.createElement('div');
      wrap.innerHTML = figureHtml.trim();
      const card = wrap.firstElementChild;
      if (card) pre?.replaceWith(card);
    }
  }

  // Wrap standalone .md-mermaid / .md-echarts in diagram chrome if missing
  // (grok-desktop markdown.js:216-233).
  for (const m of [...tpl.content.querySelectorAll('.md-mermaid, .md-echarts')]) {
    if (m.closest('.md-diagram')) continue;
    const isChart = m.classList.contains('md-echarts');
    const card = document.createElement('figure');
    card.className = isChart ? `md-diagram ${VIZ_HERO_CLASS} md-viz-echarts` : 'md-diagram md-viz-mermaid';
    card.setAttribute('role', 'figure');
    card.setAttribute('aria-label', isChart ? 'chart' : 'diagram');
    card.setAttribute('data-viz-kind', isChart ? 'echarts' : 'mermaid');
    const chrome = document.createElement('div');
    chrome.className = 'md-diagram-chrome';
    chrome.innerHTML =
      `<span class="md-diagram-label">${isChart ? 'Chart' : 'Diagram'}</span>` +
      diagramDownloadChromeHtml();
    m.parentNode?.insertBefore(card, m);
    card.appendChild(chrome);
    card.appendChild(m);
  }

  // Last: rebuild our own trusted chrome icons (code copy, diagram actions)
  // from the closed registry — the only svg that may be in this output.
  decorateChromeIcons(tpl.content);
  return tpl.innerHTML;
}

/**
 * Parse markdown to sanitized HTML. `{ live: true }` runs the streaming
 * stabilizers first (close an unterminated fence so the tail does not render
 * as prose and then snap); a settled/history message is parsed exactly as
 * written — appending a phantom fence to final text would render its trailing
 * prose as code (grok-desktop markdown.js:272).
 */
export function renderMarkdown(text, opts = {}) {
  const src = opts.live ? prepareStreamingMarkdown(text) : String(text ?? '');
  let raw;
  try {
    raw = marked.parse(src);
  } catch {
    // A parser throw inside an SSE handler must not abort the paint — fall
    // back to the escaped source in a pre-wrap block (BUG-041).
    return plainFallbackHtml(text);
  }
  const safe = sanitizeHtml(raw);
  // A <!--muse-viz-hero--> comment promotes the first diagram to hero size
  // (grok-desktop markdown.js:280).
  return applyHeroFromSourceComment(safe, String(text ?? ''));
}

/** Write text to the clipboard with a legacy fallback (WKWebView / non-secure). */
export async function copyTextToClipboard(text) {
  const s = String(text ?? '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Resting icon for a chrome button: its own data-icon first (set by the
 * decoration pass below), else the pure class/data-dl mapping — the same
 * input the sanitizer cannot strip, so the chain restores correctly even on
 * older DOM or foreign markup without the attr.
 */
function restingIconFor(btn) {
  const named = btn?.dataset?.icon;
  if (named) return named;
  return chromeRestingIcon({ dl: btn?.dataset?.dl });
}

/**
 * Rebuild trusted registry icons onto chrome buttons AFTER sanitization.
 * Builders emit text-only buttons — the walk strips every svg, so untrusted
 * model output can never smuggle shapes through the allowlist — and this
 * pass mounts real registry vectors (viewBox intact) onto our own buttons
 * only. Idempotent: buttons already carrying an icon (copy/download
 * flashes, repeat decoration) are skipped. Runs at the end of sanitizeHtml
 * and after every direct-DOM chrome insert.
 */
export function decorateChromeIcons(root) {
  if (!root?.querySelectorAll) return;
  for (const btn of root.querySelectorAll('.md-copy-btn, .md-diagram-dl-btn')) {
    if (btn.querySelector?.('svg')) continue;
    const icon = restingIconFor(btn);
    try {
      btn.setAttribute('data-icon', icon);
    } catch { /* ignore */ }
    const svg = iconElement(icon, 'ico');
    if (svg && btn.insertBefore) btn.insertBefore(svg, btn.firstChild || null);
  }
}

/** Paint a chrome button as icon + text without ever wiping the pair apart. */
function paintChromeBtn(btn, icon, text) {
  if (!btn) return;
  btn.replaceChildren();
  const svg = iconElement(icon, 'ico');
  if (svg) btn.appendChild(svg);
  const label = document.createElement('span');
  label.className = 'ic-label';
  label.textContent = String(text ?? '');
  btn.appendChild(label);
}

/** Flash copy feedback on the button, then restore icon + resting label. */
function flashCopyBtn(btn, ok, restore) {
  const was = restore ?? btn.textContent;
  // The constants keep their leading ✓ (pinned); beside the vector check it
  // would paint twice, so the flash shows the icon + the words only.
  const label = ok ? COPY_OK_TEXT.replace(/^✓\s*/, '') : COPY_FAIL_TEXT; // tofu-ok: strips the constant's pinned prefix
  paintChromeBtn(btn, ok ? 'check' : 'alert', label);
  btn.classList.toggle('is-copied', !!ok);
  setTimeout(() => {
    if (!btn.isConnected) return;
    paintChromeBtn(btn, restingIconFor(btn), was);
    btn.classList.remove('is-copied');
  }, 1300);
}

let codeCopyDelegationInstalled = false;

/**
 * One global click handler for code-block copy buttons
 * (grok-desktop markdown.js:1266-1289). Delegation survives the live repaint,
 * which replaces the whole bubble subtree and would detach any per-node
 * listener — that is why the old decorateCodeBlocks() button could no-op
 * mid-stream. Reads the code from the DOM at click time, so it can never
 * hold a stale snapshot.
 */
export function installCodeCopyDelegation() {
  if (codeCopyDelegationInstalled || typeof document === 'undefined') return;
  codeCopyDelegationInstalled = true;
  document.addEventListener(
    'click',
    (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const btn = t.closest('.md-copy-btn');
      if (!btn) return;
      const block = btn.closest('.md-code-block');
      const codeEl = block?.querySelector('pre code');
      if (!codeEl) return;
      ev.preventDefault();
      ev.stopPropagation();
      const was = btn.textContent;
      void copyTextToClipboard(codeEl.textContent || '').then((ok) =>
        flashCopyBtn(btn, ok, was),
      );
    },
    true,
  );
}

// ------------------------------------------------- diagram runtime
// Mermaid → SVG paint, per-theme palettes, and the SVG/PNG/Mermaid actions —
// ported from grok-desktop markdown.js:405-1372. Deliberately skipped: the
// image-card gallery (R44), the SVG preview popup (dead there — no callers),
// and the native drag payloads (muse has no Swift shell handlers for them).

/** @type {Promise<any> | null} */
let mermaidLoad = null;
/** Theme name mermaid was last initialized for (so we only re-tint on change). */
let mermaidThemeApplied = null;

/** Resolved app theme (moonlight | claude-dark | claude-light | daylight). */
function resolvedAppTheme() {
  try {
    return document.documentElement.getAttribute('data-theme') || 'moonlight';
  } catch {
    return 'moonlight';
  }
}

/**
 * Mermaid init config per app theme. Light themes get a warm paper palette
 * (cream fills, dark ink, terracotta borders); claude-dark keeps warm
 * charcoal nodes; moonlight (and anything unknown) keeps the GitHub-dark
 * look (grok-desktop markdown.js:425-503 + daylight mapped to paper).
 * @param {string} theme
 */
function mermaidConfigFor(theme) {
  const common = {
    startOnLoad: false,
    securityLevel: 'strict',
    fontFamily: 'inherit',
    flowchart: { htmlLabels: false, curve: 'basis' },
  };
  if (theme === 'claude-light' || theme === 'daylight') {
    // Airy paper nodes + dark-brown outlines (matches the code-island redesign).
    return {
      ...common,
      theme: 'base',
      themeVariables: {
        darkMode: false,
        background: '#faf7f2',
        primaryColor: '#f4ecde',
        primaryTextColor: '#33291f',
        primaryBorderColor: '#8f5a33',
        lineColor: '#9a6a45',
        secondaryColor: '#efe4d2',
        secondaryTextColor: '#33291f',
        secondaryBorderColor: '#a5713f',
        tertiaryColor: '#f8f1e6',
        tertiaryTextColor: '#33291f',
        tertiaryBorderColor: '#b98a5a',
        noteBkgColor: '#f7ecd9',
        noteTextColor: '#33291f',
        noteBorderColor: '#c99a63',
        titleColor: '#a14e2f',
        edgeLabelBackground: '#faf7f2',
        clusterBkg: '#f2e9db',
        clusterBorder: '#b98a5a',
      },
    };
  }
  if (theme === 'claude-dark') {
    // Warm charcoal nodes + cream ink + terracotta lines (matches Claude Dark).
    return {
      ...common,
      theme: 'base',
      themeVariables: {
        darkMode: true,
        background: '#1f1e1b',
        primaryColor: '#30302e',
        primaryTextColor: '#f0eee6',
        primaryBorderColor: '#da7756',
        lineColor: '#b98a6a',
        secondaryColor: '#3a3833',
        secondaryTextColor: '#f0eee6',
        secondaryBorderColor: '#c15f3c',
        tertiaryColor: '#262624',
        tertiaryTextColor: '#f0eee6',
        tertiaryBorderColor: '#8a5a3c',
        noteBkgColor: '#33302b',
        noteTextColor: '#f0eee6',
        noteBorderColor: '#c15f3c',
        titleColor: '#e2a07a',
        edgeLabelBackground: '#1f1e1b',
        clusterBkg: '#2a2825',
        clusterBorder: '#8a5a3c',
      },
    };
  }
  // Base dark (cool blue-gray) — GitHub-dark look.
  return {
    ...common,
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: '#0d1117',
      primaryColor: '#1f6feb33',
      primaryTextColor: '#e6edf3',
      primaryBorderColor: '#388bfd',
      lineColor: '#8b949e',
      secondaryColor: '#21262d',
      tertiaryColor: '#161b22',
    },
  };
}

function loadMermaid() {
  if (typeof window !== 'undefined' && window.mermaid) {
    return Promise.resolve(window.mermaid);
  }
  if (mermaidLoad) return mermaidLoad;
  mermaidLoad = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-mermaid-vendor]');
    if (existing && window.mermaid) {
      resolve(window.mermaid);
      return;
    }
    const s = document.createElement('script');
    s.src = '/vendor/mermaid/mermaid.min.js';
    s.async = true;
    s.dataset.mermaidVendor = '1';
    s.onload = () => {
      try {
        const m = window.mermaid;
        if (!m) {
          reject(new Error('mermaid global missing'));
          return;
        }
        const theme = resolvedAppTheme();
        m.initialize(mermaidConfigFor(theme));
        mermaidThemeApplied = theme;
        resolve(m);
      } catch (err) {
        reject(err);
      }
    };
    s.onerror = () => reject(new Error('failed to load mermaid'));
    document.head.appendChild(s);
  });
  return mermaidLoad;
}

/**
 * Re-tint already-rendered mermaid diagrams when the app theme changes.
 * Re-initializes mermaid to the new theme and re-renders every settled diagram
 * from its stashed source. Safe no-op if mermaid isn't loaded or theme is same.
 * @param {string} [theme]
 */
export async function applyMermaidTheme(theme) {
  if (typeof window === 'undefined' || !window.mermaid) return;
  const want = theme || resolvedAppTheme();
  if (mermaidThemeApplied === want) return;
  const mermaid = window.mermaid;
  try {
    mermaid.initialize(mermaidConfigFor(want));
  } catch {
    return;
  }
  mermaidThemeApplied = want;
  const blocks = [...document.querySelectorAll('.md-mermaid[data-rendered="ok"]')];
  for (const el of blocks) {
    const src =
      el.dataset.mermaidSrc ||
      el.closest('.md-diagram')?.dataset.mermaidSrc ||
      '';
    if (!src) continue;
    const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const out = await mermaid.render(id, src);
      const svg = typeof out === 'string' ? out : out?.svg;
      if (!svg) continue;
      el.innerHTML = svg;
      const svgEl = el.querySelector('svg:not(.ico)');
      if (svgEl) {
        svgEl.removeAttribute('height');
        svgEl.style.maxWidth = '100%';
        svgEl.style.height = 'auto';
      }
    } catch {
      /* keep existing SVG on failure */
    }
  }
}

/**
 * Load ECharts once (vendor path, same pattern as mermaid).
 * @returns {Promise<any>}
 */
let echartsLoad = null;
export function loadEcharts() {
  if (typeof window !== 'undefined' && window.echarts) {
    return Promise.resolve(window.echarts);
  }
  if (echartsLoad) return echartsLoad;
  echartsLoad = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-echarts-vendor]');
    if (existing && window.echarts) {
      resolve(window.echarts);
      return;
    }
    const s = document.createElement('script');
    s.src = '/vendor/echarts/echarts.min.js';
    s.async = true;
    s.dataset.echartsVendor = '1';
    s.onload = () => {
      const e = window.echarts;
      if (!e) reject(new Error('echarts global missing'));
      else resolve(e);
    };
    s.onerror = () => reject(new Error('failed to load echarts'));
    document.head.appendChild(s);
  });
  return echartsLoad;
}

/**
 * Paint ```echarts``` hero charts inside a container.
 * @param {ParentNode} root
 */
export async function paintEchartsDiagrams(root) {
  if (!root) return;
  const blocks = [...root.querySelectorAll('.md-echarts:not([data-rendered])')];
  if (!blocks.length) return;

  // B1 soft-block: Mermaid-only policy — never load/paint ECharts
  if (VIZ_MERMAID_ONLY) {
    for (const el of blocks) {
      const src = el.textContent || '';
      el.dataset.rendered = 'blocked';
      const fig = el.closest('.md-diagram');
      const html = buildEchartsSoftBlockHtml(src);
      if (fig) {
        const wrap = document.createElement('div');
        wrap.innerHTML = html.trim();
        const card = wrap.firstElementChild;
        if (card) fig.replaceWith(card);
      } else {
        el.classList.add('md-mermaid-error');
        el.textContent = 'ECharts blocked — use mermaid-hero (SVG)';
      }
    }
    return;
  }

  let echarts;
  try {
    echarts = await loadEcharts();
  } catch (err) {
    for (const el of blocks) {
      el.dataset.rendered = 'error';
      el.classList.add('md-mermaid-error');
      const note = document.createElement('div');
      note.className = 'md-mermaid-fallback';
      note.textContent = 'ECharts failed to load';
      el.replaceChildren(note);
      const fig = el.closest('.md-diagram');
      if (fig) fig.classList.add('is-error');
    }
    return;
  }

  for (const el of blocks) {
    const src = el.textContent || '';
    try {
      const option = applyEchartsTheme(parseEchartsOption(src));

      el.dataset.rendered = '1';
      el.classList.remove('md-mermaid-pending', 'md-mermaid-error');
      el.classList.add('md-echarts-done');
      el.replaceChildren();
      const host = document.createElement('div');
      host.className = 'md-echarts-host';
      el.appendChild(host);

      const fig = el.closest('.md-diagram');
      if (fig) {
        fig.classList.add('is-rendered', VIZ_HERO_CLASS, 'md-viz-echarts');
      }

      const h = fig?.classList.contains(VIZ_HERO_CLASS) ? 'min(62vh, 560px)' : '280px';
      host.style.width = '100%';
      host.style.height = h;

      const chart = echarts.init(host, null, { renderer: 'canvas' });
      chart.setOption(option, { notMerge: true });
      el._echartsInstance = chart;

      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          try { chart.resize(); } catch { /* ignore */ }
        });
        ro.observe(host);
        el._echartsRo = ro;
      }
    } catch (err) {
      el.dataset.rendered = 'error';
      el.classList.add('md-mermaid-error');
      const note = document.createElement('div');
      note.className = 'md-mermaid-fallback';
      note.textContent = `Chart error: ${err.message || err}`;
      const pre = document.createElement('pre');
      pre.className = 'md-mermaid-source';
      pre.textContent = src;
      el.replaceChildren(note, pre);
      const fig = el.closest('.md-diagram');
      if (fig) fig.classList.add('is-error');
    }
  }
}

/**
 * Render mermaid source blocks inside a container.
 * @param {HTMLElement} root
 */
export async function paintMermaidDiagrams(root) {
  if (!root) return;
  ensureDiagramDownloadUi(root);
  const blocks = [...root.querySelectorAll('.md-mermaid:not([data-rendered])')];
  if (!blocks.length) {
    ensureDiagramDownloadUi(root);
    return;
  }

  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch (err) {
    for (const el of blocks) {
      el.classList.add('md-mermaid-error');
      el.dataset.rendered = 'error';
      const note = document.createElement('div');
      note.className = 'md-mermaid-fallback';
      note.textContent = `Mermaid load failed: ${err?.message || err}`;
      el.prepend(note);
    }
    return;
  }

  for (const el of blocks) {
    const src = (el.textContent || '').trim();
    // Stash raw mermaid source before render() replaces textContent with SVG,
    // so the "Copy Mermaid" button can reproduce a GitLab-renderable fence and
    // theme re-tint can re-render from source.
    if (src) {
      el.dataset.mermaidSrc = src;
      const card0 = el.closest('.md-diagram');
      if (card0) card0.dataset.mermaidSrc = src;
    }
    if (!src) {
      el.dataset.rendered = 'empty';
      continue;
    }
    // Incomplete diagram while streaming — keep as source box, don't error hard
    if (el.dataset.pending === '1') {
      el.classList.add('md-mermaid-pending');
      continue;
    }
    const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const out = await mermaid.render(id, src);
      const svg = typeof out === 'string' ? out : out?.svg;
      if (!svg) throw new Error('empty svg');
      el.innerHTML = svg;
      el.dataset.rendered = 'ok';
      el.classList.add('md-mermaid-done');
      el.classList.remove('md-mermaid-pending', 'md-mermaid-error');
      const svgEl = el.querySelector('svg:not(.ico)');
      if (svgEl) {
        svgEl.removeAttribute('height');
        svgEl.style.maxWidth = '100%';
        svgEl.style.height = 'auto';
      }
      const card = el.closest('.md-diagram');
      if (card) card.classList.add('is-rendered');
    } catch (err) {
      el.dataset.rendered = 'error';
      el.classList.add('md-mermaid-error');
      const pre = document.createElement('pre');
      pre.className = 'md-mermaid-source';
      pre.textContent = src;
      const note = document.createElement('div');
      note.className = 'md-mermaid-fallback';
      note.textContent = 'Diagram could not be drawn';
      el.replaceChildren(note, pre);
    }
  }
  // After paint: every rendered/error card still gets download chrome (SVG when available)
  ensureDiagramDownloadUi(root);
}

/** Inline HTML for diagram download controls (chrome top-right). The buttons
 * come from viz-contract's single source — this wrapper only adds the group. */
export function diagramDownloadChromeHtml() {
  return (
    `<div class="md-diagram-dl" role="group" aria-label="Diagram actions">` +
    diagramActionButtonsHtml(true) +
    `</div>`
  );
}

/**
 * Ensure every mermaid/viz diagram figure has SVG/PNG download buttons.
 * Soft-block cards (no SVG) skip. Safe to call repeatedly.
 * @param {ParentNode | null | undefined} root
 */
export function ensureDiagramDownloadUi(root) {
  if (!root?.querySelectorAll) return;
  for (const fig of root.querySelectorAll('.md-diagram')) {
    if (fig.classList.contains('md-viz-softblock')) continue;
    let chrome = fig.querySelector('.md-diagram-chrome');
    if (!chrome) {
      chrome = document.createElement('div');
      chrome.className = 'md-diagram-chrome';
      chrome.innerHTML =
        `<span class="md-diagram-label">Diagram</span>${diagramDownloadChromeHtml()}`;
      fig.insertBefore(chrome, fig.firstChild);
      // Fall through to decorate the fresh text-only buttons below.
    }
    if (!chrome.querySelector('.md-diagram-dl')) {
      const wrap = document.createElement('div');
      wrap.innerHTML = diagramDownloadChromeHtml();
      const dl = wrap.firstElementChild;
      if (dl) chrome.appendChild(dl);
    }
    // Direct-DOM insert, so the sanitize tail never saw it: decorate here
    // (idempotent — figures that already carry icons are skipped).
    decorateChromeIcons(fig);
  }
  installDiagramDownloadDelegation();
}

/**
 * Reliable save: host writes ~/Downloads (works in WKWebView + Brave).
 * Fallbacks: native NSSavePanel → <a download>.
 * @param {string} filename
 * @param {Blob} blob
 * @returns {Promise<{ ok: boolean, mode?: string, path?: string, error?: string }>}
 */
async function triggerBlobDownload(filename, blob) {
  const mime = blob.type || 'application/octet-stream';
  const safeName = String(filename || 'diagram.bin').replace(/[/\\?%*:|"<>]/g, '_');

  // 1) Host API → ~/Downloads + reveal in Finder (most reliable)
  try {
    const isText =
      mime.includes('svg') ||
      mime.includes('text') ||
      mime.includes('xml') ||
      mime.includes('json');
    /** @type {Record<string, unknown>} */
    const body = { filename: safeName, mime, reveal: true };
    if (isText) {
      body.text = await blob.text();
    } else {
      body.base64 = await blobToBase64(blob);
    }
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.ok) {
      console.info('[diagram-dl] saved via host', data.path);
      return { ok: true, mode: 'host-downloads', path: data.path, filename: data.filename };
    }
    console.warn('[diagram-dl] host download failed', data?.error || res.status);
  } catch (err) {
    console.warn('[diagram-dl] host download error', err);
  }

  // 2) Native shell Save panel
  try {
    const handler = window.webkit?.messageHandlers?.diagramSave;
    if (handler?.postMessage) {
      if (mime.includes('svg') || mime.includes('text') || mime.includes('xml')) {
        handler.postMessage({ filename: safeName, text: await blob.text(), mime });
      } else {
        handler.postMessage({ filename: safeName, base64: await blobToBase64(blob), mime });
      }
      return { ok: true, mode: 'native-save' };
    }
  } catch (err) {
    console.warn('[diagram-dl] native save failed', err);
  }

  // 3) Browser <a download>
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeName;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4_000);
    return { ok: true, mode: 'anchor-download' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Serialize SVG element for download (xmlns + dimensions).
 * @param {SVGElement} svgEl
 */
function serializeDiagramSvg(svgEl) {
  const clone = /** @type {SVGElement} */ (svgEl.cloneNode(true));
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  if (!clone.getAttribute('xmlns:xlink')) {
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  }
  // Prefer explicit pixel size for PNG rasterization
  try {
    const box = svgEl.getBBox?.();
    const w =
      Number(svgEl.viewBox?.baseVal?.width) ||
      parseFloat(svgEl.getAttribute('width') || '') ||
      box?.width ||
      svgEl.clientWidth ||
      800;
    const h =
      Number(svgEl.viewBox?.baseVal?.height) ||
      parseFloat(svgEl.getAttribute('height') || '') ||
      box?.height ||
      svgEl.clientHeight ||
      600;
    if (w > 0 && !clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(w)));
    if (h > 0 && !clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(h)));
  } catch { /* getBBox can throw if not in DOM */ }
  return new XMLSerializer().serializeToString(clone);
}

/**
 * Find the primary SVG inside a diagram card.
 * @param {Element} card
 * @returns {SVGElement | null}
 */
/**
 * The exportable diagram SVG inside a card: painted diagram content only.
 * Never the chrome toolbar icons — the old bare-`svg` fallback grabbed the
 * first toolbar vector whenever the real diagram was pending, failed, or
 * missing, and downloads cheerfully exported a 16px copy arrow. Both
 * content containers are scoped and toolbar shapes are excluded outright,
 * so a missing diagram yields null and the download reports failure.
 */
export function diagramSvgInCard(card) {
  return (
    card.querySelector('.md-mermaid svg:not(.ico)') ||
    card.querySelector('.md-echarts svg:not(.ico)') ||
    null
  );
}

/**
 * Ensure SVG string has width/height so rasterizers can measure.
 * @param {string} svgText
 * @param {{ width?: number, height?: number }} [dims]
 */
function prepareSvgForRaster(svgText, dims = {}) {
  let s = String(svgText || '').trim();
  if (!s.includes('xmlns=')) {
    s = s.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  const w = Math.max(1, Math.round(dims.width || 800));
  const h = Math.max(1, Math.round(dims.height || 600));
  if (!/\swidth\s*=/.test(s)) {
    s = s.replace(/<svg\b/i, `<svg width="${w}"`);
  }
  if (!/\sheight\s*=/.test(s)) {
    s = s.replace(/<svg\b/i, `<svg height="${h}"`);
  }
  return s;
}

/**
 * Load SVG string into HTMLImageElement (tries several encodings).
 * Mermaid SVGs with foreignObject often fail as blob: URLs in WebKit.
 * @param {string} svgText
 * @returns {Promise<HTMLImageElement>}
 */
function loadSvgAsImage(svgText) {
  const prepared = prepareSvgForRaster(svgText);
  /** @type {string[]} */
  const urls = [];
  // base64 data URL (most reliable on WebKit for simple SVG)
  try {
    urls.push(
      `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(prepared)))}`,
    );
  } catch { /* ignore */ }
  // percent-encoded data URL
  try {
    urls.push(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(prepared)}`);
  } catch { /* ignore */ }
  // blob URL last
  try {
    urls.push(URL.createObjectURL(new Blob([prepared], { type: 'image/svg+xml;charset=utf-8' })));
  } catch { /* ignore */ }

  const revokeAll = () => {
    for (const u of urls) {
      if (u.startsWith('blob:')) {
        try { URL.revokeObjectURL(u); } catch { /* ignore */ }
      }
    }
  };

  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= urls.length) {
        revokeAll();
        reject(new Error('svg-to-image failed (all strategies)'));
        return;
      }
      const url = urls[i++];
      const img = new Image();
      img.onload = () => {
        revokeAll();
        resolve(img);
      };
      img.onerror = () => tryNext();
      img.src = url;
    };
    tryNext();
  });
}

/**
 * Rasterize SVG text → PNG Blob (low quality).
 * Falls back to host /api/download?rasterize=png when browser cannot draw mermaid SVG.
 * @param {string} svgText
 * @param {{ maxEdge?: number, scale?: number, bg?: string, filename?: string }} [opts]
 * @returns {Promise<Blob>}
 */
async function svgTextToPngBlob(svgText, opts = {}) {
  const prepared = prepareSvgForRaster(svgText);
  try {
    const img = await loadSvgAsImage(prepared);
    const natW = img.naturalWidth || img.width || 800;
    const natH = img.naturalHeight || img.height || 600;
    // If 0×0 (broken measure), force defaults
    const srcW = natW > 1 ? natW : 800;
    const srcH = natH > 1 ? natH : 600;
    const maxEdge = opts.maxEdge ?? 720;
    const scaleCap = opts.scale ?? 0.55;
    const scale = Math.min(scaleCap, maxEdge / Math.max(srcW, srcH, 1));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = opts.bg || '#0d1117';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
        'image/png',
      );
    });
    if (!blob || blob.size < 32) throw new Error('empty png blob');
    return blob;
  } catch (err) {
    // Host rasterize (macOS qlmanage) — works for mermaid foreignObject SVGs
    const fname = (opts.filename || 'diagram.png').replace(/\.svg$/i, '.png');
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: fname,
        text: prepared,
        mime: 'image/svg+xml',
        rasterize: 'png',
        reveal: true,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok || !data.path) {
      throw new Error(
        data?.error || err?.message || 'svg-to-png failed (browser + host)',
      );
    }
    // File already in Downloads — fetch bytes back only if we need Blob;
    // prefer signal success by reading file is not possible from browser.
    // Return a tiny marker blob + attach path for downloadDiagramFromCard.
    const marker = new Blob([`HOST_SAVED:${data.path}`], { type: 'text/plain' });
    marker.__hostPath = data.path;
    marker.__hostFilename = data.filename;
    marker.__alreadySaved = true;
    return marker;
  }
}

/**
 * Blob → base64 (no data: prefix).
 * @param {Blob} blob
 */
async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * @param {Element} card
 * @param {'svg'|'png'} kind
 * @param {{ forceDownload?: boolean }} [opts]
 */
export async function downloadDiagramFromCard(card, kind, opts = {}) {
  const svgEl = diagramSvgInCard(card);
  if (!svgEl) {
    // A missing diagram is a failure, full stop: the delegation flash reads
    // result.ok, and an undefined return used to fall into the success path.
    console.warn('[diagram-dl] no diagram SVG in card');
    return { ok: false, error: 'no diagram to export yet' };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const label =
    (card.getAttribute('data-viz-title') ||
      card.querySelector('.md-diagram-title')?.textContent ||
      card.querySelector('.md-diagram-label')?.textContent ||
      'diagram')
      .trim()
      .replace(/[^\w\u0E00-\u0E7F.-]+/g, '_')
      .slice(0, 40) || 'diagram';
  const base = `${label}_${stamp}`;
  const svgText = serializeDiagramSvg(svgEl);

  if (kind === 'svg') {
    return triggerBlobDownload(
      `${base}.svg`,
      new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }),
    );
  }

  // PNG low quality — browser canvas first; host qlmanage if mermaid SVG won't load as Image
  const rect = svgEl.getBoundingClientRect?.();
  const prepared = prepareSvgForRaster(svgText, {
    width: rect?.width || svgEl.clientWidth || 800,
    height: rect?.height || svgEl.clientHeight || 600,
  });
  const blob = await svgTextToPngBlob(prepared, {
    filename: `${base}_lq.png`,
    maxEdge: 720,
    scale: 0.55,
  });
  // Host already wrote PNG to Downloads (mermaid SVG could not use canvas Image)
  if (blob?.__alreadySaved && blob.__hostPath) {
    try {
      await fetch('/api/download/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: blob.__hostPath }),
      });
    } catch { /* ignore */ }
    return {
      ok: true,
      mode: 'host-raster-png',
      path: blob.__hostPath,
      filename: blob.__hostFilename,
    };
  }
  return triggerBlobDownload(`${base}_lq.png`, blob);
}

/**
 * Recover the raw Mermaid source for a diagram card. Prefers the stashed
 * dataset (set before render swaps in SVG); falls back to the still-unrendered
 * source text node.
 * @param {Element} card
 * @returns {string}
 */
function mermaidSourceFromCard(card) {
  if (!card) return '';
  if (card.dataset && card.dataset.mermaidSrc) return card.dataset.mermaidSrc;
  const body = card.querySelector('.md-mermaid');
  if (body?.dataset?.mermaidSrc) return body.dataset.mermaidSrc;
  // Not yet rendered → the text node still holds the source
  if (body && body.dataset?.rendered !== 'ok' && !body.querySelector('svg:not(.ico)')) {
    return (body.textContent || '').trim();
  }
  return '';
}

let diagramDlDelegationInstalled = false;

/** One global click handler for all diagram action buttons (copy / download). */
export function installDiagramDownloadDelegation() {
  if (diagramDlDelegationInstalled || typeof document === 'undefined') return;
  diagramDlDelegationInstalled = true;
  document.addEventListener(
    'click',
    (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const btn = t.closest('.md-diagram-dl-btn');
      if (!btn) return;
      const card = btn.closest('.md-diagram');
      if (!card) return;
      ev.preventDefault();
      ev.stopPropagation();

      // Copy Mermaid → clipboard as a GitLab-renderable ```mermaid fence.
      if (btn.getAttribute('data-dl') === 'mermaid') {
        const src = mermaidSourceFromCard(card).trim();
        const was = btn.textContent;
        if (!src) {
          flashCopyBtn(btn, false, was);
          return;
        }
        const fence = '```mermaid\n' + src + '\n```\n';
        void copyTextToClipboard(fence).then((ok) => flashCopyBtn(btn, ok, was));
        return;
      }

      const kind = btn.getAttribute('data-dl') === 'png' ? 'png' : 'svg';
      const was = btn.textContent;
      const restLabel = was || (kind === 'png' ? 'PNG' : 'SVG');
      const restore = () => {
        if (btn.isConnected) paintChromeBtn(btn, 'download', restLabel);
      };
      btn.disabled = true;
      paintChromeBtn(btn, 'ellipsis', '…');
      void downloadDiagramFromCard(card, kind)
        .then((result) => {
          if (result?.ok === false) {
            btn.title = result.error || 'download failed';
            paintChromeBtn(btn, 'alert', '! ลองใหม่');
            setTimeout(restore, 1200);
            return;
          }
          const where = result?.filename || result?.path?.split?.('/')?.pop?.() || 'Downloads';
          btn.title = result?.path
            ? `บันทึกแล้ว: ${result.path}`
            : `บันทึกแล้ว (${result?.mode || 'ok'})`;
          paintChromeBtn(btn, 'check', 'บันทึกแล้ว');
          // Brief toast via title + label
          console.info('[diagram-dl] ok', result);
          setTimeout(restore, 1400);
          // Optional: surface path in status bar if present
          try {
            const pill = document.getElementById('status-pill');
            if (pill && result?.path) {
              const prev = pill.title;
              pill.title = `ดาวน์โหลด: ${where}`;
              setTimeout(() => {
                pill.title = prev || '';
              }, 4000);
            }
          } catch { /* ignore */ }
        })
        .catch((err) => {
          console.error('[diagram-dl]', err);
          btn.title = err?.message || 'download failed';
          paintChromeBtn(btn, 'alert', '! ลองใหม่');
          setTimeout(restore, 1200);
        })
        .finally(() => {
          btn.disabled = false;
        });
    },
    true,
  );
}

/**
 * @param {HTMLElement} el
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function waitForConnected(el, timeoutMs) {
  if (el?.isConnected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (el.isConnected) {
        resolve(true);
        return;
      }
      if (Date.now() - t0 >= timeoutMs) {
        resolve(false);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/**
 * Paint diagrams for a freshly-set innerHTML bubble (grok-desktop
 * markdown.js:1917-1963, minus the image-card gallery muse does not have).
 * Waits briefly for attach (history/ix nodes are painted before append), then:
 * settle → paint all; live → incomplete viz fence stays a source box, a
 * completed fence paints without waiting for turn end.
 * @param {HTMLElement} bodyEl
 * @param {string} src  markdown source that produced the HTML
 * @param {{ live?: boolean }} [opts]
 */
export async function paintMarkdownDiagrams(bodyEl, src, opts = {}) {
  if (!bodyEl) return;
  const live = !!opts.live;
  const raw = String(src ?? '');

  if (!bodyEl.isConnected) {
    const ok = await waitForConnected(bodyEl, 800);
    if (!ok) {
      // Still detached — last-chance rAF pair (host may append this frame)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
  }
  if (!bodyEl.isConnected) return;

  if (markdownHasVizHero(raw)) {
    bodyEl.classList.add('has-viz-hero');
  }

  if (!live) {
    await paintMermaidDiagrams(bodyEl);
    await paintEchartsDiagrams(bodyEl);
    ensureDiagramDownloadUi(bodyEl);
    return;
  }

  // Symmetric fence walk (B21): openers and closers counted the same way.
  // Mark incomplete viz fences softly (prepareStreaming may have closed artificially).
  const openInSource = hasOpenFence(
    raw,
    /^(?:mermaid-hero|mermaid|echarts-hero|echarts|chart|grok-viz|muse-viz|viz)\b/i,
  );
  if (openInSource) {
    for (const el of bodyEl.querySelectorAll(
      '.md-mermaid:not([data-rendered]), .md-echarts:not([data-rendered])',
    )) {
      el.dataset.pending = '1';
      el.classList.add('md-mermaid-pending');
    }
    ensureDiagramDownloadUi(bodyEl);
  } else {
    // Complete mermaid in stream — paint without waiting for turn end
    await paintMermaidDiagrams(bodyEl);
    await paintEchartsDiagrams(bodyEl);
    ensureDiagramDownloadUi(bodyEl);
  }
}
