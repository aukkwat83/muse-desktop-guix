/**
 * Local realtime search index — SQLite FTS5 (schema v2).
 * Cross-group / cross-session / multi-surface (result · activity · console · meta).
 * Derived store; rebuildable. MSP hot path never blocked (async queue + urgent microtask).
 *
 * Ported from grok-desktop src/server/search-index.js (verbatim ranking/query/
 * schema logic) with muse adaptations: state dir + mspSessionId dims, muse
 * chat/message shapes in rebuildAll, numeric-ts normalization, and — per the
 * standing requirement that FTS must never silently die — a self-healing open
 * (corrupt db is quarantined and rebuilt, a missing binding throws LOUD at
 * boot instead of degrading to `enabled: false`).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

import { stateDir } from './session-store.js';

const require = createRequire(import.meta.url);

export const SCHEMA_VERSION = 2;
const MAX_TEXT = {
  default: 24_000,
  tool_out: 8_000,
  label: 2_000,
  live: 24_000,
};

export function searchIndexPath() {
  return path.join(stateDir(), 'search.sqlite');
}

/**
 * Normalize a timestamp to ISO text. Muse chats store epoch-ms numbers;
 * mixing those with ISO strings in a TEXT column would corrupt recency
 * ordering (lexicographic "1726…" sorts before "2026-…").
 */
export function toAt(v, fallback = null) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    try {
      return new Date(v).toISOString();
    } catch {
      return fallback;
    }
  }
  if (typeof v === 'string' && v) return v;
  return fallback;
}

/**
 * Kind → UI surface for deep-link.
 * @param {string} kind
 */
/**
 * Chunk kinds that represent model/system-*generated* output (as opposed to the
 * user's own prompt / slash-command, or pure navigation meta). Used by
 * find-in-session so the box matches answers, not the command that produced them.
 */
export const GENERATED_KINDS = new Set([
  'assistant',
  'assistant_live',
  'tool_out',
  'error',
]);

export function surfaceForKind(kind) {
  switch (String(kind || '')) {
    case 'user':
    case 'assistant':
    case 'assistant_live':
    case 'error':
      return 'result';
    case 'tool':
    case 'agent':
    case 'turn':
      return 'activity';
    case 'tool_out':
      return 'console';
    case 'title':
      return 'session';
    case 'group':
    case 'shell':
    case 'ask_user':
    case 'permission':
    case 'plan':
    default:
      return 'meta';
  }
}

/**
 * Boost by kind for ranking (higher = more important).
 * @param {string} kind
 */
export function kindBoost(kind) {
  switch (String(kind || '')) {
    case 'title':
      return 3.2;
    case 'group':
      return 2.8;
    case 'user':
      return 2.4;
    case 'assistant':
    case 'assistant_live':
      return 1.8;
    case 'error':
      return 2.0;
    case 'tool':
    case 'agent':
      return 1.6;
    case 'tool_out':
      return 1.5;
    case 'turn':
      return 1.4;
    case 'shell':
      return 0.8;
    default:
      return 1.0;
  }
}

/**
 * Parse operators: group: name | kind:tool | in:console | is:running
 * Returns { free, filters }.
 * @param {string} raw
 */
export function parseSearchQuery(raw) {
  const filters = {
    group: null,
    kind: null,
    surface: null,
    sessionId: null,
    isRunning: false,
  };
  let free = String(raw || '').trim();
  const opRe = /\b(group|kind|in|surface|session|is):("[^"]+"|\S+)/gi;
  free = free.replace(opRe, (_, key, val) => {
    const k = String(key).toLowerCase();
    let v = String(val || '').trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (k === 'group') filters.group = v.toLowerCase();
    else if (k === 'kind') filters.kind = v.toLowerCase();
    else if (k === 'in' || k === 'surface') filters.surface = v.toLowerCase();
    else if (k === 'session') filters.sessionId = v.toLowerCase();
    else if (k === 'is' && /run|running|active/i.test(v)) filters.isRunning = true;
    return ' ';
  });
  free = free.replace(/\s+/g, ' ').trim();
  return { free, filters };
}

/**
 * Split free text into cleaned search terms (shared by the FTS and LIKE paths).
 * @param {string} raw
 * @returns {string[]}
 */
