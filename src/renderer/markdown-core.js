// Pure markdown helpers — no DOM, no vendor imports, so the unit suite can
// load this file straight into Node (same pattern as turn-view.js).
// markdown.js wires these into marked + the sanitizer.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Copy-button feedback (BUG-035). UI strings are Thai; the constants live
// here so the unit suite can pin them without loading the DOM module.
export const COPY_OK_TEXT = '✓ คัดลอกแล้ว'; // tofu-ok: pinned constant, flash paints icon + words
export const COPY_FAIL_TEXT = '! ลองใหม่';

/**
 * Link policy (grok-desktop markdown.js:65-70): web schemes plus site-relative
 * (`/…`) and in-page anchor (`#…`) links — the old https?/mailto-only rule
 * silently killed both.
 */
export function safeUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  if (/^(https?:|mailto:|\/|#)/i.test(v)) return v;
  return null;
}

/** Only real web links open in a new tab — mailto/anchor would be nonsense. */
export function isExternalUrl(url) {
  return /^https?:/i.test(url);
}

/**
 * Plain-text fallback for when marked.parse throws
 * (grok-desktop markdown.js:274-282 + .md-plain). The escaped source in a
 * pre-wrap div is always better than an aborted SSE paint.
 */
export function plainFallbackHtml(text) {
  return `<div class="md-plain">${escapeHtml(String(text ?? ''))}</div>`;
}

/**
 * Chrome-wrapped code block (grok-desktop markdown.js:355-373): language
 * label + a whole-block copy button in a bar above the <pre>. The button is
 * wired by one delegated handler (installCodeCopyDelegation), never per node,
 * so live repaints that replace the subtree cannot detach the listener.
 */
export function codeBlockHtml({ text, lang }) {
  const langKey = String(lang || '').trim().toLowerCase();
  const cls = langKey ? ` class="language-${escapeHtml(langKey)}"` : '';
  // Text-only by design: the sanitizer strips ALL svg (untrusted model
  // output must never smuggle shapes through), and markdown.js rebuilds the
  // trusted registry icon onto this button after sanitization. The resting
  // `>คัดลอก</button>` shape is pinned; the flash swaps icon + text together.
  return (
    `<div class="md-code-block">` +
    `<div class="md-code-chrome">` +
    `<span class="md-code-label">${escapeHtml(langKey || 'code')}</span>` +
    `<button type="button" class="md-copy-btn" title="คัดลอกโค้ดทั้งบล็อก" aria-label="คัดลอกโค้ดทั้งบล็อก">คัดลอก</button>` +
    `</div>` +
    `<pre class="md-pre"><code${cls}>${escapeHtml(text)}</code></pre>` +
    `</div>\n`
  );
}

/**
 * Which registry icon a chrome button carries, from its trusted class /
 * data-dl alone — the input the sanitizer cannot strip. Code copy and
 * Mermaid copy share the copy vector; SVG/PNG downloads share download.
 * Pure — the node suite pins the mapping.
 * @param {{ dl?: string|null }} [opts]
 * @returns {string} icons.js registry name
 */
export function chromeRestingIcon({ dl = null } = {}) {
  if (dl === 'svg' || dl === 'png') return 'download';
  return 'copy';
}

/**
 * Symmetric line-start fence walk (grok-desktop viz-contract.js:552-568).
 * Opener and closer both match CommonMark's `^ {0,3}` + 3+ backticks — the
 * old `/^```/gm` count missed indented fences, so a settled message whose
 * fences were genuinely unbalanced got a phantom ``` appended.
 */
export function fenceOpenState(src) {
  const lines = String(src ?? '').replace(/\r\n/g, '\n').split('\n');
  let open = false;
  for (const line of lines) {
    if (!/^( {0,3})(`{3,})/.test(line)) continue;
    open = !open;
  }
  return { open };
}

/**
 * Close an unterminated code fence before parsing.
 * Mid-stream the text almost always ends inside a fence; without this the
 * whole remainder of the message renders as a paragraph and then snaps into a
 * code block when the closing fence arrives — a very visible flicker.
 */
export function balanceFences(text) {
  const src = String(text ?? '');
  if (fenceOpenState(src).open) return `${src}\n\`\`\``;
  return src;
}

/**
 * Un-glue fences that arrived fused to neighbouring text mid-stream
 * (grok-desktop viz-contract.js:524-542). `text```js` would otherwise render
 * as a run of inline code and then snap into a block when the newline
 * arrives. Only true block fences are touched: the info string must be
 * followed by a newline (or EOS), so inline ```span``` survives.
 */
export function normalizeMarkdownFences(md) {
  let s = String(md ?? '');
  if (!s.includes('```')) return s;
  // Opening fence glued after text on the same line → insert a blank line.
  s = s.replace(/([^\n`])(```[\w+-]*\b)(?=\s*(?:\n|$))/g, '$1\n\n$2');
  // Closing fence glued to the last code line → own line, but only when it is
  // actually a closer (odd fence count before it).
  s = s.replace(/([^\n`])(```)(\s*$|\s*\n)/g, (full, pre, fence, tail, offset, str) => {
    const before = str.slice(0, offset + pre.length);
    const n = (before.match(/```/g) || []).length;
    if (n % 2 === 1) return `${pre}\n${fence}${tail}`;
    return full;
  });
  return s;
}

/**
 * Stabilize incomplete markdown while tokens are still arriving
 * (grok-desktop markdown.js:245-261). Live path only — a settled message is
 * parsed exactly as written, phantom fences and all.
 */
export function prepareStreamingMarkdown(src) {
  if (!src) return '';
  let s = normalizeMarkdownFences(String(src).replace(/\r\n/g, '\n'));
  s = balanceFences(s);
  // Soft-close an open HTML comment so the rest of the stream is not
  // swallowed into it.
  if ((s.match(/<!--/g) || []).length > (s.match(/-->/g) || []).length) {
    s += ' -->';
  }
  return s;
}
