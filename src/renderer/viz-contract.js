/**
 * Visualize hero contract for the 70% result column.
 * Pure module — safe to import from Node unit tests (no DOM).
 */

/** Target visual budget of the result column (product R9/R14). */
export const VIZ_HERO_RATIO = 0.7;

/** Minimum hero height in viewport units when expanded. */
export const VIZ_HERO_MIN_VH = 55;

/** CSS class applied to hero design boxes. */
export const VIZ_HERO_CLASS = 'md-viz-hero';

/**
 * Product policy: only Mermaid paints in the 70% column (→ SVG).
 * ECharts / chart fences are soft-blocked with a guidance card.
 */
export const VIZ_MERMAID_ONLY = true;

/** CSS class on soft-block cards (echarts rejected). */
export const VIZ_SOFTBLOCK_CLASS = 'md-viz-softblock';

/**
 * @param {string|null|undefined} lang
 * @returns {{ kind: 'mermaid'|'echarts'|'none', hero: boolean, title: string|null }}
 */
export function classifyVizLang(lang) {
  const raw = String(lang || '').trim().toLowerCase();
  if (!raw) return { kind: 'none', hero: false, title: null };

  const parts = raw.split(/[\s,{]+/).filter(Boolean);
  const head = parts[0] || '';
  const flags = new Set(parts.slice(1));
  const heroFlag =
    flags.has('hero') ||
    head.endsWith('-hero') ||
    head === 'grok-viz' ||
    head === 'muse-viz' ||
    head === 'viz' ||
    flags.has('viz');

  if (head === 'mermaid' || head === 'mermaid-hero') {
    return { kind: 'mermaid', hero: heroFlag || head === 'mermaid-hero', title: null };
  }
  if (head === 'echarts' || head === 'echarts-hero' || head === 'chart') {
    return {
      kind: 'echarts',
      hero: false,
      title: null,
    };
  }
  if (head === 'grok-viz' || head === 'muse-viz' || head === 'viz') {
    // body may override type via frontmatter
    return { kind: 'mermaid', hero: true, title: null };
  }
  return { kind: 'none', hero: false, title: null };
}

/**
 * Parse optional grok-viz frontmatter:
 *   type: mermaid|echarts
 *   title: ...
 *   ---
 *   <body>
 *
 * @param {string} text
 * @returns {{ type: 'mermaid'|'echarts', title: string|null, body: string }}
 */
export function parseGrokVizBody(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const sep = raw.match(/^\s*---\s*$/m);
  if (!sep || sep.index === undefined) {
    // no frontmatter — detect echarts JSON
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        JSON.parse(trimmed);
        return { type: 'echarts', title: null, body: trimmed };
      } catch {
        /* fall through as mermaid */
      }
    }
    return { type: 'mermaid', title: null, body: raw };
  }

  const head = raw.slice(0, sep.index);
  const body = raw.slice(sep.index + sep[0].length).replace(/^\n/, '');
  let type = 'mermaid';
  let title = null;
  for (const line of head.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'type') {
      const t = val.toLowerCase();
      if (t === 'echarts' || t === 'chart') type = 'echarts';
      else if (t === 'mermaid' || t === 'diagram') type = 'mermaid';
    } else if (key === 'title') {
      title = val.replace(/^["']|["']$/g, '');
    }
  }
  return { type, title, body };
}

/**
 * Whether markdown source should open a hero visualize treatment.
 * @param {string} src
 */
export function markdownHasVizHero(src) {
  const s = String(src || '');
  if (/<!--\s*(?:grok-viz-hero|muse-viz-hero)\s*-->/i.test(s)) return true;
  if (/^ {0,3}```(?:mermaid-hero|echarts|echarts-hero|chart|grok-viz|muse-viz|viz)\b/im.test(s)) {
    return true;
  }
  if (/^ {0,3}```mermaid[^\n]*\bhero\b/im.test(s)) return true;
  return false;
}

/**
 * Escape HTML text content / attributes (pure).
 * @param {string} s
 */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Soft-block card when agent emits echarts (Mermaid-only policy).
 * @param {string} body
 * @param {string|null} [title]
 */
