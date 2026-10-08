// Shared icon family — the ONE vector set behind every UI-owned glyph.
//
// Why this exists: the UI used to paint its chrome with Unicode symbols
// (◗ ＋ ▤ ◐ ⌕ ⏻ ▦ ☰ ✳ ⏳ 📎 ◎ ⧉ ⟳ ⋮⋮ …). On Guix the Thai/Latin fonts in
// the stack do not cover most of those codepoints, so buttons rendered as
// tofu squares — and every surface picked a different symbol for the same
// verb. Every icon below is a hand-drawn 24px-viewBox stroke glyph in one
// rounded style (stroke ≈1.8, round caps/joins, currentColor), rendered at
// 16px for dense UI, 18px in roomier buttons, 20px for prominent controls.
//
// Two render paths, one registry:
//   - live DOM: icon() / setIcon() / setIconLabel() build real SVG nodes;
//   - known-safe HTML strings: iconSvgString() / iconLabelHtml() for chrome
//     that must be a string (markdown code/diagram bars, attach chips).
// Static HTML (index.html) and CSS mask data-URIs (pseudo-element markers)
// duplicate shapes by hand — unit-test-icons.mjs extracts those copies and
// fails when any drifts from this registry, so the copies cannot rot.
//
// Security: names are a closed vocabulary. Unknown names (and anything that
// is not a strict [A-Za-z0-9 _-] CSS class) resolve to '' / null — caller
// text is NEVER interpolated into SVG markup. Labels go through esc().
//
// Pure module: no top-level DOM touch, safe to import from Node unit tests.

/** Stroke width shared by every outline glyph (the 1.7–1.9 band). */
export const ICON_STROKE = 1.8;

/** 24px grid every glyph is drawn on. */
export const ICON_VIEWBOX = '0 0 24 24';

/**
 * name → inner SVG markup (paths/circles/rects only — no <a>, <image>,
 * <script>, <style>, no event attrs, so the shapes stay inert even inside
 * sanitized markdown chrome). Filled accents override per element with
 * fill="currentColor" stroke="none"; the <svg> root carries the stroke.
 */
const ICONS = {
  // The ◗-like brand seed: a ring with its top-right quarter filled.
  brand: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5A8.5 8.5 0 0 1 20.5 12H12Z" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  circle: '<circle cx="12" cy="12" r="6"/>',
  chevUp: '<path d="M6 14.5l6-6 6 6"/>',
  chevDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevLeft: '<path d="M14.5 6l-6 6 6 6"/>',
  chevRight: '<path d="M9.5 6l6 6-6 6"/>',
  arrowUp: '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>',
  arrowRight: '<path d="M5 12h14M12.5 5.5L19 12l-6.5 6.5"/>',
  arrowDown: '<path d="M12 5v14M5.5 12.5L12 19l6.5-6.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  power: '<path d="M12 4v8"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
  panel: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.5 4v16"/>',
  contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>',
  moonFilled: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19"/>',
  cup: '<path d="M5 9.5h11V14a5 5 0 0 1-5 5H9.5a4.5 4.5 0 0 1-4.5-4.5Z"/><path d="M16 10.5h1.3a2.4 2.4 0 0 1 0 4.8H16"/><path d="M8.5 3.5c0 1-1 1-1 2M12.5 3.5c0 1-1 1-1 2"/>',
  clip: '<path d="M20.5 11.5l-8.8 8.8a5.5 5.5 0 0 1-7.8-7.8l8.2-8.2a3.7 3.7 0 0 1 5.2 5.2l-8.2 8.2a1.9 1.9 0 0 1-2.7-2.7l8-8"/>',
  file: '<path d="M6 3.5h7l4 4v13H6Z"/><path d="M13 3.5V8h4"/>',
  folder: '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h5l2 2.5h7A1.5 1.5 0 0 1 20.5 9v9.5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18.5Z"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17.5l4.5-4.5 3 3 3.5-3.5 4 4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  // The ✳/◈-like agent marker: a filled four-point spark, one shape for
  // both transcript markers (they meant the same thing: "agent work here").
  spark: '<path d="M12 3.5c.7 4.6 2.9 6.8 7.5 7.5-4.6.7-6.8 2.9-7.5 7.5-.7-4.6-2.9-6.8-7.5-7.5 4.6-.7 6.8-2.9 7.5-7.5Z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.5v13l10-6.5Z" fill="currentColor" stroke="currentColor" stroke-linejoin="round"/>',
  pause: '<rect x="7" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.4" y="5.5" width="3.6" height="13" rx="1.2" fill="currentColor" stroke="none"/>',
  refresh: '<path d="M15.5 9H21V3.5"/><path d="M20 15a8.5 8.5 0 1 1-2.1-8.9L21 9"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5.5A1.5 1.5 0 0 1 4 13.5v-9A1.5 1.5 0 0 1 5.5 3h9A1.5 1.5 0 0 1 16 4.5V6"/>',
  popout: '<path d="M14 4.5H5.5A1.5 1.5 0 0 0 4 6v12.5A1.5 1.5 0 0 0 5.5 20H18a1.5 1.5 0 0 0 1.5-1.5V14"/><path d="M13.5 4H20v6.5"/><path d="M20 4L10.5 13.5"/>',
  download: '<path d="M12 4v11M6.5 11L12 16.5 17.5 11"/><path d="M4.5 20h15"/>',
  ellipsis: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  warn: '<path d="M12 4L21 20H3Z"/><path d="M12 10v4"/><circle cx="12" cy="16.8" r="1.1" fill="currentColor" stroke="none"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5"/><circle cx="12" cy="16" r="1.1" fill="currentColor" stroke="none"/>',
  mail: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M4 7.5l8 6 8-6"/>',
  tag: '<path d="M19.5 12.6l-6.4 6.4a1.5 1.5 0 0 1-2.1 0L4 12V4h8l7.5 7.5a1.4 1.4 0 0 1 0 1.1Z"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" stroke="none"/>',
  pencil: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19Z"/><path d="M14.5 6.5l3 3"/>',
  groupAdd: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>',
};

