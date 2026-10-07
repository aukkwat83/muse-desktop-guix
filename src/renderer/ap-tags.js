// Renderer-side [APxxxx] title tags (grok-desktop parity).
//
// The server prefixes session titles with [AP1234] when a prompt mentions an
// SCB project (ap-title.js); these helpers split the prefixes back out so
// the sidebar and the chat title paint them as chips instead of flat text.
// Pure split + one tiny DOM painter — no state, no fetch.

const AP_TAG_PREFIX_RE = /^\s*\[(AP\d{4,6})\]\s*/i;

/**
 * Split leading [APxxxx] tags off a title.
 * @returns {{ codes: string[], rest: string }}
 */
export function splitApTitle(title) {
  const codes = [];
  let rest = String(title || '');
  for (;;) {
    const m = rest.match(AP_TAG_PREFIX_RE);
    if (!m) break;
    codes.push(m[1].toUpperCase());
    rest = rest.slice(m[0].length);
  }
  return { codes, rest: rest.trim() };
}

/**
 * Paint a title with AP chips: clears the container, appends one .s-ap-tag
 * per code plus a .s-title-rest span for the remainder. Plain textContent
 * when there are no tags — zero DOM churn for the common case.
 */
export function paintApTitle(container, title) {
  const { codes, rest } = splitApTitle(title);
  container.replaceChildren();
  if (!codes.length) {
    container.textContent = String(title || '');
    container.removeAttribute('title');
    return;
  }
  for (const code of codes) {
    const chip = document.createElement('span');
    chip.className = 's-ap-tag';
    chip.textContent = code;
    chip.title = `โปรเจกต์ SCB ${code}`;
    container.append(chip);
  }
  const tail = document.createElement('span');
  tail.className = 's-title-rest';
  tail.textContent = rest || codes.join(' ');
  container.append(tail);
  container.title = String(title || '');
}