export function splitQueryTerms(raw) {
  const q = String(raw || '').trim();
  if (!q) return [];
  // \p{M} keeps Thai combining marks (่ ้ ๊ ๋ ์ ฯลฯ) glued to their
  // consonant — stripping them would split one Thai word into fragments.
  const cleaned = q
    .replace(/[^\p{L}\p{M}\p{N}\s_./:@+-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned.split(' ').filter((t) => t.length > 0);
}

/**
 * Escape / shape free text into a safe FTS5 query.
 *
 * DIVERGENCE from grok (deliberate): this table uses the `trigram` tokenizer
 * instead of grok's `unicode61`, because the standing requirement is true
 * substring recall — a Thai query must match mid-token ("ค้นหา" inside
 * "ระบบค้นหาไฟล์แนบ"), which unicode61 prefix matching cannot do. Terms are
 * ANDed double-quoted phrases; every term is a substring predicate.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function toFtsQuery(raw) {
  const tokens = splitQueryTerms(raw);
  if (!tokens.length) return null;
  const quote = (t) => `"${t.replace(/"/g, '""')}"`;
  return tokens.map(quote).join(' AND ');
}

/** Trigram terms shorter than this are not indexed — route those to LIKE. */
export const LIKE_MIN_CHARS = 3;

/**
 * True when any term is too short for the trigram index (caller falls back
 * to a LIKE scan, which is slow but exact — and the table is tiny).
 */
export function needsLikeScan(raw) {
  return splitQueryTerms(raw).some((t) => [...t].length < LIKE_MIN_CHARS);
}

/** Escape a LIKE pattern (caller wraps with %…%). */
export function escapeLike(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function clipText(text, kind = 'default') {
  const t = String(text || '').replace(/\u0000/g, '');
  const max =
    kind === 'tool_out' ? MAX_TEXT.tool_out
      : kind === 'tool' || kind === 'agent' || kind === 'turn' ? MAX_TEXT.label
        : kind === 'assistant_live' ? MAX_TEXT.live
          : MAX_TEXT.default;
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…[truncated for search index]`;
}

/**
 * Flatten ACP plan entries to searchable text. Entry shapes vary by agent
 * (content/title/label + status) — join whatever reads, fall back to JSON.
 * @param {any} plan
 */
export function planEntriesText(plan) {
  if (!plan) return '';
  if (typeof plan === 'string') return plan;
  if (!Array.isArray(plan)) return '';
  const lines = [];
  for (const e of plan) {
    if (typeof e === 'string') {
      if (e.trim()) lines.push(e.trim());
      continue;
    }
    if (e && typeof e === 'object') {
      const s = [e.content, e.title, e.label, e.text].find((v) => typeof v === 'string' && v.trim());
      if (s) lines.push(s.trim());
    }
  }
  if (lines.length) return lines.join('\n');
  try {
    const j = JSON.stringify(plan);
    return j && j !== '[]' ? j : '';
  } catch {
    return '';
  }
}

/**
 * Infer chat turn number for message index i (1-based count of user msgs up to i).
 * @param {Array<{role?: string}>} messages
 * @param {number} msgIndex
 */
export function turnForMessageIndex(messages, msgIndex) {
  const msgs = Array.isArray(messages) ? messages : [];
  let turn = 0;
  for (let i = 0; i <= msgIndex && i < msgs.length; i++) {
    if (msgs[i]?.role === 'user') turn += 1;
  }
  return turn || null;
}

export class SearchIndex {
  constructor(opts = {}) {
    this.dbPath = opts.dbPath || searchIndexPath();
    /** @type {import('better-sqlite3').Database | null} */
    this.db = null;
    this.enabled = false;
    /** @type {Array<() => void>} */
    this._queue = [];
    this._flushScheduled = false;
    this._error = null;
    this._bench = { writes: 0, writeMs: 0, searchMs: 0, lastSearchMs: 0 };

    // Never silently disabled: a missing binding throws LOUD (fail fast at
    // boot with the fix in the message); a corrupt db file is quarantined
    // and recreated, then the boot rebuild re-sources every session.
    this._openWithRecovery();
  }

  _openWithRecovery() {
    try {
      this._open();
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      if (/cannot find module 'better-sqlite3'|ERR_MODULE_NOT_FOUND/i.test(msg)) {
        throw new Error(
          `[search-index] better-sqlite3 is not installed — FTS cannot start. Fix: cd to the app dir and run \`npm install\`. (${msg})`,
        );
      }
      // Possibly a corrupt db file — quarantine (db + WAL + SHM) and retry fresh once.
      let quarantined = false;
      try {
        if (fs.existsSync(this.dbPath)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
          for (const suffix of ['', '-wal', '-shm']) {
            const p = `${this.dbPath}${suffix}`;
            if (fs.existsSync(p)) {
              fs.renameSync(p, `${p}.corrupt-${stamp}`);
              quarantined = true;
            }
          }
        }
      } catch (qerr) {
        console.error('[search-index] quarantine failed:', qerr?.message || qerr);
      }
      if (!quarantined) throw err;
      console.warn('[search-index] quarantined corrupt db, recreating fresh…');
      try {
        this.db?.close?.();
      } catch { /* ignore */ }
      this.db = null;
      this._open();
      this.db
        .prepare(`INSERT INTO meta(key, value) VALUES ('needs_rebuild', ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
        .run('1');
    }
  }

  _open() {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS groups_dim (
        group_id TEXT PRIMARY KEY,
        name TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions_dim (
        session_id TEXT PRIMARY KEY,
        group_id TEXT,
        group_name TEXT,
        title TEXT,
        short_id TEXT,
        msp_id TEXT,
        status TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        group_id TEXT,
        turn INTEGER,
        msg_index INTEGER,
        kind TEXT NOT NULL,
        ref_id TEXT,
        surface TEXT NOT NULL DEFAULT 'meta',
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- session indexes only — group_id/surface may be missing until v1→v2 migrate
      CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_session_kind ON chunks(session_id, kind);
    `);

    // Migrate v1 → v2: if old chunks lack new columns, rebuild table
    this._migrateIfNeeded();

    // v2 indexes (safe after migrate / fresh create)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_group ON chunks(group_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_surface ON chunks(surface);
    `);

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        content='chunks',
        content_rowid='id',
        tokenize = 'trigram'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);

    this.db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(SCHEMA_VERSION));

    this._upsertStmt = this.db.prepare(`
      INSERT INTO chunks (
        chunk_id, session_id, group_id, turn, msg_index, kind, ref_id, surface, text, created_at, updated_at
      ) VALUES (
        @chunk_id, @session_id, @group_id, @turn, @msg_index, @kind, @ref_id, @surface, @text, @created_at, @updated_at
      )
      ON CONFLICT(chunk_id) DO UPDATE SET
        session_id = excluded.session_id,
        group_id = excluded.group_id,
        turn = excluded.turn,
        msg_index = excluded.msg_index,
        kind = excluded.kind,
        ref_id = excluded.ref_id,
        surface = excluded.surface,
        text = excluded.text,
        updated_at = excluded.updated_at
    `);

    this._upsertSessionDim = this.db.prepare(`
      INSERT INTO sessions_dim (session_id, group_id, group_name, title, short_id, msp_id, status, updated_at)
      VALUES (@session_id, @group_id, @group_name, @title, @short_id, @msp_id, @status, @updated_at)
      ON CONFLICT(session_id) DO UPDATE SET
        group_id=excluded.group_id,
        group_name=excluded.group_name,
        title=excluded.title,
        short_id=excluded.short_id,
        msp_id=excluded.msp_id,
        status=excluded.status,
        updated_at=excluded.updated_at
    `);

    this._upsertGroupDim = this.db.prepare(`
      INSERT INTO groups_dim (group_id, name, updated_at)
      VALUES (@group_id, @name, @updated_at)
      ON CONFLICT(group_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
    `);

    this._deleteSessionStmt = this.db.prepare(`DELETE FROM chunks WHERE session_id = ?`);
    this._deleteSessionDim = this.db.prepare(`DELETE FROM sessions_dim WHERE session_id = ?`);
    this._deleteChunkStmt = this.db.prepare(`DELETE FROM chunks WHERE chunk_id = ?`);
    this._deleteGroupDim = this.db.prepare(`DELETE FROM groups_dim WHERE group_id = ?`);

    this.enabled = true;
    console.log(`[search-index] FTS5 v${SCHEMA_VERSION} ready at ${this.dbPath}`);
  }

  _migrateIfNeeded() {
    const cols = this.db.prepare(`PRAGMA table_info(chunks)`).all().map((c) => c.name);
    // Empty brand-new table from CREATE IF NOT EXISTS already has v2 cols — ok
    if (!cols.length) return;
    const need =
      !cols.includes('group_id') ||
      !cols.includes('surface') ||
      !cols.includes('msg_index') ||
      !cols.includes('updated_at');
    if (!need) return;

    console.log('[search-index] migrating chunks table → schema v2 (will rebuild FTS on boot)…');
    // Nuclear-safe path for Guix upgrades: drop legacy FTS + chunks, recreate v2 empty.
    // Full content is re-sourced from sessions store via rebuildAll().
    try {
      this.db.exec(`
        DROP TRIGGER IF EXISTS chunks_ai;
        DROP TRIGGER IF EXISTS chunks_ad;
        DROP TRIGGER IF EXISTS chunks_au;
        DROP TABLE IF EXISTS chunks_fts;
        DROP TABLE IF EXISTS chunks_v1_legacy;
        DROP TABLE IF EXISTS chunks;
      `);
    } catch (err) {
      console.warn('[search-index] migrate drop:', err?.message || err);
    }
    this.db.exec(`
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        group_id TEXT,
        turn INTEGER,
        msg_index INTEGER,
        kind TEXT NOT NULL,
        ref_id TEXT,
        surface TEXT NOT NULL DEFAULT 'meta',
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_session_kind ON chunks(session_id, kind);
      CREATE INDEX IF NOT EXISTS idx_chunks_group ON chunks(group_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_surface ON chunks(surface);
    `);
    this.db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(SCHEMA_VERSION));
    this.db.prepare(`INSERT INTO meta(key, value) VALUES ('needs_rebuild', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run('1');
  }

  _enqueue(fn, opts = {}) {
    if (!this.enabled) return;
    this._queue.push(fn);
    if (opts.urgent) {
      if (!this._flushScheduled) {
        this._flushScheduled = true;
        queueMicrotask(() => this._flush());
      }
      return;
    }
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    setImmediate(() => this._flush());
  }

  _flush() {
    this._flushScheduled = false;
    if (!this.enabled || !this.db) {
      this._queue = [];
      return;
    }
    const batch = this._queue.splice(0, this._queue.length);
    if (!batch.length) return;
    try {
      const run = this.db.transaction(() => {
        for (const fn of batch) fn();
      });
      run();
      this._bench.writes += batch.length;
    } catch (err) {
      console.error('[search-index] flush error:', err?.message || err);
    }
  }

  flushNow() {
    this._flush();
  }

  /**
   * @param {{
   *   chunkId: string,
   *   sessionId: string,
   *   groupId?: string | null,
   *   turn?: number | null,
   *   msgIndex?: number | null,
   *   kind: string,
   *   refId?: string | null,
   *   text: string,
   *   createdAt?: string,
   *   urgent?: boolean,
   * }} row
   */
  upsertChunk(row) {
    const kind = row.kind || 'message';
    const text = clipText(row.text, kind);
    if (!text.trim()) return;
    const now = new Date().toISOString();
    const payload = {
      chunk_id: row.chunkId,
      session_id: row.sessionId,
      group_id: row.groupId ?? null,
      turn: row.turn ?? null,
      msg_index: row.msgIndex ?? null,
      kind,
      ref_id: row.refId ?? null,
      surface: row.surface || surfaceForKind(kind),
      text,
      created_at: toAt(row.createdAt, now),
      updated_at: now,
    };
    this._enqueue(() => this._upsertStmt.run(payload), { urgent: !!row.urgent });
  }

  /**
   * @param {{ id: string, name?: string, updatedAt?: string }} g
   */
  indexGroup(g, opts = {}) {
    if (!g?.id) return;
    const at = g.updatedAt || new Date().toISOString();
    const name = g.name || 'group';
    this._enqueue(() => {
      this._upsertGroupDim.run({
        group_id: g.id,
        name,
        updated_at: at,
      });
    }, { urgent: !!opts.urgent });
    // Group name as searchable chunk under a synthetic session key = group id
    // so filters by group still work when attached to sessions; also store free chunk
    this.upsertChunk({
      chunkId: `group:${g.id}`,
      sessionId: `__group__:${g.id}`,
      groupId: g.id,
      kind: 'group',
      refId: g.id,
      text: name,
      createdAt: at,
      urgent: opts.urgent,
    });
  }

  removeGroup(groupId) {
    if (!groupId) return;
    this._enqueue(() => {
      this._deleteGroupDim.run(groupId);
      this._deleteChunkStmt.run(`group:${groupId}`);
    }, { urgent: true });
  }

  /**
   * @param {any} s session
   * @param {{ groupName?: string, urgent?: boolean }} [opts]
   */
  upsertSessionDim(s, opts = {}) {
    if (!s?.id || !this.enabled) return;
    const at = toAt(s.updatedAt) || toAt(s.createdAt) || new Date().toISOString();
    const payload = {
      session_id: s.id,
      group_id: s.groupId || null,
      group_name: opts.groupName || null,
      title: s.title || null,
      short_id: String(s.id).slice(0, 8),
      msp_id: s.mspSessionId || null,
      status: s.status || 'idle',
      updated_at: at,
    };
    this._enqueue(() => this._upsertSessionDim.run(payload), { urgent: !!opts.urgent });
  }

  /**
   * @param {any} s
   * @param {{ groupName?: string, urgent?: boolean }} [opts]
   */
  indexSessionShell(s, opts = {}) {
    if (!s?.id) return;
    const at = toAt(s.updatedAt) || toAt(s.createdAt) || new Date().toISOString();
    this.upsertSessionDim(s, opts);
    const parts = [
      s.title,
      s.id,
      s.mspSessionId,
      s.cwd,
      s.agent,
      s.model || s.modelId,
      s.effort,
      s.status,
      opts.groupName,
    ].filter(Boolean);
    this.upsertChunk({
      chunkId: `shell:${s.id}`,
      sessionId: s.id,
      groupId: s.groupId,
      kind: 'shell',
      refId: 'shell',
      text: parts.join(' '),
      createdAt: at,
      urgent: opts.urgent,
    });
    if (s.title) {
      this.indexTitle(s.id, s.title, at, { groupId: s.groupId, urgent: opts.urgent });
    }
  }

  indexTitle(sessionId, title, at, opts = {}) {
    this.upsertChunk({
      chunkId: `title:${sessionId}`,
      sessionId,
      groupId: opts.groupId ?? null,
      kind: 'title',
      refId: 'title',
      text: title || '',
      createdAt: at,
      urgent: opts.urgent,
    });
  }

  /**
   * @param {string} sessionId
   * @param {number} index
   * @param {string} role
   * @param {string} content
   * @param {string} [at]
   * @param {number | null} [turn]
   * @param {{ groupId?: string, urgent?: boolean }} [opts]
   */
  indexMessage(sessionId, index, role, content, at, turn = null, opts = {}) {
    const kind = role === 'error' ? 'error' : role || 'message';
    this.upsertChunk({
      chunkId: `msg:${sessionId}:${index}`,
      sessionId,
      groupId: opts.groupId ?? null,
      turn,
      msgIndex: index,
      kind,
      refId: String(index),
      text: content || '',
      createdAt: at,
      urgent: opts.urgent !== false,
    });
  }

  indexLiveAssistant(sessionId, turn, content, at, opts = {}) {
    this.upsertChunk({
      chunkId: `live:${sessionId}:${turn || 0}:assistant`,
      sessionId,
      groupId: opts.groupId ?? null,
      turn: turn ?? null,
      kind: 'assistant_live',
      refId: 'live',
      text: content || '',
      createdAt: at,
      urgent: true,
    });
  }

  clearLiveAssistant(sessionId, turn) {
    const chunkId = `live:${sessionId}:${turn || 0}:assistant`;
    this._enqueue(() => this._deleteChunkStmt.run(chunkId), { urgent: true });
  }

  indexTurnPreview(sessionId, turn, preview, at, opts = {}) {
    this.upsertChunk({
      chunkId: `turn:${sessionId}:${turn}:preview`,
      sessionId,
      groupId: opts.groupId ?? null,
      turn,
      kind: 'turn',
      refId: `t${turn}`,
      text: preview || '',
      createdAt: at,
      urgent: opts.urgent,
    });
  }

  indexToolItem(sessionId, turn, item, at, opts = {}) {
    // Muse tool records carry `id` (sessions.js tool_call case); the ACP
    // wire ids are kept as fallbacks for foreign shapes.
    const tid = item?.id || item?.toolCallId || item?.tool_call_id || 'x';
    // Prefer the message scope when known so incremental and rebuild chunk
    // ids are identical (muse tools hang off a settled message, not a turn).
    const scope = opts.msgIndex ?? turn;
    const label = [item?.kind, item?.title, item?.agentType, item?.status]
      .filter(Boolean)
      .join(' ');
    if (label.trim()) {
      this.upsertChunk({
        chunkId: `tool:${sessionId}:${scope}:${tid}`,
        sessionId,
        groupId: opts.groupId ?? null,
        turn,
        msgIndex: opts.msgIndex ?? null,
        kind: item?.isAgent ? 'agent' : 'tool',
        refId: String(tid),
        text: label,
        createdAt: at,
        urgent: opts.urgent !== false,
      });
    }
    const out = typeof item?.output === 'string' ? item.output : '';
    if (out.trim()) {
      this.upsertChunk({
        chunkId: `toolout:${sessionId}:${scope}:${tid}`,
        sessionId,
        groupId: opts.groupId ?? null,
        turn,
        msgIndex: opts.msgIndex ?? null,
        kind: 'tool_out',
        refId: String(tid),
        text: out,
        createdAt: at,
        urgent: opts.urgent !== false,
      });
    }
  }

  removeSession(sessionId) {
    if (!sessionId) return;
    this._enqueue(() => {
      this._deleteSessionStmt.run(sessionId);
      this._deleteSessionDim.run(sessionId);
    }, { urgent: true });
  }

  /**
   * Index one assistant message's settled extras (tool calls + plan live in
   * muse's message meta, not in a turnActivity array like grok's).
   */
  indexMessageExtras(sessionId, msgIndex, msg, at, opts = {}) {
    const m = msg || {};
    const turn = opts.turn ?? null;
    const tools = Array.isArray(m.meta?.toolCalls) ? m.meta.toolCalls : [];
    for (const item of tools) {
      this.indexToolItem(sessionId, turn, item, at, { ...opts, msgIndex });
    }
    const planText = planEntriesText(m.meta?.plan);
    if (planText) {
      this.upsertChunk({
        chunkId: `plan:${sessionId}:${msgIndex}`,
        sessionId,
        groupId: opts.groupId ?? null,
        turn,
        msgIndex,
        kind: 'plan',
        refId: String(msgIndex),
        text: planText,
        createdAt: at,
        urgent: opts.urgent,
      });
    }
  }

  /**
   * Re-index one session from scratch (used after trimMessages shifts the
   * positional msg: indexes — cheaper than tracking the drift).
   * @param {any} s chat with messages
   * @param {{ groupName?: string }} [opts]
   */
  reindexSession(s, opts = {}) {
    if (!s?.id || !this.enabled || !this.db) return;
    this._flush();
    try {
      const tx = this.db.transaction(() => {
        this._deleteSessionStmt.run(s.id);
        this._deleteSessionDim.run(s.id);
      });
      tx();
    } catch (err) {
      console.error('[search-index] reindex clear failed:', err?.message || err);
      return;
    }
    const gname = opts.groupName || null;
    this.indexSessionShell(s, { groupName: gname, urgent: true });
    const msgs = Array.isArray(s.messages) ? s.messages : [];
    msgs.forEach((m, i) => {
      if (!m?.text) return;
      const kind = m.role === 'error' ? 'error' : m.role || 'message';
      const turn = turnForMessageIndex(msgs, i);
      this.indexMessage(s.id, i, kind === 'error' ? 'error' : m.role, m.text, toAt(m.ts), turn, {
        groupId: s.groupId,
        urgent: false,
      });
      this.indexMessageExtras(s.id, i, m, toAt(m.ts), { groupId: s.groupId, turn, urgent: false });
    });
    this._flush();
  }

  /**
   * Full rebuild from in-memory sessions + groups.
   * @param {Iterable<any>} sessions
   * @param {Iterable<any>} [groups]
   */
  rebuildAll(sessions, groups = []) {
    if (!this.enabled || !this.db) return { ok: false, error: this._error || 'disabled' };
    this._flush();
    const list = [...sessions];
    const glist = [...groups];
    /** @type {Map<string, string>} */
    const groupNames = new Map();
    for (const g of glist) {
      if (g?.id) groupNames.set(g.id, g.name || 'group');
    }

    try {
      const t0 = Date.now();
      const tx = this.db.transaction(() => {
        this.db.exec('DELETE FROM chunks');
        this.db.exec('DELETE FROM sessions_dim');
        this.db.exec('DELETE FROM groups_dim');
        // FTS content rebuilt via triggers on insert

        for (const g of glist) {
          if (!g?.id) continue;
          this._upsertGroupDim.run({
            group_id: g.id,
            name: g.name || 'group',
            updated_at: g.updatedAt || new Date().toISOString(),
          });
          this._upsertStmt.run({
            chunk_id: `group:${g.id}`,
            session_id: `__group__:${g.id}`,
            group_id: g.id,
            turn: null,
            msg_index: null,
            kind: 'group',
            ref_id: g.id,
            surface: 'meta',
            text: clipText(g.name || 'group'),
            created_at: g.updatedAt || new Date().toISOString(),
            updated_at: g.updatedAt || new Date().toISOString(),
          });
        }

        for (const s of list) {
          if (!s?.id) continue;
          const sid = s.id;
          const gname = groupNames.get(s.groupId) || null;
          const at0 = toAt(s.updatedAt) || toAt(s.createdAt) || new Date().toISOString();
          this._upsertSessionDim.run({
            session_id: sid,
            group_id: s.groupId || null,
            group_name: gname,
            title: s.title || null,
            short_id: String(sid).slice(0, 8),
            msp_id: s.mspSessionId || null,
            status: s.status || 'idle',
            updated_at: at0,
          });
          const shellParts = [
            s.title, s.id, s.mspSessionId, s.cwd, s.agent, s.model || s.modelId, s.effort, s.status, gname,
          ].filter(Boolean);
          this._upsertStmt.run({
            chunk_id: `shell:${sid}`,
            session_id: sid,
            group_id: s.groupId || null,
            turn: null,
            msg_index: null,
            kind: 'shell',
            ref_id: 'shell',
            surface: 'meta',
            text: clipText(shellParts.join(' ')),
            created_at: at0,
            updated_at: at0,
          });
          if (s.title) {
            this._upsertStmt.run({
              chunk_id: `title:${sid}`,
              session_id: sid,
              group_id: s.groupId || null,
              turn: null,
              msg_index: null,
              kind: 'title',
              ref_id: 'title',
              surface: 'session',
              text: clipText(s.title),
              created_at: at0,
              updated_at: at0,
            });
          }
          // Muse message shape: { id, role, text, ts, meta? } with tool
          // calls + plan tucked in meta (no turnActivity array like grok).
          const msgs = Array.isArray(s.messages) ? s.messages : [];
          msgs.forEach((m, i) => {
            if (!m?.text) return;
            const kind = m.role === 'error' ? 'error' : m.role || 'message';
            const turn = turnForMessageIndex(msgs, i);
            const mat = toAt(m.ts) || at0;
            this._upsertStmt.run({
              chunk_id: `msg:${sid}:${i}`,
              session_id: sid,
              group_id: s.groupId || null,
              turn,
              msg_index: i,
              kind,
              ref_id: String(i),
              surface: surfaceForKind(kind),
              text: clipText(m.text, kind),
              created_at: mat,
              updated_at: mat,
            });
            const tools = Array.isArray(m.meta?.toolCalls) ? m.meta.toolCalls : [];
            for (const item of tools) {
              const tid = item?.id || item?.toolCallId || item?.tool_call_id || 'x';
              const label = [item?.kind, item?.title, item?.agentType, item?.status]
                .filter(Boolean)
                .join(' ');
              if (label.trim()) {
                this._upsertStmt.run({
                  chunk_id: `tool:${sid}:${i}:${tid}`,
                  session_id: sid,
                  group_id: s.groupId || null,
                  turn,
                  msg_index: i,
                  kind: item?.isAgent ? 'agent' : 'tool',
                  ref_id: String(tid),
                  surface: 'activity',
                  text: clipText(label, 'tool'),
                  created_at: mat,
                  updated_at: mat,
                });
              }
              const out = typeof item?.output === 'string' ? item.output : '';
              if (out.trim()) {
                this._upsertStmt.run({
                  chunk_id: `toolout:${sid}:${i}:${tid}`,
                  session_id: sid,
                  group_id: s.groupId || null,
                  turn,
                  msg_index: i,
                  kind: 'tool_out',
                  ref_id: String(tid),
                  surface: 'console',
                  text: clipText(out, 'tool_out'),
                  created_at: mat,
                  updated_at: mat,
                });
              }
            }
            const planText = planEntriesText(m.meta?.plan);
            if (planText) {
              this._upsertStmt.run({
                chunk_id: `plan:${sid}:${i}`,
                session_id: sid,
                group_id: s.groupId || null,
                turn,
                msg_index: i,
                kind: 'plan',
                ref_id: String(i),
                surface: 'meta',
                text: clipText(planText, 'default'),
                created_at: mat,
                updated_at: mat,
              });
            }
          });
        }
        this.db.prepare(`INSERT INTO meta(key,value) VALUES('rebuilt_at',?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(new Date().toISOString());
      });
      tx();
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()?.n || 0;
      const ms = Date.now() - t0;
      console.log(`[search-index] rebuilt ${count} chunks from ${list.length} sessions in ${ms}ms`);
      return { ok: true, chunks: count, sessions: list.length, groups: glist.length, ms };
    } catch (err) {
      console.error('[search-index] rebuild failed:', err?.message || err);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  /**
   * @param {string} query
   * @param {{
   *   limit?: number,
   *   sessionMeta?: Map<string, any>,
   *   groupId?: string,
   *   kind?: string,
   *   surface?: string,
   * }} [opts]
   */
  search(query, opts = {}) {
    const t0 = Date.now();
    const limit = Math.min(80, Math.max(1, Number(opts.limit) || 40));
    const qRaw = String(query || '').trim();
    if (!qRaw) {
      return { ok: true, query: qRaw, engine: 'fts5', hits: [], total: 0, tookMs: 0 };
    }

    if (!this.enabled || !this.db) {
      return {
        ok: false,
        query: qRaw,
        engine: 'disabled',
        error: this._error || 'search index unavailable',
        hits: [],
        total: 0,
        tookMs: Date.now() - t0,
      };
    }

    this.flushNow();

    const { free, filters } = parseSearchQuery(qRaw);
    if (opts.groupId) filters.group = String(opts.groupId).toLowerCase();
    if (opts.kind) filters.kind = String(opts.kind).toLowerCase();
    if (opts.surface) filters.surface = String(opts.surface).toLowerCase();

    const fts = free ? toFtsQuery(free) : null;
    // Terms < 3 chars are not in the trigram index — exact LIKE scan instead.
    const likeTerms = free && needsLikeScan(free) ? splitQueryTerms(free) : null;
    // If only operators, match all via sessions_dim later
    let rows = [];
    try {
      if (likeTerms) {
        const where = likeTerms.map(() => `text LIKE ? ESCAPE '\\'`).join(' AND ');
        const stmt = this.db.prepare(`
          SELECT
            chunk_id AS chunkId, session_id AS sessionId, group_id AS groupId,
            turn, msg_index AS msgIndex, kind, ref_id AS refId, surface,
            created_at AS createdAt, updated_at AS updatedAt,
            substr(text, 1, 120) AS snippet, 0 AS rank
          FROM chunks
          WHERE ${where}
          ORDER BY updated_at DESC
          LIMIT ?
        `);
        rows = stmt.all(...likeTerms.map((t) => `%${escapeLike(t)}%`), limit * 6);
      } else if (fts) {
        const stmt = this.db.prepare(`
          SELECT
            c.chunk_id AS chunkId,
            c.session_id AS sessionId,
            c.group_id AS groupId,
            c.turn AS turn,
            c.msg_index AS msgIndex,
            c.kind AS kind,
            c.ref_id AS refId,
            c.surface AS surface,
            c.created_at AS createdAt,
            c.updated_at AS updatedAt,
            snippet(chunks_fts, 0, '[', ']', '…', 16) AS snippet,
            bm25(chunks_fts) AS rank
          FROM chunks_fts
          JOIN chunks c ON c.id = chunks_fts.rowid
          WHERE chunks_fts MATCH ?
          ORDER BY rank
          LIMIT ?
        `);
        rows = stmt.all(fts, limit * 6);
      } else {
        // operator-only: pull recent chunks (filtered below)
        rows = this.db.prepare(`
          SELECT
            chunk_id AS chunkId, session_id AS sessionId, group_id AS groupId,
            turn, msg_index AS msgIndex, kind, ref_id AS refId, surface,
            created_at AS createdAt, updated_at AS updatedAt,
            substr(text, 1, 120) AS snippet, 0 AS rank
          FROM chunks
          ORDER BY updated_at DESC
          LIMIT ?
        `).all(limit * 6);
      }
    } catch (err) {
      try {
        if (free) {
          const simple = `"${free.replace(/"/g, '""')}"`;
          rows = this.db.prepare(`
            SELECT c.chunk_id AS chunkId, c.session_id AS sessionId, c.group_id AS groupId,
              c.turn AS turn, c.msg_index AS msgIndex, c.kind AS kind, c.ref_id AS refId,
              c.surface AS surface, c.created_at AS createdAt, c.updated_at AS updatedAt,
              snippet(chunks_fts, 0, '[', ']', '…', 16) AS snippet, bm25(chunks_fts) AS rank
            FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
            WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?
          `).all(simple, limit * 6);
        }
      } catch (err2) {
        return {
          ok: false,
          query: qRaw,
          engine: 'fts5',
          error: err2?.message || err?.message || String(err2),
          hits: [],
          total: 0,
          tookMs: Date.now() - t0,
        };
      }
    }

    // Load dims for chrome
    const dimBySid = new Map();
    try {
      for (const d of this.db.prepare(`SELECT * FROM sessions_dim`).all()) {
        dimBySid.set(d.session_id, d);
      }
    } catch { /* empty */ }

    const meta = opts.sessionMeta || new Map();
    /** @type {Map<string, any>} */
    const bySession = new Map();

    for (const r of rows) {
      // Skip synthetic group-only rows in session grouping unless matching group search
      const isGroupChunk = r.kind === 'group' || String(r.sessionId || '').startsWith('__group__:');

      if (filters.kind && String(r.kind).toLowerCase() !== filters.kind) continue;
      if (filters.surface && String(r.surface || surfaceForKind(r.kind)).toLowerCase() !== filters.surface) {
        continue;
      }

      let groupId = r.groupId;
      let groupName = null;
      let title = 'แชท';
      let status = 'idle';
      let updatedAt = r.updatedAt || r.createdAt || '';
      let shortId = String(r.sessionId || '').slice(0, 8);

      if (isGroupChunk) {
        groupId = r.groupId || (r.refId || null);
        groupName = (r.snippet || '').replace(/[\[\]]/g, '') || groupId;
        // Represent as pseudo-hit keyed by group
        const key = `g:${groupId}`;
        if (filters.group && !String(groupName || '').toLowerCase().includes(filters.group)
          && !String(groupId || '').toLowerCase().includes(filters.group)) {
          continue;
        }
        let hit = bySession.get(key);
        if (!hit) {
          hit = {
            sessionId: null,
            groupId,
            groupName,
            shortId: String(groupId || '').slice(0, 8),
            title: groupName || 'Group',
            status: 'idle',
            score: 0,
            matches: [],
            updatedAt,
            hitType: 'group',
          };
          bySession.set(key, hit);
        }
        hit.score += 20;
        if (hit.matches.length < 6) {
          hit.matches.push({
            field: 'group',
            kind: 'group',
            surface: 'meta',
            snippet: r.snippet || groupName,
            turn: undefined,
            msgIndex: undefined,
            refId: groupId,
          });
        }
        continue;
      }

      const dim = dimBySid.get(r.sessionId);
      const m = meta.get(r.sessionId) || {};
      groupId = groupId || dim?.group_id || m.groupId || null;
      groupName = dim?.group_name || m.groupName || null;
      title = dim?.title || m.title || 'แชท';
      status = dim?.status || m.status || 'idle';
      updatedAt = dim?.updated_at || m.updatedAt || updatedAt;
      shortId = dim?.short_id || m.shortId || shortId;

      if (filters.group) {
        const gblob = `${groupName || ''} ${groupId || ''}`.toLowerCase();
        if (!gblob.includes(filters.group)) continue;
      }
      if (filters.sessionId) {
        const sblob = `${r.sessionId} ${shortId} ${dim?.msp_id || ''}`.toLowerCase();
        if (!sblob.includes(filters.sessionId)) continue;
      }
      if (filters.isRunning && !/run|start/i.test(status)) continue;

      let hit = bySession.get(r.sessionId);
      if (!hit) {
        hit = {
          sessionId: r.sessionId,
          groupId,
          groupName,
          shortId,
          title,
          status,
          score: 0,
          matches: [],
          updatedAt,
          hitType: 'session',
        };
        bySession.set(r.sessionId, hit);
      }
      const bm = typeof r.rank === 'number' ? r.rank : 0;
      const piece = Math.max(0.1, 10 - bm);
      hit.score += piece * kindBoost(r.kind);
      // mild recency
      if (updatedAt) {
        const ageH = Math.max(0, (Date.now() - Date.parse(updatedAt)) / 3600000);
        hit.score += Math.max(0, 2 - ageH / 24);
      }
      if (hit.matches.length < 8) {
        hit.matches.push({
          field: r.kind,
          kind: r.kind,
          surface: r.surface || surfaceForKind(r.kind),
          snippet: r.snippet || '',
          turn: r.turn ?? undefined,
          msgIndex: r.msgIndex ?? undefined,
          refId: r.refId || undefined,
          chunkId: r.chunkId,
        });
      }
    }

    const hits = [...bySession.values()]
      .sort((a, b) => b.score - a.score || (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit);

    const tookMs = Date.now() - t0;
    this._bench.lastSearchMs = tookMs;
    this._bench.searchMs += tookMs;

    return {
      ok: true,
      query: qRaw,
      engine: 'fts5',
      hits,
      total: bySession.size,
      tookMs,
      filters,
    };
  }

  /**
   * Find-in-session: full-text search restricted to ONE session, returning a
   * flat, chronological list of matches (not session-grouped like search()).
   *
   * `generatedOnly` (default true) keeps only model/system-produced content and
   * drops the user's own prompts / slash-commands and pure meta — so the box
   * matches "what was generated", never the command that triggered it.
   *
   * @param {string} sessionId
   * @param {string} query
   * @param {{ limit?: number, generatedOnly?: boolean }} [opts]
   * @returns {{ ok: boolean, engine: string, sessionId: string, generatedOnly: boolean, hits: Array<object>, total: number, tookMs: number, error?: string }}
   */
  searchInSession(sessionId, query, opts = {}) {
    const t0 = Date.now();
    const sid = String(sessionId || '').trim();
    const limit = Math.min(200, Math.max(1, Number(opts.limit) || 80));
    const generatedOnly = opts.generatedOnly !== false;
    const qRaw = String(query || '').trim();

    const base = {
      ok: true,
      engine: 'fts5',
      sessionId: sid,
      generatedOnly,
      hits: [],
      total: 0,
      tookMs: 0,
    };
    if (!sid || !qRaw) return { ...base, tookMs: Date.now() - t0 };
    if (!this.enabled || !this.db) {
      return {
        ...base,
        ok: false,
        engine: 'disabled',
        error: this._error || 'search index unavailable',
        tookMs: Date.now() - t0,
      };
    }

    this.flushNow();

    const { free } = parseSearchQuery(qRaw);
    const fts = free ? toFtsQuery(free) : toFtsQuery(qRaw);
    if (!fts) return { ...base, tookMs: Date.now() - t0 };
    const likeTerms = needsLikeScan(free || qRaw) ? splitQueryTerms(free || qRaw) : null;

    const run = (matchExpr) =>
      this.db
        .prepare(`
          SELECT
            c.chunk_id AS chunkId,
            c.turn AS turn,
            c.msg_index AS msgIndex,
            c.kind AS kind,
            c.ref_id AS refId,
            c.surface AS surface,
            snippet(chunks_fts, 0, '[', ']', '…', 24) AS snippet,
            bm25(chunks_fts) AS rank
          FROM chunks_fts
          JOIN chunks c ON c.id = chunks_fts.rowid
          WHERE chunks_fts MATCH ? AND c.session_id = ?
          ORDER BY rank
          LIMIT ?
        `)
        .all(matchExpr, sid, limit * 4);

    const runLike = (terms) => {
      const where = terms.map(() => `text LIKE ? ESCAPE '\\'`).join(' AND ');
      return this.db
        .prepare(`
          SELECT
            chunk_id AS chunkId,
            turn,
            msg_index AS msgIndex,
            kind,
            ref_id AS refId,
            surface,
            substr(text, 1, 120) AS snippet,
            0 AS rank
          FROM chunks
          WHERE session_id = ? AND ${where}
          ORDER BY updated_at DESC
          LIMIT ?
        `)
        .all(sid, ...terms.map((t) => `%${escapeLike(t)}%`), limit * 4);
    };

    let rows = [];
    try {
      rows = likeTerms ? runLike(likeTerms) : run(fts);
    } catch (err) {
      try {
        rows = likeTerms ? runLike(likeTerms) : run(`"${(free || qRaw).replace(/"/g, '""')}"`);
      } catch (err2) {
        return {
          ...base,
          ok: false,
          error: err2?.message || err?.message || String(err2),
          tookMs: Date.now() - t0,
        };
      }
    }

    const hits = [];
    for (const r of rows) {
      const kind = String(r.kind || '');
      if (generatedOnly && !GENERATED_KINDS.has(kind)) continue;
      hits.push({
        chunkId: r.chunkId,
        turn: r.turn ?? null,
        msgIndex: r.msgIndex ?? null,
        kind,
        surface: r.surface || surfaceForKind(kind),
        snippet: r.snippet || '',
        refId: r.refId || null,
        rank: typeof r.rank === 'number' ? r.rank : 0,
      });
    }

    // Chronological order (top → bottom of transcript) for find-in-page flow.
    hits.sort((a, b) => {
      const ta = a.turn ?? 1e9;
      const tb = b.turn ?? 1e9;
      if (ta !== tb) return ta - tb;
      const ma = a.msgIndex ?? 1e9;
      const mb = b.msgIndex ?? 1e9;
      if (ma !== mb) return ma - mb;
      return a.rank - b.rank;
    });

    const total = hits.length;
    const tookMs = Date.now() - t0;
    this._bench.lastSearchMs = tookMs;
    return { ...base, hits: hits.slice(0, limit), total, tookMs };
  }

  stats() {
    if (!this.enabled || !this.db) {
      return {
        enabled: false,
        error: this._error,
        schemaVersion: SCHEMA_VERSION,
        path: this.dbPath,
      };
    }
    this._flush();
    const chunks = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get()?.n || 0;
    const sessions = this.db.prepare(
      `SELECT COUNT(*) AS n FROM sessions_dim`,
    ).get()?.n || 0;
    const groups = this.db.prepare(`SELECT COUNT(*) AS n FROM groups_dim`).get()?.n || 0;
    const byKind = this.db.prepare(
      `SELECT kind, COUNT(*) AS n FROM chunks GROUP BY kind ORDER BY n DESC`,
    ).all();
    return {
      enabled: true,
      path: this.dbPath,
      chunks,
      sessions,
      groups,
      schemaVersion: SCHEMA_VERSION,
      byKind,
      bench: { ...this._bench },
    };
  }

  close() {
    try {
      this._flush();
      this.db?.close();
    } catch { /* ignore */ }
    this.db = null;
    this.enabled = false;
  }
}
