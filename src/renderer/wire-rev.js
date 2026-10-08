// Per-resource revision guard: GET snapshots must never overwrite newer
// same-chat SSE. A selectChat/resync fetch that starts, then an SSE frame
// lands, then the fetch resolves, would otherwise paint stale state over
// the live mirror (a cleared goal resurrects, a landed child re-runs).
// The select generation guard alone cannot see this — same chat, same
// generation, newer SSE. Every SSE write bumps the resource revision;
// every snapshot apply first checks its captured revision is still
// current, else it skips (goal/ctx) or backfills missing keys only
// (subagent registry). Pure, no DOM — the node suite covers it.

export function createWireRevisions() {
  const revs = new Map();
  const key = (chatId, resource) => `${chatId}::${resource}`;
  return {
    /** Current revision of one resource mirror (starts at 0). Captures
     * register: a first read materializes its key, so a later reset has
     * something to bump — otherwise a capture at the phantom 0 on a chat
     * nothing ever wrote would survive the reset and let a stale select
     * snapshot apply over the newer resync one. No counter ever moves
     * here; missing keys are born at their current value, 0. */
    revOf(chatId, resource) {
      const k = key(chatId, resource);
      if (!revs.has(k)) revs.set(k, 0);
      return revs.get(k);
    },
    /** Record a write — call on EVERY mirror mutation, SSE or snapshot. */
    bump(chatId, resource) {
      revs.set(key(chatId, resource), (revs.get(key(chatId, resource)) || 0) + 1);
    },
    /** True when a write landed after `captured` was taken. */
    stale(chatId, resource, captured) {
      return (revs.get(key(chatId, resource)) || 0) !== captured;
    },
    /** Invalidate all revisions for a chat (resync clears the mirrors).
     * Monotonic by design: every known resource rev moves FORWARD, so a
     * snapshot captured before the clear always reads stale after it.
     * The old delete-back-to-0 was an ABA — a select GET captured at 0,
     * an SSE clear bumping to 1, a reset rewinding to 0, and the stale
     * select snapshot would apply its fossil over the cleared mirror. */
    reset(chatId) {
      for (const k of [...revs.keys()]) {
        if (k.startsWith(`${chatId}::`)) revs.set(k, revs.get(k) + 1);
      }
    },
  };
}
