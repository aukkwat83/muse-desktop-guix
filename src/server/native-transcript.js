// Native child transcripts: read-only projection of a delegated subagent's
// own session log onto drill items.
//
// Grounded in first-party docs (read-session SKILL.md + doctor
// session-evidence.py), not guessed:
//
//   ${XDG_DATA_HOME:-$HOME/.local/share}/muse/sessions/YYYY/MM/DD/<parent>/
//     session.jsonl                  — parent log (workspace metadata here)
//     subagent/<child>/session.jsonl — one log per delegated child
//
// The dir name is the child SESSION id, not the spawn's subagent_id — the
// parent log's own `subagent.control.child_session_bound` records map one
// to the other, and the adapter resolves through them (exact match, this
// parent's log only).
//
// Each line is an event-log envelope {payload_type, payload:{kind, run_id,
// event:{kind,...}}}. We project ONLY committed visible content — user /
// assistant messages, tool calls + results, terminal markers — and skip
// everything else (system context, provider payloads, reasoning,
// approvals, compaction). The useful event kinds come straight from the
// read-session doc; user_prompt_display is deliberately NOT projected
// (its text field is undocumented and the first-party projection ignores
// it too — never invent schema).
//
// Safety contract (the caller gets honest fallback on ANY failure):
// - parent resolves ONLY to the owning parent id stamped on the record at
//   fold time (never the current session after rotation), by EXACT dirname
//   match under the sessions root — never a cross-parent child search, and
//   evidence_refs strings are never resolved as paths;
// - the parent log's durable workspace metadata must verify against the
//   chat cwd (same rule as session-evidence.py: cwd under recorded root);
// - every selected log must be a real regular file canonically inside its
//   exact subtree (links refused), and every present stream session id
//   must equal the selected session's own id (verified against real logs:
//   stream.id is always the owning session id);
// - bounded reads (1MB tail window, truncation surfaced), bounded items
//   (200, head dropped), malformed lines counted + surfaced as a notice,
//   a partial last JSON line (mid-write, no trailing newline) ignored
//   rather than counted.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Tail window per read — a runaway log never OOMs a drill poll. */
export const NATIVE_LOG_MAX_BYTES = 1_048_576;
/** Drill item cap, mirroring the session drill's 200-row window. */
export const NATIVE_LOG_MAX_ITEMS = 200;
/** Parent lookup walk bound (date-shard readdirs). */
export const NATIVE_LOOKUP_MAX_DIRS = 5000;
/** Workspace metadata scan bound (lines from the parent log head). */
export const NATIVE_META_MAX_LINES = 5000;
/** Args preview per tool call — full write_file bodies never hit a row. */
export const NATIVE_ARGS_PREVIEW_MAX = 500;
/** Binding scan window (bytes from the parent log tail). Parent logs are
 * append-only and fat; bindings live near their spawn, so a window past
 * the cap degrades to honest fallback for ancient children. */
export const NATIVE_BINDING_MAX_BYTES = 64 * 1024 * 1024;
/** Bound subagent→session binding cache (mtime+size keyed per parent). */
export const NATIVE_BINDING_CACHE_MAX = 500;

