// Durable store for Muse Desktop: groups + the chats inside them.
//
// One JSON file under the XDG state dir. Small on purpose: the agent owns the
// real conversation (muse persists sessions under ~/.local/share/muse), we only keep
// what the UI needs to redraw a sidebar and a transcript without talking to
// the agent first.
//
// Hard-won rule from grok-desktop: a debounced write is fine for message text,
// but anything the *next process* must agree on — above all `mspSessionId` —
// gets an immediate synchronous flush. A debounce that loses the race with
// process exit leaves a stale agent-session id on disk, and every restart then
// retries a session the agent already threw away. Group structure is in the
// same category: losing it silently reshuffles the user's whole sidebar.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function stateDir() {
  const base =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim()
      ? process.env.XDG_STATE_HOME
      : path.join(os.homedir(), '.local/state');
  const dir = path.join(base, 'muse-desktop');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const STORE_VERSION = 2;
export const DEFAULT_GROUP_NAME = 'Group 1';

export class SessionStore {
  constructor({ file = path.join(stateDir(), 'chats.json'), debounceMs = 400 } = {}) {
    this.file = file;
    this.debounceMs = debounceMs;
    this.data = { version: STORE_VERSION, activeGroupId: null, groups: [], chats: [] };
    this._timer = null;
    /**
     * Write observer — the SessionManager attaches the FTS indexer here so
     * every persisted string (messages, titles, tools, plans, group names)
     * reaches the search index through one choke point. Plain property (not
     * an emitter): exactly one consumer, and unit tests construct the store
     * without one. Never throws into the write path (see _emit).
     */
    this.onWrite = null;
    this.load();
  }

  /** Notify the write observer; observer bugs must never break chat writes. */
  _emit(type, payload) {
    if (typeof this.onWrite !== 'function') return;
    try {
      this.onWrite(type, payload);
    } catch (err) {
      console.error(`[session-store] onWrite(${type}) failed:`, err?.message || err);
    }
  }