/** Every icon name, sorted — the closed vocabulary. */
export const ICON_NAMES = Object.keys(ICONS).sort();

/** True only for names in the closed vocabulary. */
export function isIconName(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** Inner SVG markup for a known name, else null. Pure — Node-safe. */
export function getIconBody(name) {
  return isIconName(name) ? ICONS[name] : null;
}

/** CSS classes are caller-controlled, so they go through the same closed
 * gate as names: anything outside [A-Za-z0-9 _-] falls back to 'ico'. */
function safeIconClass(cls) {
  if (typeof cls !== 'string') return 'ico';
  const c = cls.trim().split(/\s+/).filter((p) => /^[A-Za-z][\w-]*$/.test(p));
  return c.length ? c.slice(0, 3).join(' ') : 'ico';
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A complete inline <svg> string for a KNOWN name ('' for unknown — never
 * throws, never interpolates the name). Decorative by default
 * (aria-hidden, focusable=false); the owning button carries the name.
 */
export function iconSvgString(name, cls = 'ico') {
  const body = getIconBody(name);
  if (!body) return '';
  return `<svg class="${esc(safeIconClass(cls))}" viewBox="${ICON_VIEWBOX}" fill="none" stroke="currentColor" stroke-width="${ICON_STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Icon + escaped text label for buttons rendered as HTML strings. */
export function iconLabelHtml(name, text, cls = 'ico') {
  return `${iconSvgString(name, cls)}<span class="ic-label">${esc(text)}</span>`;
}

/** Build a real SVGElement for live DOM (null without a document). */
export function iconElement(name, cls = 'ico') {
  if (typeof document === 'undefined') return null;
  const body = getIconBody(name);
  if (!body) return null;
  // Minimal-DOM fallback (the node suites' fake documents have createElement
  // but no SVG namespace): a plain element carrying the class + serialized
  // shapes. Real browsers always take the namespace path below.
  if (typeof document.createElementNS !== 'function') {
    const el = document.createElement('svg');
    try { el.setAttribute('class', safeIconClass(cls)); } catch { /* fake without attrs */ }
    try { el.innerHTML = body; } catch { /* fake without markup parsing */ }
    return el;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', safeIconClass(cls));
  svg.setAttribute('viewBox', ICON_VIEWBOX);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(ICON_STROKE));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const tpl = document.createElement('template');
  // Safe: body is registry-owned markup for a validated name, and <template>
  // content never executes — but only whitelisted shape tags may pass.
  tpl.innerHTML = `<svg>${body}</svg>`;
  const inner = tpl.content.firstChild;
  if (inner) {
    for (const node of [...inner.childNodes]) {
      if (node.nodeType === 1 && /^(path|circle|rect)$/i.test(node.tagName)) {
        svg.appendChild(document.importNode(node, true));
      }
    }
  }
  return svg;
}

/**
 * Paint an icon-only control (button, span): replaces children with the
 * icon, keeps every attribute (title, aria, data) untouched. Unknown names
 * clear to empty rather than painting a wrong glyph.
 */
export function setIcon(el, name, cls = 'ico') {
  if (!el) return;
  el.replaceChildren();
  const svg = iconElement(name, cls);
  if (svg) el.appendChild(svg);
}

/**
 * Paint an icon + text control: icon first, label in .ic-label. Later text
 * updates must target the label (updateIconLabel), never textContent the
 * whole button — that would erase the SVG.
 */
export function setIconLabel(el, name, text, cls = 'ico') {
  if (!el) return;
  el.replaceChildren();
  const svg = iconElement(name, cls);
  if (svg) el.appendChild(svg);
  const label = typeof document === 'undefined' ? null : document.createElement('span');
  if (label) {
    label.className = 'ic-label';
    label.textContent = String(text ?? '');
    el.appendChild(label);
  }
}

/** Re-label an icon + text control without touching its SVG. */
export function updateIconLabel(el, text) {
  if (!el) return;
  const label = el.querySelector?.(':scope > .ic-label');
  if (label) label.textContent = String(text ?? '');
}