/** First-party session id vocabulary (session-evidence.py SESSION_ID). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

export function nativeDataRoot() {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

/** Canonical path for containment checks — realpath, resolving symlinks. */
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function withinDir(file, dir) {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * A log path is only readable when it is a REAL regular file canonically
 * inside the exact selected subtree — a symlink at A/session.jsonl pointing
 * at sibling B's log (or the parent log) must never read as A's own.
 * Throws PATH_ESCAPE for link/escape games, missingCode when simply absent.
 */
function assertRegularFileInside(logPath, subtreeReal, missingCode, missingMessage) {
  let lst;
  try {
    lst = fs.lstatSync(logPath);
  } catch {
    fail(missingCode, missingMessage);
  }
  if (lst.isSymbolicLink()) fail('PATH_ESCAPE', 'session log is a link, not the selected log');
  if (!lst.isFile()) fail(missingCode, missingMessage);
  if (!withinDir(canonical(logPath), subtreeReal)) {
    fail('PATH_ESCAPE', 'session log escapes the selected session subtree');
  }
  return logPath;
}

/**
 * Locate the owning parent's session dir by EXACT dirname match under the
 * date-sharded store. Only top-level parent dirs count (a `subagent/`
 * segment in the relative path disqualifies — a child id must never
 * resolve as a parent). Ambiguity refuses: two dates holding the same
 * parent id is not something to guess between.
 */
export function findParentSessionDir(dataRoot, parentId) {
  if (!isSafeSessionId(parentId)) fail('INVALID_PARENT_ID', `unsafe parent session id ${String(parentId).slice(0, 60)}`);
  const sessionsRoot = path.join(String(dataRoot), 'muse', 'sessions');
  let rootStat = null;
  try {
    rootStat = fs.statSync(sessionsRoot);
  } catch { /* missing → not found below */ }
  if (!rootStat?.isDirectory()) fail('SESSIONS_ROOT_MISSING', 'no retained sessions root under the data directory');
  const rootReal = canonical(sessionsRoot);
  const matches = [];
  let dirs = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory()) continue;
      if (++dirs > NATIVE_LOOKUP_MAX_DIRS) return;
      const full = path.join(dir, e.name);
      if (e.name === parentId) {
        const rel = path.relative(sessionsRoot, full);
        const log = path.join(full, 'session.jsonl');
        let valid = false;
        try {
          // The parent log must be a real file inside the parent dir — a
          // link to a sibling (or anywhere else) disqualifies the match.
          assertRegularFileInside(log, canonical(full), 'LOG_MISSING', 'no session log');
          valid = true;
        } catch { /* not a readable session dir */ }
        if (valid && !rel.split(path.sep).includes('subagent') && withinDir(canonical(full), rootReal)) {
          matches.push(full);
        }
        continue; // never descend into the match itself
      }
      if (depth < 4) walk(full, depth + 1);
    }
  };
  walk(sessionsRoot, 0);
  if (matches.length > 1) fail('PARENT_AMBIGUOUS', 'more than one retained session matches the owning parent id');
  if (!matches.length) fail('PARENT_NOT_FOUND', 'no retained session matches the owning parent id');
  return matches[0];
}

/**
 * Verify the parent log's durable workspace metadata against the chat cwd —
 * the same rule as session-evidence.py: the chat cwd must sit under the
 * recorded workspace_root. Missing metadata refuses (unknown provenance
 * is not verified provenance).
 */
export function verifyParentWorkspace(parentDir, chatCwd) {
  const logPath = path.join(parentDir, 'session.jsonl');
  const parentId = path.basename(parentDir);
  let fh = null;
  try {
    fh = fs.openSync(logPath, 'r');
  } catch {
    return { ok: false, reason: 'NO_LOG' };
  }
  try {
    const size = fs.fstatSync(fh).size;
    const head = Buffer.alloc(Math.min(size, 262_144));
    fs.readSync(fh, head, 0, head.length, 0);
    const lines = head.toString('utf8').split('\n');
    let latest = null;
    const limit = Math.min(lines.length, NATIVE_META_MAX_LINES);
    for (let i = 0; i < limit; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch { continue; }
      if (!record || typeof record !== 'object') continue;
      // Stream session check: every present stream id must be the parent's
      // own — a foreign stream means this is not the parent's log.
      const sid = record.stream?.id;
      if (typeof sid === 'string' && sid !== parentId) {
        return { ok: false, reason: 'STREAM_MISMATCH' };
      }
      const payload = record.payload;
      if (!payload || typeof payload !== 'object') continue;
      if (record.payload_type === 'runtime.session.metadata') {
        const ws = payload.workspace_root;
        const nested = payload.record;
        if (typeof ws === 'string') latest = ws;
        else if (nested && typeof nested === 'object' && typeof nested.workspace_root === 'string') {
          latest = nested.workspace_root;
        }
      } else if (record.payload_type === 'runtime.session') {
        const event = payload.event;
        if (event && typeof event === 'object' && event.kind === 'context_projection_checkpoint') {
          const meta = event.session_metadata;
          if (meta && typeof meta === 'object' && typeof meta.workspace_root === 'string') {
            latest = meta.workspace_root;
          }
        }
      }
    }
    if (typeof latest !== 'string' || !latest) return { ok: false, reason: 'WORKSPACE_UNKNOWN' };
    const recorded = canonical(latest);
    const cwd = canonical(String(chatCwd || ''));
    if (cwd !== recorded && !withinDir(cwd, recorded)) return { ok: false, reason: 'WORKSPACE_MISMATCH' };
    return { ok: true, workspace: recorded };
  } finally {
    try { fs.closeSync(fh); } catch { /* ignore */ }
  }
}

