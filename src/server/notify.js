// macOS banner payload for agent questions (POST /api/notify).
//
// The WKWebView shell does not deliver Web Notifications reliably, so an
// agent question also fans out through osascript here — a real banner even
// when the window is behind something else. Pure builders (unit-tested);
// index.js owns the spawn itself. Fire-and-forget by contract: a
// notification failure must never fail the turn it announces.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { cutText } from './text.js';

export const NOTIFY_TITLE_MAX = 80;
export const NOTIFY_TEXT_MAX = 300;

/**
 * Clamp user-supplied fields into a deliverable payload. Empty text means
 * "nothing to say" — the route answers delivered:false without spawning.
 */
export function buildNotifyPayload(input) {
  const title = cutText(String(input?.title || 'Muse Desktop'), NOTIFY_TITLE_MAX);
  const text = cutText(String(input?.body ?? input?.text ?? ''), NOTIFY_TEXT_MAX);
  return { title, text };
}

/** AppleScript string escaping: backslashes first, then double quotes. */
export function escAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** osascript argv for the payload. Pure — the route spawns it detached. */
export function notifyArgs({ title, text }) {
  return ['-e', `display notification "${escAppleScript(text)}" with title "${escAppleScript(title)}"`];
}

/** Banners exist on macOS only, and never for an empty body. */
export function shouldDeliver({ text }, platform = process.platform) {
  return platform === 'darwin' && String(text || '').length > 0;
}

// ------------------------------------------------- host-origin questions
// A closed or disconnected renderer must not lose alerts: on Linux the
// HOST banners new pending questions itself, straight onto the desktop,
// instead of relying on the page's museNotify bridge. Delivery rides a
// typed GAction (`notify-question`, (op, key)) on the GTK shell's
// application bus name, invoked with argv-only `gdbus call` — no shell,
// no interpolation. The banner text travels as a JSON file under the
// runtime dir (UTF-8 safe by construction; only the host-sanitized key
// crosses the GVariant text format). The shell shows the banner with the
// same `muse-q-<key>` id the renderer bridge uses, so a host banner and
// a renderer banner for one question collapse to ONE (replace-by-id),
// and withdrawal removes whichever side showed it. macOS keeps the
// renderer→/api/notify path (the WKWebView shell always runs a page).

export const QUESTION_APP_ID = 'com.aukkwat83.MuseDesktop';
export const QUESTION_BUS_PATH = '/com/aukkwat83/MuseDesktop';
export const QUESTION_ACTION = 'notify-question';
export const QUESTION_TITLE_MAX = 80;
export const QUESTION_TEXT_MAX = 300;

