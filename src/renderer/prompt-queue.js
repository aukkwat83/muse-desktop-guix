// Per-chat FIFO prompt queue (BUG-051), ported near-verbatim from
// grok-desktop's prompt-queue.js:37-196.
//
// In-memory only (keyed by chatId) — not persisted across app restart.
// Pure module: no DOM / no network. Unit-testable.
//
// Open turn phases mirror the renderer's per-chat turn state (a turnId set on
// the chat's turn view) duplicated as a string set so this module stays
// dependency-free.

/** Phases that mean a turn is still open — do not auto-dispatch. */
const OPEN_PHASES = new Set(['starting', 'running', 'waiting_input', 'settling']);

/**
 * @typedef {{ id: string, text: string, attachments: Array, enqueuedAt: number }} QueueItem
 */

export function createPromptQueue() {
  /** @type {Map<string, QueueItem[]>} */
  const byChat = new Map();
  let seq = 0;

  function bucket(chatId) {
    const id = String(chatId || '');
    if (!id) return [];
    let q = byChat.get(id);
    if (!q) {
      q = [];
      byChat.set(id, q);
    }
    return q;
  }

  function enqueue(chatId, text, attachments = []) {
    const id = String(chatId || '');
    const t = String(text || '').trim();
    const atts = Array.isArray(attachments) ? attachments : [];
    if (!id || (!t && !atts.length)) return null;
    const item = {
      id: `q${++seq}`,
      text: t,
      attachments: atts,
      enqueuedAt: Date.now(),
    };
    bucket(id).push(item);
    return item;
  }

  function peek(chatId) {
    const q = byChat.get(String(chatId || ''));
    return q && q.length ? q[0] : null;
  }

  function dequeue(chatId) {
    const id = String(chatId || '');
    const q = byChat.get(id);
    if (!q || !q.length) return null;
    const item = q.shift();
    if (!q.length) byChat.delete(id);
    return item || null;
  }

  function removeAt(chatId, index) {
    const id = String(chatId || '');
    const q = byChat.get(id);
    if (!q || !q.length) return null;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= q.length) return null;
    const removed = q.splice(i, 1)[0] || null;
    if (!q.length) byChat.delete(id);
    return removed;
  }

  /** Put an item back at the front (409 TURN_IN_FLIGHT race — no loss). */
  function requeueFront(chatId, itemOrText) {
    const id = String(chatId || '');
    if (!id) return null;
    /** @type {QueueItem|null} */
    let item = null;
    if (itemOrText && typeof itemOrText === 'object' && (itemOrText.text || itemOrText.attachments?.length)) {
      item = {
        id: itemOrText.id || `q${++seq}`,
        text: String(itemOrText.text || '').trim(),
        attachments: Array.isArray(itemOrText.attachments) ? itemOrText.attachments : [],
        enqueuedAt: itemOrText.enqueuedAt || Date.now(),
      };
    } else {
      const t = String(itemOrText || '').trim();
      if (!t) return null;
      item = { id: `q${++seq}`, text: t, attachments: [], enqueuedAt: Date.now() };
    }
    if (!item.text && !item.attachments.length) return null;
    const q = bucket(id);
    q.unshift(item);
    return item;
  }

  function clear(chatId) {
    byChat.delete(String(chatId || ''));
  }

  function list(chatId) {
    const q = byChat.get(String(chatId || ''));
    return q ? q.slice() : [];
  }

  function length(chatId) {
    const q = byChat.get(String(chatId || ''));
    return q ? q.length : 0;
  }

  function clearAll() {
    byChat.clear();
  }

  return {
    enqueue,
    peek,
    dequeue,
    removeAt,
    requeueFront,
    clear,
    list,
    length,
    clearAll,
  };
}

/**
 * Should we auto-dispatch the next queued prompt for a chat?
 * True only when the turn phase is settled/idle AND the queue is non-empty.
 */
export function shouldDispatch(viewPhase, queueLen) {
  const len = Number(queueLen) || 0;
  if (len <= 0) return false;
  const phase = String(viewPhase || 'idle');
  return !OPEN_PHASES.has(phase);
}

export default createPromptQueue;