/**
 * Resolve the child's log under its OWNING parent only. The child id is an
 * exact safe segment — never a path, never searched across parents.
 */
export function resolveNativeChildLog(parentDir, childId) {
  if (!isSafeSessionId(childId)) fail('INVALID_CHILD_ID', `unsafe child session id ${String(childId).slice(0, 60)}`);
  const parentReal = canonical(parentDir);
  const childDir = path.join(parentReal, 'subagent', childId);
  const childReal = canonical(childDir);
  if (!withinDir(childReal, parentReal)) fail('PATH_ESCAPE', 'child dir escapes its owning parent');
  const logPath = path.join(childDir, 'session.jsonl');
  // Exact-subtree containment: the log must be a real file inside THIS
  // child's own dir — a link to a sibling child's log or the parent log
  // reads as foreign content and is refused.
  assertRegularFileInside(logPath, childReal, 'LOG_MISSING', 'no retained log for this child under its owning parent');
  return logPath;
}

/** First-party tool leaf name (session-evidence.py _tool_name). */
function toolLeaf(name) {
  if (typeof name !== 'string') return '';
  let out = name;
  for (const sep of ['__', '.', '/']) {
    if (out.includes(sep)) out = out.split(sep).pop();
  }
  return out;
}

/** First-party args shape (dict, or a JSON string holding one). */
function toolArgs(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* not JSON — no args shape */ }
  }
  return {};
}

/** First-party path carrier keys (session-evidence.py _path_from_args). */
function pathFromArgs(args) {
  for (const key of ['path', 'file_path', 'target_path', 'target', 'filename']) {
    if (typeof args[key] === 'string') return args[key];
  }
  return null;
}

