// Per-chat Deep Research toggle (v1.1.39), mirrored into sessionStorage.
//
// Same shape as the composer-draft store (BUG-050): a Map keyed by
// chatId with lazy rehydration under `kd.deepResearch.<id>`, so the
// toggle survives a reload but never leaks onto a neighbouring chat.
// Pure module: the storage object is injected in tests; no DOM.

const STORAGE_PREFIX = 'kd.deepResearch.';

/**
 * @param {{ storage?: Storage | null, persist?: boolean }} [opts]
 */
export function createDeepResearchStore(opts = {}) {
  /** @type {Map<string, boolean>} */
  const byChat = new Map();
  const persist = opts.persist !== false;
  const storage =
    opts.storage !== undefined
      ? opts.storage
      : typeof sessionStorage !== 'undefined'
        ? sessionStorage
        : null;

  function key(chatId) {
    return STORAGE_PREFIX + String(chatId || '');
  }

  /** Toggle state for a chat — Map first, sessionStorage lazily. */
  function get(chatId) {
    const id = String(chatId || '');
    if (!id) return false;
    if (byChat.has(id)) return byChat.get(id) === true;
    if (persist && storage) {
      try {
        const on = storage.getItem(key(id)) === '1';
        byChat.set(id, on);
        return on;
      } catch {
        /* private mode / quota — the toggle stays memory-only */
      }
    }
    return false;
  }

  function set(chatId, on) {
    const id = String(chatId || '');
    if (!id) return false;
    const value = on === true;
    byChat.set(id, value);
    if (persist && storage) {
      try {
        if (value) storage.setItem(key(id), '1');
        else storage.removeItem(key(id));
      } catch {
        /* ignore */
      }
    }
    return value;
  }

  function toggle(chatId) {
    return set(chatId, !get(chatId));
  }

  return { get, set, toggle };
}

export default createDeepResearchStore;