export function buildEchartsSoftBlockHtml(body, title = null) {
  const titleAttr = title ? ` data-viz-title="${escapeHtml(title)}"` : '';
  const chromeTitle = title
    ? `<span class="md-diagram-title">${escapeHtml(title)}</span>`
    : '';
  const preview = String(body || '').trim();
  const pre = preview
    ? `<pre class="md-mermaid-source md-viz-softblock-source">${escapeHtml(preview.slice(0, 1200))}</pre>`
    : '';
  const fenceHint = escapeHtml('```mermaid-hero');
  return (
    `<figure class="md-diagram ${VIZ_SOFTBLOCK_CLASS}" role="note" aria-label="mermaid only" data-viz-kind="echarts-blocked"${titleAttr}>` +
    `<div class="md-diagram-chrome">` +
    `<span class="md-diagram-label">Mermaid only</span>` +
    chromeTitle +
    `</div>` +
    `<div class="md-viz-softblock-body">` +
    `<p class="md-viz-softblock-msg"><strong>ไม่ paint ECharts</strong> — Desktop แสดงแผนภาพ Mermaid เป็น <strong>SVG</strong> เท่านั้น</p>` +
    `<p class="md-viz-softblock-hint">ใช้ <code class="md-codespan">${fenceHint}</code> (flowchart / sequence / state / mindmap) แล้วปิดด้วย <strong>สรุปคือ</strong></p>` +
    pre +
    `</div>` +
    `</figure>\n`
  );
}

/**
 * Build figure HTML for a visualize fence.
 * @param {{ kind: 'mermaid'|'echarts', hero?: boolean, title?: string|null, body: string, label?: string }} opts
 */
export function buildVizFigureHtml(opts) {
  // Policy: never build a live echarts host when mermaid-only
  if (opts.kind === 'echarts' && VIZ_MERMAID_ONLY) {
    return buildEchartsSoftBlockHtml(opts.body, opts.title || null);
  }

  const kind = opts.kind === 'echarts' ? 'echarts' : 'mermaid';
  const hero = opts.hero === true;
  const title = opts.title || null;
  const label =
    opts.label ||
    (kind === 'echarts' ? 'Chart' : hero ? 'Visualize' : 'Diagram');
  const classes = ['md-diagram'];
  if (hero) classes.push(VIZ_HERO_CLASS);
  classes.push(kind === 'echarts' ? 'md-viz-echarts' : 'md-viz-mermaid');

  const bodyClass = kind === 'echarts' ? 'md-echarts' : 'md-mermaid';
  const aria = kind === 'echarts' ? 'chart' : hero ? 'visualize' : 'diagram';
  const titleAttr = title ? ` data-viz-title="${escapeHtml(title)}"` : '';
  const chromeTitle = title
    ? `<span class="md-diagram-title">${escapeHtml(title)}</span>`
    : '';

  // Per-diagram actions — top-right of chrome. Mermaid diagrams also get a
  // "Copy Mermaid" button whose clipboard payload is a ```mermaid fenced block
  // that pastes into GitLab / gitdop markdown and renders identically.
  // Single source: markdown.js reuses diagramActionButtonsHtml for the same
  // chrome it injects post-sanitize, so the two can never drift apart.
  const dl =
    `<div class="md-diagram-dl" role="group" aria-label="Diagram actions">` +
    diagramActionButtonsHtml(kind === 'mermaid') +
    `</div>`;

  return (
    `<figure class="${classes.join(' ')}" role="figure" aria-label="${aria}" data-viz-kind="${kind}"${titleAttr}>` +
    `<div class="md-diagram-chrome">` +
    `<span class="md-diagram-label">${escapeHtml(label)}</span>` +
    chromeTitle +
    dl +
    `</div>` +
    `<div class="${bodyClass}">${escapeHtml(opts.body)}</div>` +
    `</figure>\n`
  );
}

/**
 * Per-diagram action buttons (copy Mermaid / download SVG / download PNG).
 * Text-only by design — same trust rule as codeBlockHtml: the sanitizer
 * strips all svg, and markdown.js rebuilds the trusted registry icons onto
 * these buttons after sanitization (from data-dl, which survives the walk).
 * Pure — the node suite pins the buttons and their labels.
 * @param {boolean} withMermaid
 * @returns {string}
 */