function oneLine(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Project one child log onto drill-shaped items (unsanitized — the caller
 * runs sanitizeDrillItem). Returns { items, terminal, runState,
 * malformed, partialIgnored, droppedFromHead, byteTruncated,
 * bytesSkipped, bytesRead }.
 *
 * runState is the LATEST run's state: 'running' until its terminal marker
 * lands, 'terminal' after. A new run resets the previous run's terminal —
 * a prior `completed` must never mark the current run's tools done.
 *
 * opts.expectedStreamId pins every present stream session id to the
 * selected child (verified against real logs: stream.id is always the
 * owning session id). Mismatch throws STREAM_MISMATCH.
 */
export function readNativeTranscript(logPath, opts = {}) {
  const maxBytes = opts.maxBytes ?? NATIVE_LOG_MAX_BYTES;
  const maxItems = opts.maxItems ?? NATIVE_LOG_MAX_ITEMS;
  const expectedStreamId = opts.expectedStreamId ?? null;
  let st;
  try {
    st = fs.statSync(logPath);
  } catch {
    fail('LOG_MISSING', 'child log is unavailable');
  }
  if (!st.isFile()) fail('LOG_MISSING', 'child log is unavailable');
  const size = Math.max(0, st.size);
  const start = Math.max(0, size - maxBytes);
  const buf = Buffer.alloc(Math.min(size, maxBytes));
  if (buf.length) {
    const fh = fs.openSync(logPath, 'r');
    try {
      fs.readSync(fh, buf, 0, buf.length, start);
    } finally {
      try { fs.closeSync(fh); } catch { /* ignore */ }
    }
  }
  let text = buf.toString('utf8');
  if (start > 0) {
    // Tail window: drop the cut head line (it started before the window).
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  const trailingNewline = text.endsWith('\n');
  const rawLines = text.split('\n');
  if (trailingNewline) rawLines.pop();
  let malformed = 0;
  let partialIgnored = false;
  const records = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object') malformed += 1;
      else records.push(record);
    } catch {
      // The last line of a live log is routinely mid-write — ignore it
      // rather than crying malformed. Anything else is genuinely corrupt.
      const last = i === rawLines.length - 1;
      if (last && !trailingNewline) partialIgnored = true;
      else malformed += 1;
    }
  }

  if (expectedStreamId != null) {
    for (const record of records) {
      const sid = record.stream?.id;
      if (typeof sid === 'string' && sid !== expectedStreamId) {
        fail('STREAM_MISMATCH', 'child log carries another session\'s stream');
      }
    }
  }

  const items = [];
  /** call_id → index into items of the open call row. */
  const openCalls = new Map();
  let terminal = null;
  const push = (item) => {
    item.itemId = `nlog:${items.length}`;
    items.push(item);
  };
  /** A run boundary (new run, terminal marker) ends every call the old run
   * left open — results arriving later belong to a newer read, not to a
   * call whose run is already over. */
  const settleOpenCalls = () => {
    for (const at of openCalls.values()) {
      if (items[at] && items[at].status === 'open') items[at].status = 'completed';
    }
    openCalls.clear();
  };

  for (const record of records) {
    const payload = record.payload;
    if (!payload || typeof payload !== 'object') continue;
    const event = payload.event && typeof payload.event === 'object' ? payload.event : {};
    const kind = String(event.kind || payload.kind || '');
    const payloadKind = String(payload.kind || '');

    if (kind === 'started' && payloadKind === 'run') {
      settleOpenCalls();
      terminal = null; // new run — the previous run's terminal dies here
      if (typeof event.prompt === 'string' && event.prompt.trim()) {
        push({ kind: 'userMessage', status: 'completed', text: event.prompt });
      }
      continue;
    }
    if (kind === 'assistant_message_committed') {
      if (typeof event.text === 'string' && event.text.trim()) {
        push({ kind: 'agentMessage', status: 'completed', text: event.text });
      }
      continue;
    }
    if (kind === 'assistant_tool_calls_committed') {
      const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
      for (const call of calls) {
        if (!call || typeof call !== 'object') continue;
        const tool = toolLeaf(call.name);
        const args = toolArgs(call.args);
        const atPath = pathFromArgs(args);
        const argKeys = Object.keys(args).filter((k) => !/path|file|target|filename/i.test(k));
        const argPreview = argKeys.length
          ? oneLine(JSON.stringify(Object.fromEntries(argKeys.slice(0, 6).map((k) => [k, args[k]]))), NATIVE_ARGS_PREVIEW_MAX)
          : '';
        const text = [atPath, argPreview && argPreview !== '{}' ? argPreview : null]
          .filter(Boolean).join(' — ') || tool || 'tool';
        const callId = typeof call.call_id === 'string' ? call.call_id
          : typeof call.id === 'string' ? call.id : null;
        push({ kind: 'toolCall', status: 'open', tool: tool || null, text, callId });
        if (callId) openCalls.set(callId, items.length - 1);
      }
      continue;
    }
    if (kind === 'tool_result' || kind === 'tool_result_batch_committed'
      || kind === 'tool_results_committed' || kind === 'tool_result_committed') {
      const results = Array.isArray(event.results) ? event.results : [event];
      for (const result of results) {
        if (!result || typeof result !== 'object') continue;
        const text = asText(result.text ?? result.output ?? result.result ?? '');
        const callId = typeof result.tool_call_id === 'string' ? result.tool_call_id
          : typeof result.call_id === 'string' ? result.call_id : null;
        const at = callId ? openCalls.get(callId) : undefined;
        if (at != null && items[at]) {
          // An empty result still resolves its call — the tool answered,
          // it just said nothing. Only the row needs text to earn its place.
          items[at].status = 'completed';
          openCalls.delete(callId);
          if (text.trim()) {
            push({ kind: 'toolCall', status: 'completed', tool: items[at].tool || null, text });
          }
        } else if (text.trim()) {
          // Orphan result (call outside the tail window, or never logged):
          // show the output, never invent the call.
          push({ kind: 'toolCall', status: 'completed', tool: null, text });
        }
      }
      continue;
    }
    if (kind === 'terminal') {
      terminal = String(event.terminal ?? 'terminal');
      settleOpenCalls();
      push({ kind: 'terminal', status: 'completed', text: `run ${terminal}` });
      continue;
    }
    if (kind === 'inbox_item_queued' && event.source?.source === 'user_steer') {
      const text = asText(event.payload?.prompt ?? event.body ?? '');
      if (text.trim()) push({ kind: 'userMessage', status: 'completed', text });
      continue;
    }
    // Everything else stays out: system context, provider payloads,
    // reasoning, approvals, compaction, checkpoints, display variants.
  }

  // Calls still open at EOF belong to the latest run with no terminal
  // marker yet — live work, still polling. (A terminal marker or a newer
  // run already settled everything before it via settleOpenCalls.)
  for (const item of items) {
    if (item.status === 'open') item.status = 'inProgress';
    delete item.callId;
  }
  let droppedFromHead = 0;
  let out = items;
  if (out.length > maxItems) {
    droppedFromHead = out.length - maxItems;
    out = out.slice(droppedFromHead);
    out.forEach((it, i) => { it.itemId = `nlog:${i}`; });
  }
  return {
    items: out,
    terminal,
    runState: terminal ? 'terminal' : 'running',
    malformed,
    partialIgnored,
    droppedFromHead,
    byteTruncated: start > 0,
    bytesSkipped: start,
    bytesRead: buf.length,
  };
}