  load() {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      // First run, or a corrupted file we deliberately do not try to repair:
      // starting empty is safer than half-parsed state.
    }
    const groups = Array.isArray(parsed?.groups) ? parsed.groups.map(normalizeGroup) : [];
    const chats = Array.isArray(parsed?.chats) ? parsed.chats.map(normalizeChat) : [];
    this.data = {
      version: STORE_VERSION,
      activeGroupId: parsed?.activeGroupId ?? null,
      groups,
      chats,
    };
    this.migrate();
    return this.data;
  }

  /**
   * v1 had no groups. Rather than special-case "ungrouped" everywhere, give
   * every existing chat a home in one default group — the sidebar then has a
   * single shape to render, now and for every file written from here on.
   */
  migrate() {
    if (!this.data.groups.length) {
      this.data.groups.push(makeGroup(DEFAULT_GROUP_NAME, 0));
    }
    const ids = new Set(this.data.groups.map((g) => g.id));
    const fallback = this.data.groups[0].id;
    for (const chat of this.data.chats) {
      if (!chat.groupId || !ids.has(chat.groupId)) chat.groupId = fallback;
    }
    if (!this.data.activeGroupId || !ids.has(this.data.activeGroupId)) {
      this.data.activeGroupId = fallback;
    }
    this.sortByOrder();
    this.renumber();
  }

  /** Put the array in `order` sequence. Only correct when reading from disk. */
  sortByOrder() {
    this.data.groups.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /**
   * Renumber `order` from the array's *current* sequence.
   *
   * Deliberately does not sort: after a drag-reorder the array is already in
   * the new sequence while `order` still holds the old numbers, so sorting
   * here would put everything straight back and the drag would appear to do
   * nothing.
   */
  renumber() {
    this.data.groups.forEach((g, i) => {
      g.order = i;
    });
  }

  // ------------------------------------------------------------ persistence

  /** Debounced write — for high-frequency, low-stakes updates (message text). */
  persistSoon() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, this.debounceMs);
    this._timer.unref?.();
  }

  async flush() {
    const tmp = `${this.file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  /** Synchronous flush — for state that must survive an immediate process exit. */
  flushNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }

  // ----------------------------------------------------------------- groups

  listGroups() {
    return [...this.data.groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  getGroup(id) {
    return this.data.groups.find((g) => g.id === id) || null;
  }

  get activeGroupId() {
    return this.data.activeGroupId;
  }

  setActiveGroup(id) {
    if (!this.getGroup(id)) return null;
    this.data.activeGroupId = id;
    this.flushNow();
    return id;
  }

  createGroup({ name } = {}) {
    const group = makeGroup(
      String(name || '').trim() || `Group ${this.data.groups.length + 1}`,
      this.data.groups.length,
    );
    this.data.groups.push(group);
    this.renumber();
    this.flushNow();
    this._emit('group', { group });
    return group;
  }

  renameGroup(id, name) {
    const group = this.getGroup(id);
    if (!group) return null;
    const next = String(name ?? '').trim();
    if (!next) return group;
    group.name = next.slice(0, 80);
    this.flushNow();
    this._emit('group', { group });
    return group;
  }

  /** Removes the group and every chat in it. Returns the removed chat ids. */
  removeGroup(id) {
    const i = this.data.groups.findIndex((g) => g.id === id);
    if (i < 0) return null;
    // Never leave the sidebar with nothing to render.
    if (this.data.groups.length <= 1) return null;
    const removedChatIds = this.data.chats.filter((c) => c.groupId === id).map((c) => c.id);
    this.data.chats = this.data.chats.filter((c) => c.groupId !== id);
    this.data.groups.splice(i, 1);
    this.renumber();
    if (this.data.activeGroupId === id) {
      this.data.activeGroupId = this.data.groups[0]?.id ?? null;
    }
    this.flushNow();
    this._emit('group-remove', { id, removedChatIds });
    return { removedChatIds };
  }

  /** Apply a full ordered list of group ids; unknown ids are ignored. */
  reorderGroups(order) {
    if (!Array.isArray(order)) return this.listGroups();
    const rank = new Map();
    order.forEach((id, i) => rank.set(String(id), i));
    this.data.groups.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return (a.order ?? 0) - (b.order ?? 0);
    });
    this.renumber();
    this.flushNow();
    return this.listGroups();
  }

  moveChat(chatId, groupId) {
    const chat = this.get(chatId);
    const group = this.getGroup(groupId);
    if (!chat || !group) return null;
    chat.groupId = groupId;
    chat.updatedAt = Date.now();
    this.flushNow();
    this._emit('chat-update', { id: chatId, patch: { groupId } });
    return chat;
  }

  // ------------------------------------------------------------------ chats

  list() {
    return this.data.chats;
  }

  listInGroup(groupId) {
    return this.data.chats
      .filter((c) => c.groupId === groupId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.data.chats.find((c) => c.id === id) || null;
  }

  create({ title = 'New chat', cwd = process.cwd(), mode = 'always', model = null, effort = 'ultra', groupId = null } = {}) {
    const now = Date.now();
    const home = this.getGroup(groupId)?.id || this.data.activeGroupId || this.data.groups[0]?.id;
    const chat = normalizeChat({
      id: randomUUID(),
      title,
      cwd,
      mode,
      model,
      effort,
      groupId: home,
      mspSessionId: null,
      createdAt: now,
      updatedAt: now,
      messages: [],
    });
    this.data.chats.unshift(chat);
    this.flushNow();
    this._emit('chat', { chat });
    return chat;
  }

  remove(id) {
    const i = this.data.chats.findIndex((c) => c.id === id);
    if (i < 0) return false;
    this.data.chats.splice(i, 1);
    this.flushNow();
    this._emit('chat-remove', { id });
    return true;
  }

  update(id, patch) {
    const chat = this.get(id);
    if (!chat) return null;
    Object.assign(chat, patch, { updatedAt: Date.now() });
    // `mspSessionId` is the one field a restart cannot guess — never debounce it.
    if (Object.prototype.hasOwnProperty.call(patch, 'mspSessionId')) this.flushNow();
    else this.persistSoon();
    this._emit('chat-update', { id, patch });
    return chat;
  }

  addMessage(id, message) {
    const chat = this.get(id);
    if (!chat) return null;
    const msg = {
      id: message.id || randomUUID(),
      role: message.role || 'assistant',
      text: String(message.text ?? ''),
      ts: message.ts || Date.now(),
      ...(message.meta ? { meta: message.meta } : {}),
    };
    chat.messages.push(msg);
    chat.updatedAt = msg.ts;
    // Auto-title from the first user message: a sidebar of "New chat" rows is
    // useless once you have more than two.
    if (msg.role === 'user' && (!chat.title || chat.title === 'New chat')) {
      chat.title = deriveTitle(msg.text);
    }
    this.persistSoon();
    this._emit('message', { chatId: id, index: chat.messages.length - 1, msg });
    return msg;
  }

  /**
   * Replace the text of a turn's assistant message, or append one.
   * The agent streams chunks and then sends an authoritative final text; we
   * keep exactly one assistant message per turn so the transcript can never
   * show the same answer twice.
   */
  setAssistantMessage(id, turnId, text, meta) {
    const chat = this.get(id);
    if (!chat) return null;
    const existing = [...chat.messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.meta?.turnId === turnId);
    if (existing) {
      existing.text = String(text ?? '');
      if (meta) existing.meta = { ...existing.meta, ...meta };
      chat.updatedAt = Date.now();
      this.persistSoon();
      this._emit('message', { chatId: id, index: chat.messages.indexOf(existing), msg: existing });
      return existing;
    }
    return this.addMessage(id, { role: 'assistant', text, meta: { turnId, ...(meta || {}) } });
  }

  trimMessages(id, max = 500) {
    const chat = this.get(id);
    if (!chat || chat.messages.length <= max) return;
    chat.messages.splice(0, chat.messages.length - max);
    this.persistSoon();
    // Positional msg: indexes shifted — the indexer re-sources this chat.
    this._emit('trim', { chatId: id });
  }
}

function makeGroup(name, order) {
  return { id: randomUUID(), name: String(name).slice(0, 80), order, createdAt: Date.now() };
}

function normalizeGroup(raw) {
  return {
    id: String(raw?.id || randomUUID()),
    name: String(raw?.name || 'Group').slice(0, 80),
    order: Number.isFinite(raw?.order) ? Number(raw.order) : 0,
    createdAt: Number(raw?.createdAt) || Date.now(),
  };
}

function normalizeChat(raw) {
  return {
    id: String(raw.id),
    title: String(raw.title || 'New chat'),
    cwd: String(raw.cwd || os.homedir()),
    mode: String(raw.mode || 'always'),
    model: raw.model ?? null,
    effort: raw.effort ?? 'ultra',
    groupId: raw.groupId ? String(raw.groupId) : null,
    mspSessionId: raw.mspSessionId ?? null,
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    messages: Array.isArray(raw.messages)
      ? raw.messages.map((m) => ({
          id: String(m.id || randomUUID()),
          role: m.role === 'user' || m.role === 'notice' ? m.role : 'assistant',
          text: String(m.text ?? ''),
          ts: Number(m.ts) || Date.now(),
          ...(m.meta ? { meta: m.meta } : {}),
        }))
      : [],
  };
}

export function deriveTitle(text) {
  const flat = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return 'New chat';
  const cut = flat.slice(0, 60);
  return cut.length < flat.length ? `${cut}…` : cut;
}
