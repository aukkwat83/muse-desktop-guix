// Windowed transcript helpers (BUG-052), ported from grok-desktop's
// history-window.js. Pure functions (Node + browser): decide WHICH slice of
// the persisted messages mounts, so a long chat does not re-render markdown
// for its entire history on every chat switch and every turn settle.
//
// Not ported (grok-specific): partitionTranscriptWindow / turnMsgIndex /
// shouldDeferHistoryWindowRecompute — those operate on grok's TurnModel, and
// muse has no such model: the live turn mounts incrementally via
// paintLiveTurn() AFTER the history window, so an open turn is always visible
// by construction and there is no per-delta window recompute to defer.

/** Default: last N user turns mounted on first paint. */
export const HISTORY_WINDOW_TURNS = 12;
/** Expand by this many user turns when loading older. */
export const HISTORY_EXPAND_TURNS = 12;
/** Absolute floor: always mount at least this many trailing messages. */
export const HISTORY_MIN_MESSAGES = 24;

/**
 * Slightly smaller first-paint window on low core-count hosts so paint matches
 * without changing expand math (grok-desktop history-window.js:20-31).
 * @param {{ cores?: number }} [opts]
 */
export function adaptiveHistoryDefaults(opts = {}) {
  let cores = opts.cores;
  if (cores == null && typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    cores = navigator.hardwareConcurrency;
  }
  const low = Number(cores) > 0 && Number(cores) <= 4;
  return {
    windowTurns: low ? 10 : HISTORY_WINDOW_TURNS,
    minMessages: low ? 20 : HISTORY_MIN_MESSAGES,
    expandTurns: HISTORY_EXPAND_TURNS,
  };
}

/**
 * Indices of user-role messages (turn starts).
 * @param {Array<{ role?: string }>} messages
 * @returns {number[]}
 */
export function userMessageIndices(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') out.push(i);
  }
  return out;
}

/**
 * Inclusive start message index for a trailing turn window
 * (grok-desktop history-window.js:59-112, minus the deep-link option muse
 * does not have).
 *
 * @param {Array<{ role?: string }>} messages
 * @param {{ windowTurns?: number, minMessages?: number, forceFull?: boolean }} [opts]
 * @returns {{ startIndex: number, total: number, truncated: boolean, turnCount: number, windowTurns: number }}
 */
export function computeHistoryStartIndex(messages, opts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const total = list.length;
  const windowTurns = Math.max(1, Number(opts.windowTurns) || HISTORY_WINDOW_TURNS);
  const minMessages = Math.max(1, Number(opts.minMessages) || HISTORY_MIN_MESSAGES);

  if (opts.forceFull || total === 0) {
    return {
      startIndex: 0,
      total,
      truncated: false,
      turnCount: userMessageIndices(list).length,
      windowTurns,
    };
  }

  const userIdxs = userMessageIndices(list);
  const turnCount = userIdxs.length;

  // Prefer turn-based window; also honor min trailing messages
  const firstTurn = Math.max(0, turnCount - windowTurns);
  let startIndex = turnCount ? userIdxs[firstTurn] : Math.max(0, total - minMessages);

  // Ensure at least minMessages from the end
  const byCount = Math.max(0, total - minMessages);
  if (byCount < startIndex) startIndex = byCount;

  startIndex = Math.max(0, Math.min(startIndex, total));
  const truncated = startIndex > 0;
  return {
    startIndex,
    total,
    truncated,
    turnCount,
    windowTurns,
  };
}

/**
 * Expand window upward by `expandTurns` user turns from current startIndex
 * (grok-desktop history-window.js:122-147).
 *
 * @param {Array<{ role?: string }>} messages
 * @param {number} currentStartIndex
 * @param {number} [expandTurns]
 * @returns {number} new startIndex (never increases)
 */
export function expandHistoryStartIndex(messages, currentStartIndex, expandTurns = HISTORY_EXPAND_TURNS) {
  const list = Array.isArray(messages) ? messages : [];
  const cur = Math.max(0, Math.floor(Number(currentStartIndex) || 0));
  if (cur <= 0) return 0;
  const userIdxs = userMessageIndices(list);
  // Find the first user turn at or after current start; step back expandTurns
  let turnAt = 0;
  for (let i = 0; i < userIdxs.length; i++) {
    if (userIdxs[i] >= cur) {
      turnAt = i;
      break;
    }
    turnAt = i + 1;
  }
  // If start is mid-history without user at cur, map to next user or index
  if (turnAt === 0 && userIdxs[0] != null && userIdxs[0] < cur) {
    for (let i = 0; i < userIdxs.length; i++) {
      if (userIdxs[i] <= cur) turnAt = i;
    }
  }
  const newTurn = Math.max(0, turnAt - Math.max(1, expandTurns));
  if (!userIdxs.length) {
    return Math.max(0, cur - Math.max(1, expandTurns) * 4);
  }
  return userIdxs[newTurn] ?? 0;
}

/**
 * Slice messages for mount [startIndex, end)
 * (grok-desktop history-window.js:154-162).
 * @param {Array} messages
 * @param {number} startIndex
 */
export function sliceHistoryMessages(messages, startIndex) {
  const list = Array.isArray(messages) ? messages : [];
  const start = Math.max(0, Math.min(Math.floor(Number(startIndex) || 0), list.length));
  return {
    slice: list.slice(start),
    startIndex: start,
    absoluteOffset: start,
  };
}