/**
 * Resolve a native subagent_id to its child session dir via the owning
 * parent's own `subagent.control.child_session_bound` records
 * ({subagent_id, child_session_id} — verified against real logs: the dir
 * name is the child SESSION id, not the subagent id). Exact match within
 * this parent's log only — never a cross-parent search. Latest binding
 * wins. Results cache on parent-log mtime+size so drill polls don't
 * rescan a fat log every 2.5s.
 */
const bindingCache = new Map();

function scanBoundChildSession(parentLogPath, parentId, subagentId) {
  let st;
  try {
    st = fs.statSync(parentLogPath);
  } catch {
    return null;
  }
  const size = Math.max(0, st.size);
  const start = Math.max(0, size - NATIVE_BINDING_MAX_BYTES);
  const buf = Buffer.alloc(Math.min(size, NATIVE_BINDING_MAX_BYTES));
  if (buf.length) {
    const fh = fs.openSync(parentLogPath, 'r');
    try {
      fs.readSync(fh, buf, 0, buf.length, start);
    } finally {
      try { fs.closeSync(fh); } catch { /* ignore */ }
    }
  }
  let text = buf.toString('utf8');
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.includes('child_session_bound')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    if (record.payload_type !== 'subagent.control.child_session_bound') continue;
    const rec = record.payload?.record;
    if (!rec || typeof rec !== 'object') continue;
    if (rec.subagent_id !== subagentId) continue;
    const sid = record.stream?.id;
    if (typeof sid === 'string' && sid !== parentId) continue;
    if (!isSafeSessionId(rec.child_session_id)) continue;
    found = rec.child_session_id;
  }
  return found;
}

export function boundChildSession(parentDir, parentId, subagentId) {
  const parentLog = path.join(parentDir, 'session.jsonl');
  let st;
  try {
    st = fs.statSync(parentLog);
  } catch {
    return null;
  }
  const cacheKey = `${parentDir}::${subagentId}`;
  const fileKey = `${st.mtimeMs}:${st.size}`;
  const hit = bindingCache.get(cacheKey);
  if (hit && hit.fileKey === fileKey) return hit.childSessionId;
  const found = scanBoundChildSession(parentLog, parentId, subagentId);
  if (bindingCache.size >= NATIVE_BINDING_CACHE_MAX) bindingCache.clear();
  bindingCache.set(cacheKey, { fileKey, childSessionId: found });
  return found;
}

/**
 * Full constrained resolution: owning parent → workspace check → binding
 * (subagent_id → child session dir, from the parent's own log) → child
 * log → projection. Returns { ok:true, ... } or { ok:false, code }. Never
 * throws for expected misses — the drill falls back to the synthesized
 * view instead.
 */
export function readNativeChildTranscript({ dataRoot, parentId, childId, chatCwd }) {
  try {
    if (!isSafeSessionId(parentId)) return { ok: false, code: 'INVALID_PARENT_ID' };
    if (!isSafeSessionId(childId)) return { ok: false, code: 'INVALID_CHILD_ID' };
    let parentDir;
    try {
      parentDir = findParentSessionDir(dataRoot ?? nativeDataRoot(), parentId);
    } catch (err) {
      return { ok: false, code: err?.code || 'PARENT_NOT_FOUND' };
    }
    const verified = verifyParentWorkspace(parentDir, chatCwd);
    if (!verified.ok) return { ok: false, code: verified.reason };
    const childSessionId = boundChildSession(parentDir, parentId, childId);
    if (!childSessionId) return { ok: false, code: 'NO_BINDING' };
    let logPath;
    try {
      logPath = resolveNativeChildLog(parentDir, childSessionId);
    } catch (err) {
      return { ok: false, code: err?.code || 'LOG_MISSING' };
    }
    let projected;
    try {
      projected = readNativeTranscript(logPath, { expectedStreamId: childSessionId });
    } catch (err) {
      return { ok: false, code: err?.code || 'READ_FAILED' };
    }
    return { ok: true, parentDir, logPath, childSessionId, ...projected };
  } catch {
    return { ok: false, code: 'READ_FAILED' };
  }
}
