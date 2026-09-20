// Pure scroll-pin decision for the transcript, ported from grok-desktop's
// scroll-pin.js:18-27 (§1.6 there). No DOM, no timers — unit-testable in Node;
// app.js wires these decisions to the real scroller.
//
// The rules this encodes:
//   - pinned-to-bottom while streaming
//   - an explicit user scroll-up (wheel / touch pan) unpins IMMEDIATELY, even
//     when the position is still inside the near-bottom threshold
//   - a bare scroll event never unpins — content growing under a pinned reader
//     fires scroll events too, and those must not look like the user leaving
//   - scrolling back to the bottom re-pins
//   - while unpinned, new content raises the jump-pill decision instead of
//     force-scrolling

/**
 * @param {{
 *   pinned: boolean,
 *   nearBottom: boolean,
 *   userScrolled: boolean,
 *   newContent: boolean,
 * }} input
 * @returns {{
 *   pinned: boolean,
 *   shouldScroll: boolean,
 *   showJump: boolean,
 * }}
 */
export function computePin({ pinned, nearBottom, userScrolled, newContent }) {
  let next = !!pinned;
  // Explicit user scroll-up always unpins (even if still "near" for a frame).
  if (userScrolled) next = false;
  // Scrolling back to the bottom re-pins.
  if (nearBottom && !userScrolled) next = true;
  const shouldScroll = next === true;
  const showJump = next === false && !!newContent;
  return { pinned: next, shouldScroll, showJump };
}

export default computePin;
