// Per-chat composer drafts, mirrored into sessionStorage (BUG-050).
//
// Ported lean from grok-desktop's composer-draft.js:53-164: one textarea in
// the DOM, drafts keyed by chatId in a Map, and every set/delete mirrored under
// `kd.composerDraft.<id>` so typed-but-unsent text survives a reload. Reads
// rehydrate lazily (Map miss → storage). The binder half of grok's module is
// not ported: selectChat() already performs the save/restore sync inline
// (BUG-043), a second binder would be dead code.
//
// Pure module: the storage object is injected in tests; no DOM.

const STORAGE_PREFIX = 'kd.composerDraft.';

/**
 * @param {{ storage?: Storage | null, persist?: boolean }} [opts]
 */
export function createComposerDraftStore(opts = {}) {
  /** @type {Map<string, string>} */
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

  /** Draft for a chat — Map first, sessionStorage lazily, else ''. */
  function get(chatId) {
    const id = String(chatId || '');
    if (!id) return '';
    if (byChat.has(id)) return byChat.get(id) || '';
    if (persist && storage) {
      try {
        const v = storage.getItem(key(id));
        if (v != null) {
          byChat.set(id, v);
          return v;
        }
      } catch {
        /* private mode / quota — drafts stay memory-only */
      }
    }
    return '';
  }

  function set(chatId, text) {
    const id = String(chatId || '');
    if (!id) return;
    const t = String(text ?? '');
    byChat.set(id, t);
    if (persist && storage) {
      try {
        if (t) storage.setItem(key(id), t);
        else storage.removeItem(key(id));
      } catch {
        /* ignore */
      }
    }
  }

  function clear(chatId) {
    set(chatId, '');
  }

  function clearAll() {
    for (const id of [...byChat.keys()]) clear(id);
    byChat.clear();
  }

  function has(chatId) {
    const id = String(chatId || '');
    if (!id) return false;
    if (byChat.has(id)) return true;
    if (persist && storage) {
      try {
        return storage.getItem(key(id)) != null;
      } catch {
        return false;
      }
    }
    return false;
  }

  function size() {
    return byChat.size;
  }

  return { get, set, clear, clearAll, has, size };
}

export default createComposerDraftStore;