/** Host-sanitized notification key: safe for filenames and GVariant text. */
export function questionNoticeKey(id) {
  const s = String(id ?? '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[.-]+|-+$/g, '');
  return `q-${s || 'ix'}`.slice(0, 96);
}

export function questionNoticeFile(runtimeDir, key) {
  return `${String(runtimeDir || '').replace(/\/+$/, '')}/muse-desktop/notify-${key}.json`;
}

/** Thai banner copy for a pending interaction (question text, never the tool name). */
export function buildQuestionNotice({ subtype, chatTitle, summary }) {
  const title = subtype === 'ask'
    ? 'Muse มีคำถาม'
    : subtype === 'plan'
      ? 'Muse รอตรวจแผน'
      : 'Muse รอการอนุญาต';
  const detail = cutText(String(summary || '').replace(/\s+/g, ' ').trim(), QUESTION_TEXT_MAX);
  const text = cutText(`${String(chatTitle || 'แชท')} — ${detail}`, QUESTION_TEXT_MAX);
  return { title, text };
}

/**
 * argv for activating the shell's notify-question action over D-Bus.
 * Pure — every element is literal; the key is host-sanitized, so no
 * quoting layer can misfire. org.gtk.Actions.Activate takes
 * (action-name, parameter-variant, platform-data): the (op, key) tuple
 * MUST ride variant-wrapped — `[<(..)>]`, not `[(..)]` (proven by an
 * actual GLib parse on the Guix host; the bare form is rejected).
 */
export function gdbusNotifyArgs({ appId = QUESTION_APP_ID, busPath = QUESTION_BUS_PATH, op, key }) {
  return [
    'call', '--session',
    '--dest', String(appId),
    '--object-path', String(busPath),
    '--method', 'org.gtk.Actions.Activate',
    `'${QUESTION_ACTION}'`,
    `[<('${op === 'withdraw' ? 'withdraw' : 'show'}', '${key}')>]`,
    '{}',
  ];
}

/**
 * Host-origin question notifier. `pending()` banners, `withdraw()` clears;
 * both are best-effort receipts — never throws — because a notification
 * failure must never fail the turn it announces. Desktop dispatch is
 * ASYNC and bounded (at most MAX_CONCURRENT gdbus calls in flight), so
 * one slow bus can never block Node's loop for 3s per question; the
 * sync receipt therefore says queued/accepted, never "visually
 * delivered" — the terminal accepted/FAILED lands in the host log.
 * Dedupe is honest about dispatch: repeats of a bus-confirmed mark
 * report delivered, repeats of a merely queued mark report queued —
 * and a failure un-marks its own generation so the next retry
 * re-attempts instead of falsely reporting delivered.
 * Modes: MUSE_DESKTOP_NOTIFY=off disables, MUSE_DESKTOP_NOTIFY_LOG sinks
 * JSON lines to a file for isolated E2E (never touches a desktop).
 */
export function createQuestionNotifier({
  platform = process.platform,
  appId = QUESTION_APP_ID,
  runtimeDir = process.env.XDG_RUNTIME_DIR || '/tmp',
  spawnAsyncFn = null,
  writeFileFn = null,
  mkdirFn = null,
  logFn = null,
  env = process.env,
  maxConcurrent = 4,
} = {}) {
  const log = (...a) => { try { (logFn || console.log)(...a); } catch { /* ignore */ } };
  const mode = String(env?.MUSE_DESKTOP_NOTIFY || '').toLowerCase() === 'off' ? 'off' : 'on';
  const sink = typeof env?.MUSE_DESKTOP_NOTIFY_LOG === 'string' && env.MUSE_DESKTOP_NOTIFY_LOG
    ? env.MUSE_DESKTOP_NOTIFY_LOG
    : null;
  const live = mode === 'on' && !sink && platform === 'linux';
  const seen = new Map(); // key → banner-content fingerprint (queued-or-accepted mark)
  const confirmed = new Set(); // keys whose show job actually succeeded on the bus
  const queue = []; // queued-but-unstarted jobs, coalesced by op+key
  const active = new Set(); // in-flight job promises (flush() drains)
  let running = 0;

  const pump = () => {
    while (running < maxConcurrent && queue.length) {
      const job = queue.shift();
      running++;
      const done = runJob(job).finally(() => {
        running--;
        active.delete(done);
        pump();
      });
      active.add(done);
    }
  };

  const runJob = async ({ op, key, argv, fingerprint }) => {
    let ok = false;
    let detail = 'no spawn';
    try {
      const r = spawnAsyncFn ? await spawnAsyncFn('gdbus', argv, { timeout: 3000 }) : null;
      if (r && r.status === 0) {
        ok = true;
      } else {
        detail = `gdbus exit ${r?.status ?? '?'}${r?.stderr ? `: ${String(r.stderr).trim().slice(0, 120)}` : ''}`;
      }
    } catch (err) {
      detail = String(err?.message || err).slice(0, 160);
    }
    if (ok) {
      if (op === 'show') confirmed.add(key);
      log(`[notify] host ${op} ${key} accepted via=gdbus`);
    } else {
      // Failures un-mark ONLY their own generation: the next identical
      // pending re-attempts instead of deduping against a banner that
      // never went out — while a newer coalesced fingerprint (a pending
      // that arrived behind this job) is left for its own job to settle.
      if (op === 'show' && seen.get(key) === fingerprint) {
        seen.delete(key);
        confirmed.delete(key);
      }
      log(`[notify] host ${op} ${key} FAILED via=gdbus (${detail})`);
    }
    return ok;
  };

  const enqueue = (op, key, fingerprint = null) => {
    const argv = gdbusNotifyArgs({ appId, op, key });
    const dupe = queue.find((j) => j.op === op && j.key === key);
    if (dupe) {
      // Coalesce payload generation consistently: the queued job adopts
      // the NEW fingerprint (the payload file was already rewritten), so
      // its failure clears the current mark instead of orphaning it —
      // otherwise the retry would falsely dedupe forever.
      dupe.fingerprint = fingerprint;
    } else {
      queue.push({ op, key, argv, fingerprint });
    }
    log(`[notify] host ${op} ${key} queued via=gdbus`);
    pump();
    return { attempted: true, delivered: false, queued: true, via: 'gdbus' };
  };

  return {
    pending({ id, chatId, title, body }) {
      const key = questionNoticeKey(id);
      const core = { key, chatId: String(chatId || ''), ixId: String(id || ''), title, body };
      // Dedupe on the banner content, not the timestamp — else no two
      // calls ever match and replays re-banner.
      const fingerprint = JSON.stringify(core);
      // Honest dedupe: confirmed (bus-accepted) repeats report delivered;
      // repeats of a merely QUEUED mark report queued — delivered:true
      // before dispatch would claim a banner that never went out.
      if (seen.get(key) === fingerprint) {
        return confirmed.has(key)
          ? { attempted: true, delivered: true, via: 'dedupe' }
          : { attempted: true, delivered: false, queued: true, via: 'dedupe-queued' };
      }
      const json = JSON.stringify({ ...core, ts: Date.now() });
      if (mode === 'off') return { attempted: false, delivered: false, via: 'off' };
      if (sink) {
        try {
          writeFileFn(`${json}\n`, sink);
          seen.set(key, fingerprint);
          confirmed.add(key);
          log(`[notify] host show ${key} accepted via=log`);
          return { attempted: true, delivered: true, via: 'log' };
        } catch (err) {
          const detail = String(err?.message || err).slice(0, 120);
          log(`[notify] host show ${key} FAILED via=log (${detail})`);
          return { attempted: true, delivered: false, via: 'log', detail };
        }
      }
      if (!live) return { attempted: false, delivered: false, via: platform === 'linux' ? 'renderer' : 'mac-route' };
      try {
        mkdirFn(`${String(runtimeDir).replace(/\/+$/, '')}/muse-desktop`);
        writeFileFn(json, questionNoticeFile(runtimeDir, key));
      } catch (err) {
        const detail = String(err?.message || err).slice(0, 120);
        log(`[notify] host show ${key} FAILED via=file (${detail})`);
        return { attempted: true, delivered: false, via: 'file', detail };
      }
      // Accepted into the bounded dispatcher: mark now (replays dedupe
      // while queued), un-marked on failure by runJob.
      seen.set(key, fingerprint);
      return enqueue('show', key, fingerprint);
    },
    withdraw(id) {
      const key = questionNoticeKey(id);
      seen.delete(key);
      confirmed.delete(key);
      if (mode === 'off') return { attempted: false, delivered: false, via: 'off' };
      if (sink) {
        try {
          writeFileFn(`${JSON.stringify({ key, op: 'withdraw', ts: Date.now() })}\n`, sink);
          log(`[notify] host withdraw ${key} accepted via=log`);
          return { attempted: true, delivered: true, via: 'log' };
        } catch (err) {
          const detail = String(err?.message || err).slice(0, 120);
          log(`[notify] host withdraw ${key} FAILED via=log (${detail})`);
          return { attempted: true, delivered: false, via: 'log', detail };
        }
      }
      if (!live) return { attempted: false, delivered: false, via: platform === 'linux' ? 'renderer' : 'mac-route' };
      try {
        writeFileFn(null, questionNoticeFile(runtimeDir, key)); // null = remove
      } catch { /* stale file removal is cosmetic */ }
      return enqueue('withdraw', key);
    },
    /** Drain the dispatcher (tests; production never waits). */
    async flush() {
      while (active.size || queue.length) {
        if (active.size) await Promise.allSettled([...active]);
        else pump();
      }
    },
  };
}

/** Production notifier: real fs + async spawn, env-driven modes. */
export function defaultQuestionNotifier() {
  const logPath = process.env.MUSE_DESKTOP_NOTIFY_LOG;
  return createQuestionNotifier({
    writeFileFn: (content, file) => {
      if (content == null) {
        try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
        return;
      }
      if (logPath && file === logPath) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, content);
        return;
      }
      fs.writeFileSync(file, content);
    },
    mkdirFn: (dir) => fs.mkdirSync(dir, { recursive: true }),
    spawnAsyncFn: (cmd, argv, opts = {}) => new Promise((resolve) => {
      let stderr = '';
      let settled = false;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        resolve({ status, stderr });
      };
      let child;
      try {
        child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (err) {
        resolve({ status: null, stderr: String(err?.message || err) });
        return;
      }
      const timer = opts.timeout ? setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, opts.timeout) : null;
      child.stderr?.on('data', (b) => { stderr += String(b); });
      child.on('error', (err) => {
        stderr = String(err?.message || err);
        finish(null);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        finish(code);
      });
    }),
  });
}
