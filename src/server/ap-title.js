/**
 * Detect SCB AP project codes in prompts and keep session titles as:
 *   [AP1234] [AP5678] rest of title…
 * Multiple APs are ordered by first appearance (before → after).
 *
 * Ported from grok-desktop's ap-title.js (same regexes, same ordering
 * contract) so both desktops tag the same sessions the same way. The right
 * bar's SCB section reuses extractApCodes over the whole transcript to find
 * which APxxxx-Project a session is about, then matches insights for it.
 */

import { cutEllipsis } from './text.js';

const AP_RE = /\bAP\s*[-_]?\s*(\d{4,6})\b/gi;

/**
 * @param {string} text
 * @returns {string[]} normalized codes e.g. ["AP1234","AP5678"] in first-seen order
 */
export function extractApCodes(text) {
  const out = [];
  const seen = new Set();
  const src = String(text || '');
  let m;
  AP_RE.lastIndex = 0;
  while ((m = AP_RE.exec(src)) !== null) {
    const code = `AP${m[1]}`;
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

/**
 * Read [APxxxx] tags from the front of a title (in order).
 * @param {string} title
 * @returns {string[]}
 */
export function extractApTagsFromTitle(title) {
  const out = [];
  const seen = new Set();
  let rest = String(title || '');
  // Only leading tags count for ordered prefix
  while (true) {
    const m = rest.match(/^\s*\[(AP\d{4,6})\]\s*/i);
    if (!m) break;
    const code = m[1].toUpperCase();
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
    rest = rest.slice(m[0].length);
  }
  return out;
}

/**
 * Remove leading [APxxxx] prefixes from a title.
 * @param {string} title
 */
export function stripApTitlePrefixes(title) {
  return String(title || '')
    .replace(/^(?:\s*\[AP\d{4,6}\]\s*)+/i, '')
    .trim();
}

/**
 * Format ordered AP tags: [AP1] [AP2] …
 * @param {string[]} codes
 */
export function formatApTagPrefix(codes) {
  return (codes || [])
    .map((c) => `[${String(c).toUpperCase()}]`)
    .join(' ');
}

/**
 * Ensure title starts with [APxxxx] tags when text mentions AP projects.
 * Multiple codes → tags in appearance order (before → after).
 *
 * @param {string} currentTitle
 * @param {string} sourceText
 * @param {{
 *   preferExistingTitleTags?: boolean,
 *   rewriteDefaultRest?: boolean,
 * }} [opts]
 *   preferExistingTitleTags: keep prior title AP order first, then new codes
 *     (use when source is assistant reply — do not reshuffle known tags).
 *   rewriteDefaultRest: if title is still default, derive rest from sourceText
 *     (user prompt only — not for long assistant dumps).
 * @returns {{ title: string, ap: string | null, codes: string[], changed: boolean }}
 */
export function applyApPrefixToTitle(currentTitle, sourceText, opts = {}) {
  const preferExisting = !!opts.preferExistingTitleTags;
  const rewriteDefaultRest = opts.rewriteDefaultRest !== false && !preferExisting;
  const fromSource = extractApCodes(sourceText);
  if (!fromSource.length) {
    return {
      title: currentTitle,
      ap: null,
      codes: extractApTagsFromTitle(currentTitle),
      changed: false,
    };
  }

  const fromTitle = extractApTagsFromTitle(currentTitle);
  /** @type {string[]} */
  let codes;
  if (preferExisting) {
    // Keep title order; append newly discovered APs (assistant / backfill)
    const seen = new Set(fromTitle);
    codes = [...fromTitle];
    for (const c of fromSource) {
      if (!seen.has(c)) {
        seen.add(c);
        codes.push(c);
      }
    }
  } else {
    // Source order first (user prompt), then older title tags not repeated
    const seen = new Set(fromSource);
    codes = [...fromSource];
    for (const c of fromTitle) {
      if (!seen.has(c)) {
        seen.add(c);
        codes.push(c);
      }
    }
  }

  let rest = stripApTitlePrefixes(currentTitle);
  const isDefault =
    !rest ||
    rest === 'แชทใหม่' ||
    rest === 'New chat' ||
    /^แชทใหม่/i.test(rest);

  if (isDefault && rewriteDefaultRest) {
    rest = cutEllipsis(
      String(sourceText).replace(AP_RE, ' ').replace(/\s+/g, ' ').trim(),
      42,
    );
    if (!rest) rest = codes[0];
  }

  // Strip bare AP tokens stuck at the start of rest
  for (const ap of codes) {
    rest = rest.replace(new RegExp(`^${ap}\\b\\s*`, 'i'), '').trim();
  }
  if (!rest) rest = codes.join(' ');

  const prefix = formatApTagPrefix(codes);
  // Cap length but keep all tags if possible
  let title = `${prefix} ${rest}`.trim();
  if (Array.from(title).length > 120) {
    const room = Math.max(8, 120 - Array.from(prefix).length - 1);
    rest = cutEllipsis(rest, room);
    title = `${prefix} ${rest}`.trim();
  }

  return {
    title,
    ap: codes[0] || null,
    codes,
    changed: title !== String(currentTitle || ''),
  };
}

/**
 * Scan message list for AP codes and merge into title (backfill / assistant).
 * Does not replace the human title body with assistant prose.
 *
 * @param {string} currentTitle
 * @param {Array<{ role?: string, content?: string }|string>} messages
 * @returns {{ title: string, ap: string | null, codes: string[], changed: boolean }}
 */
export function applyApPrefixFromMessages(currentTitle, messages) {
  let title = currentTitle;
  let changed = false;
  /** @type {string[]} */
  let codes = extractApTagsFromTitle(title);
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) {
    const text =
      typeof m === 'string'
        ? m
        : String(m?.content || m?.text || '');
    if (!text) continue;
    // User prompts: source order wins; assistant: keep existing tags first
    const preferExisting = !(m && typeof m === 'object' && m.role === 'user');
    const r = applyApPrefixToTitle(title, text, {
      preferExistingTitleTags: preferExisting,
      rewriteDefaultRest: m && typeof m === 'object' && m.role === 'user',
    });
    if (r.changed) {
      title = r.title;
      changed = true;
    }
    if (r.codes?.length) codes = r.codes;
  }
  return {
    title,
    ap: codes[0] || null,
    codes,
    changed,
  };
}
