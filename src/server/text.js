// Code-point-safe text cuts. String.slice/substring count UTF-16 code units,
// so cutting at an arbitrary offset can split an emoji (or any astral-plane
// character) in half and leave a lone surrogate behind — rendered as � in
// the sidebar, chat title, preview and notification banners. Every
// user-visible truncation must go through here instead of .slice().

/** Cut to at most `max` code points, emoji-safe. No ellipsis. */
export function cutText(text, max) {
  const s = String(text ?? '');
  const n = Math.max(0, Math.floor(Number(max) || 0));
  const pts = Array.from(s);
  return pts.length > n ? pts.slice(0, n).join('') : s;
}

/** Cut to at most `max` code points, appending `mark` only when shortened. */
export function cutEllipsis(text, max, mark = '…') {
  const s = String(text ?? '');
  const n = Math.max(0, Math.floor(Number(max) || 0));
  const pts = Array.from(s);
  return pts.length > n ? pts.slice(0, n).join('') + mark : s;
}

/** True when the string carries a split surrogate pair (cut mid-emoji). */
export function hasLoneSurrogate(text) {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    String(text ?? ''),
  );
}