export function diagramActionButtonsHtml(withMermaid) {
  const copyMermaidBtn = withMermaid
    ? `<button type="button" class="md-diagram-dl-btn md-diagram-copy-btn" data-dl="mermaid" title="คัดลอกเป็น Mermaid (วางใน GitLab / gitdop แล้ว render เหมือนกัน)">Mermaid</button>`
    : '';
  return (
    copyMermaidBtn +
    `<button type="button" class="md-diagram-dl-btn" data-dl="svg" title="Download SVG">SVG</button>` +
    `<button type="button" class="md-diagram-dl-btn" data-dl="png" title="Download PNG (low quality)">PNG</button>`
  );
}

/**
 * Resolve fence language + text into figure HTML, or null if not a viz fence.
 * @param {string} lang
 * @param {string} text
 * @returns {string|null}
 */
export function renderVizFence(lang, text) {
  const rawLang = String(lang || '').trim().toLowerCase();
  const head = (rawLang.split(/[\s,{]+/)[0] || '');

  if (head === 'grok-viz' || head === 'muse-viz' || head === 'viz') {
    const parsed = parseGrokVizBody(text);
    if (parsed.type === 'echarts' && VIZ_MERMAID_ONLY) {
      return buildEchartsSoftBlockHtml(parsed.body, parsed.title);
    }
    return buildVizFigureHtml({
      kind: parsed.type === 'echarts' ? 'echarts' : 'mermaid',
      hero: true,
      title: parsed.title,
      body: parsed.body,
      label: 'Visualize',
    });
  }

  const cls = classifyVizLang(lang);
  if (cls.kind === 'none') return null;

  if (cls.kind === 'echarts') {
    if (VIZ_MERMAID_ONLY) {
      return buildEchartsSoftBlockHtml(String(text || '').trim(), cls.title);
    }
    return buildVizFigureHtml({
      kind: 'echarts',
      hero: true,
      title: cls.title,
      body: String(text || '').trim(),
      label: 'Chart',
    });
  }

  // mermaid / mermaid-hero
  return buildVizFigureHtml({
    kind: 'mermaid',
    hero: cls.hero,
    title: cls.title,
    body: String(text || ''),
    label: cls.hero ? 'Visualize' : 'Diagram',
  });
}

/**
 * After HTML sanitize, mark first mermaid as hero if source requested hero via comment.
 * Operates on a string of HTML (figure tags).
 * @param {string} html
 * @param {string} sourceMd
 */
export function applyHeroFromSourceComment(html, sourceMd) {
  if (!markdownHasVizHero(sourceMd)) return html;
  // If already has hero, leave
  if (html.includes(VIZ_HERO_CLASS)) return html;
  // Promote first md-diagram
  return html.replace(
    'class="md-diagram"',
    `class="md-diagram ${VIZ_HERO_CLASS}"`,
  );
}

/**
 * Validate echarts option JSON (throws on invalid).
 * @param {string} body
 * @returns {object}
 */
export function parseEchartsOption(body) {
  const trimmed = String(body || '').trim();
  if (!trimmed) throw new Error('empty echarts body');
  const opt = JSON.parse(trimmed);
  if (!opt || typeof opt !== 'object' || Array.isArray(opt)) {
    throw new Error('echarts body must be a JSON object');
  }
  return opt;
}

/** Dark palette aligned with Grok Desktop result chrome. */
export const ECHARTS_DARK_PALETTE = [
  '#58a6ff',
  '#a371f7',
  '#3fb950',
  '#d29922',
  '#f85149',
  '#39d353',
  '#79c0ff',
  '#ff7b72',
];

/**
 * Shallow-merge objects; nested plain objects merge one level (axis/title).
 * Agent-provided keys win over defaults.
 * @param {object} base
 * @param {object} over
 */
function mergeShallow(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === 'object' &&
      !Array.isArray(out[k])
    ) {
      out[k] = { ...out[k], ...v };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Apply animate-first dark theme defaults to a raw echarts option.
 * Never overwrites agent-set top-level keys; fills gaps and series polish.
 * Pure — safe for unit tests (no DOM / no echarts runtime).
 *
 * @param {object} raw
 * @returns {object}
 */
export function applyEchartsTheme(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const option = { ...src };

  if (option.backgroundColor === undefined) option.backgroundColor = 'transparent';
  if (option.animation === undefined) option.animation = true;
  if (option.animationDuration === undefined) option.animationDuration = 1200;
  if (option.animationDurationUpdate === undefined) {
    option.animationDurationUpdate = 600;
  }
  if (option.animationEasing === undefined) option.animationEasing = 'cubicOut';
  if (option.animationEasingUpdate === undefined) {
    option.animationEasingUpdate = 'cubicOut';
  }
  if (option.color === undefined) option.color = [...ECHARTS_DARK_PALETTE];

  if (option.textStyle === undefined) {
    option.textStyle = { color: '#e6edf3', fontFamily: 'inherit' };
  } else if (option.textStyle && typeof option.textStyle === 'object') {
    option.textStyle = {
      color: '#e6edf3',
      fontFamily: 'inherit',
      ...option.textStyle,
    };
  }

  if (option.tooltip === undefined) {
    option.tooltip = {
      trigger: 'axis',
      backgroundColor: '#161b22ee',
      borderColor: '#30363d',
      textStyle: { color: '#e6edf3', fontSize: 12 },
    };
  }

  if (option.grid === undefined) {
    option.grid = { left: 48, right: 24, top: 52, bottom: 40, containLabel: true };
  }

  // Title — dark text defaults when object present or missing
  if (option.title === undefined) {
    // leave undefined — agent may omit
  } else if (Array.isArray(option.title)) {
    option.title = option.title.map((t) =>
      t && typeof t === 'object'
        ? mergeShallow(
            { textStyle: { color: '#e6edf3', fontWeight: 600, fontSize: 14 } },
            t,
          )
        : t,
    );
  } else if (option.title && typeof option.title === 'object') {
    option.title = mergeShallow(
      {
        left: 'center',
        textStyle: { color: '#e6edf3', fontWeight: 600, fontSize: 14 },
      },
      option.title,
    );
    if (option.title.textStyle && typeof option.title.textStyle === 'object') {
      option.title.textStyle = {
        color: '#e6edf3',
        fontWeight: 600,
        fontSize: 14,
        ...option.title.textStyle,
      };
    }
  }

  const axisBase = {
    axisLine: { lineStyle: { color: '#30363d' } },
    axisTick: { lineStyle: { color: '#30363d' } },
    axisLabel: { color: '#8b949e' },
    splitLine: { lineStyle: { color: '#21262d' } },
  };

  const polishAxis = (ax) => {
    if (!ax || typeof ax !== 'object') return ax;
    const merged = mergeShallow(axisBase, ax);
    if (ax.axisLabel && typeof ax.axisLabel === 'object') {
      merged.axisLabel = { color: '#8b949e', ...ax.axisLabel };
    }
    if (ax.axisLine && typeof ax.axisLine === 'object') {
      merged.axisLine = mergeShallow(axisBase.axisLine, ax.axisLine);
    }
    if (ax.splitLine === false) {
      merged.splitLine = false;
    } else if (ax.splitLine && typeof ax.splitLine === 'object') {
      merged.splitLine = mergeShallow(axisBase.splitLine, ax.splitLine);
    }
    return merged;
  };

  if (option.xAxis !== undefined) {
    option.xAxis = Array.isArray(option.xAxis)
      ? option.xAxis.map(polishAxis)
      : polishAxis(option.xAxis);
  }
  if (option.yAxis !== undefined) {
    option.yAxis = Array.isArray(option.yAxis)
      ? option.yAxis.map(polishAxis)
      : polishAxis(option.yAxis);
  }

  // Legend
  if (option.legend && typeof option.legend === 'object' && !Array.isArray(option.legend)) {
    option.legend = mergeShallow(
      { textStyle: { color: '#8b949e' } },
      option.legend,
    );
    if (option.legend.textStyle && typeof option.legend.textStyle === 'object') {
      option.legend.textStyle = { color: '#8b949e', ...option.legend.textStyle };
    }
  }

  // Series polish: bar stagger, line smooth, pie scale
  const seriesIn = option.series;
  if (Array.isArray(seriesIn)) {
    option.series = seriesIn.map((s, idx) => {
      if (!s || typeof s !== 'object') return s;
      const type = String(s.type || 'bar').toLowerCase();
      const out = { ...s };

      if (type === 'bar') {
        if (out.animationDelay === undefined) {
          // Stagger bars — function survives setOption in browser; pure tests check presence
          out.animationDelay = (i) => (Number(i) || 0) * 80 + idx * 40;
        }
        if (out.itemStyle === undefined) {
          out.itemStyle = { borderRadius: [6, 6, 0, 0] };
        } else if (typeof out.itemStyle === 'object' && out.itemStyle.borderRadius === undefined) {
          out.itemStyle = { borderRadius: [6, 6, 0, 0], ...out.itemStyle };
        }
        if (out.emphasis === undefined) {
          out.emphasis = { focus: 'series' };
        }
      } else if (type === 'line') {
        if (out.smooth === undefined) out.smooth = true;
        if (out.symbolSize === undefined) out.symbolSize = 6;
        if (out.lineStyle === undefined) out.lineStyle = { width: 2.5 };
        if (out.animationDelay === undefined) {
          out.animationDelay = idx * 120;
        }
        // Soft area when agent didn't set areaStyle and series is single-line friendly
        if (out.areaStyle === undefined && seriesIn.length === 1) {
          out.areaStyle = { opacity: 0.12 };
        }
      } else if (type === 'pie') {
        if (out.animationType === undefined) out.animationType = 'scale';
        if (out.animationEasing === undefined) out.animationEasing = 'cubicOut';
        if (out.radius === undefined) out.radius = ['42%', '68%'];
        if (out.itemStyle === undefined) {
          out.itemStyle = { borderRadius: 6, borderColor: '#0d1117', borderWidth: 2 };
        }
        if (out.label === undefined) {
          out.label = { color: '#c9d1d9', fontSize: 11 };
        } else if (typeof out.label === 'object' && out.label.color === undefined) {
          out.label = { color: '#c9d1d9', fontSize: 11, ...out.label };
        }
      }
      return out;
    });
  }

  return option;
}

/**
 * Ensure visualize / code fences start on their own line.
 *
 * Models often stream a short status sentence then jump into ```mermaid-hero
 * without a newline (e.g. "…แผนภาพ```mermaid-hero"). Markdown only recognizes
 * fences at line start, so the diagram never becomes a code block and the 70%
 * column shows plain text only.
 *
 * Only true **block** fences are normalized: ```lang must be followed by a
 * newline (or EOS). INLINE triple-backtick spans (```code``` mid-line with no
 * newline after the info string) are left untouched (B21).
 *
 * @param {string} md
 * @returns {string}
 */
export function normalizeMarkdownFences(md) {
  let s = String(md ?? '');
  if (!s.includes('```')) return s;
  // Opening block fence glued after text on the same line → insert blank line.
  // Require (?=\s*\n|$) so inline ```span``` (no newline after info) survives.
  s = s.replace(
    /([^\n`])(```(?:mermaid-hero|mermaid|echarts-hero|echarts|chart|grok-viz|muse-viz|viz|[\w+-]*)\b)(?=\s*(?:\n|$))/g,
    '$1\n\n$2',
  );
  // Closing fence glued to last diagram line (less common, still breaks parse)
  s = s.replace(/([^\n`])(```)(\s*$|\s*\n)/g, (full, pre, fence, tail, offset, str) => {
    // only when this looks like a closer (odd fence count before it)
    const before = str.slice(0, offset + pre.length);
    const n = (before.match(/```/g) || []).length;
    if (n % 2 === 1) return `${pre}\n${fence}${tail}`;
    return full;
  });
  return s;
}

/**
 * Symmetric line-start fence walk (B21).
 * Opener and closer both match `^ {0,3}` + 3+ backticks — toggle open state.
 * Returns currently-open fence info string (empty when closed).
 *
 * @param {string} src
 * @returns {{ open: boolean, info: string }}
 */
export function fenceOpenState(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  let open = false;
  let info = '';
  for (const line of lines) {
    const m = line.match(/^( {0,3})(`{3,})(.*)$/);
    if (!m) continue;
    if (!open) {
      open = true;
      info = (m[3] || '').trim();
    } else {
      open = false;
      info = '';
    }
  }
  return { open, info };
}

/**
 * True when a line-start fence is still open (no matching closer yet).
 * Optional `langRe` filters by the open fence's info string (e.g. mermaid).
 *
 * @param {string} src
 * @param {RegExp|null} [langRe]
 * @returns {boolean}
 */
export function hasOpenFence(src, langRe = null) {
  const st = fenceOpenState(src);
  if (!st.open) return false;
  if (!langRe) return true;
  return langRe.test(st.info || '');
}

/**
 * Index into `md` where the stable (complete-block) prefix ends.
 * Complete blocks: closed fences, and paragraphs terminated by a blank line.
 * The trailing incomplete paragraph / open fence is volatile (B23).
 *
 * @param {string} md
 * @returns {number}
 */
export function findStreamingStableEnd(md) {
  const s = String(md ?? '').replace(/\r\n/g, '\n');
  if (!s) return 0;
  const lines = s.split('\n');
  let pos = 0;
  let inFence = false;
  let lastStableEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    const nextPos = isLast ? pos + line.length : pos + line.length + 1;
    const isFence = /^( {0,3})(`{3,})(.*)$/.test(line);

    if (isFence) {
      if (!inFence) {
        inFence = true;
      } else {
        inFence = false;
        // Closed fence block is stable through end of this line (+ newline if any)
        lastStableEnd = nextPos;
      }
    } else if (!inFence) {
      // Blank line outside fence ends the preceding paragraph block
      if (line.trim() === '' && pos > 0) {
        lastStableEnd = nextPos;
      }
    }
    pos = nextPos;
  }
  return lastStableEnd;
}

/**
 * Pure incremental stream plan (B23) — no DOM.
 * Returns how many source chars would be re-parsed this tick.
 *
 * @param {string} prevStableSrc  stable prefix from previous tick
 * @param {string} fullMd         full accumulated markdown (raw, pre-normalize OK)
 * @returns {{ mode: 'tail'|'append'|'full', renderedChars: number, stable: string, volatile: string, nextStableSrc: string }}
 */
export function planIncrementalStreamRender(prevStableSrc, fullMd) {
  const normalized = normalizeMarkdownFences(String(fullMd ?? ''));
  const end = findStreamingStableEnd(normalized);
  const stable = normalized.slice(0, end);
  const volatile = normalized.slice(end);
  const prev = String(prevStableSrc ?? '');
  let mode;
  let renderedChars;
  if (stable === prev) {
    mode = 'tail';
    renderedChars = volatile.length;
  } else if (stable.startsWith(prev)) {
    mode = 'append';
    renderedChars = stable.length - prev.length + volatile.length;
  } else {
    mode = 'full';
    renderedChars = stable.length + volatile.length;
  }
  return { mode, renderedChars, stable, volatile, nextStableSrc: stable };
}

/**
 * Content-budget heuristic: visual fence should appear before long prose.
 * Returns { ok, reason }.
 * @param {string} md
 */
export function checkVisFirst(md) {
  const s = String(md || '');
  const fence = s.search(/^ {0,3}```(?:mermaid|mermaid-hero|echarts|echarts-hero|chart|grok-viz|muse-viz|viz)\b/im);
  if (fence < 0) {
    return { ok: false, reason: 'no-viz-fence' };
  }
  const before = s.slice(0, fence).replace(/<!--[\s\S]*?-->/g, '').trim();
  // allow short title lines before fence (≤ 280 chars, ≤ 4 lines)
  const lines = before ? before.split('\n').filter((l) => l.trim()) : [];
  if (before.length > 280 || lines.length > 4) {
    return { ok: false, reason: 'prose-before-viz' };
  }
  return { ok: true, reason: 'vis-first' };
}
