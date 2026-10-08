// Muse Desktop host — long-lived local HTTP server that owns the MSP agents.
//
// The Swift shell (or a browser) is just a view: it may come and go, the host
// and its agents keep running. Everything the UI paints arrives over SSE;
// mutating endpoints answer immediately and never stream through the response
// body.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { SseWire } from './sse-wire.js';
import { SessionStore, stateDir } from './session-store.js';
import { SessionManager } from './sessions.js';
import { MUSE_BIN, terminalAuthCommand } from './msp-client.js';
import { debugSnapshot } from './debug-info.js';
import { probeAll, probeServer, readCatalog, setEnabled } from './mcp.js';
import { saveUpload } from './attachments.js';
import {
  resolveDialog,
  dialogArgs,
  parsePickerPaths,
  isPickerCancel,
  noDialogMessage,
} from './file-picker.js';
import { priceTable, thbPerUsd } from './pricing.js';
import { buildNotifyPayload, notifyArgs, shouldDeliver } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');
const RENDERER = path.join(ROOT, 'src/renderer');

const PORT = Number(process.env.MUSE_DESKTOP_PORT || 3850);
const HOST = process.env.MUSE_DESKTOP_HOST || '127.0.0.1';
const STATE = stateDir();
const PID_FILE = path.join(STATE, 'host.pid');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

/** Third-party ESM served from node_modules under a stable /vendor path. */
const VENDOR = {
  '/vendor/marked.esm.js': path.join(ROOT, 'node_modules/marked/lib/marked.esm.js'),
  '/vendor/mermaid/mermaid.min.js': path.join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js'),
};

const wire = new SseWire();
const store = new SessionStore();
const sessions = new SessionManager({
  store,
  wire,
  defaults: {
    cwd: process.env.MUSE_DESKTOP_CWD || os.homedir(),
    mode: process.env.MUSE_DESKTOP_MODE || 'always',
    // Model alias / thinking effort applied to every new agent session.
    // Null model means the host default — the binary decides. Effort
    // defaults to ultra; MUSE_DESKTOP_EFFORT overrides per deployment.
    model: process.env.MUSE_DESKTOP_MODEL || null,
    effort: process.env.MUSE_DESKTOP_EFFORT || 'ultra',
  },
});

// --------------------------------------------------------------- helpers

// ---- MCP status cache ------------------------------------------------
// Probing spawns every configured server — expensive enough to do only on
// demand (panel open / Reload), then serve from cache. Shaped per server:
// { status, latencyMs, error, tools } + a shared probedAt.
const mcpProbe = { results: new Map(), probedAt: null };
let mcpProbeFlight = null;

function mcpSnapshot() {
  const { servers, error } = readCatalog();
  const usage = sessions.mcpUsageSnapshot();
  return {
    ok: true,
    error,
    probedAt: mcpProbe.probedAt,
    probing: !!mcpProbeFlight,
    servers: servers.map((s) => {
      const cached = mcpProbe.results.get(s.name);
      return {
        ...s,
        status: !s.enabled ? 'disabled' : cached?.status || 'unknown',
        latencyMs: cached?.latencyMs ?? null,
        probeError: cached?.error ?? null,
        tools: cached?.tools ?? null,
        lastUsedAt: usage[s.name] ?? null,
      };
    }),
  };
}

async function runProbeAll() {
  if (!mcpProbeFlight) {
    mcpProbeFlight = (async () => {
      try {
        const { results, probedAt } = await probeAll();
        mcpProbe.results = new Map(results.map((r) => [r.name, r]));
        mcpProbe.probedAt = probedAt;
      } finally {
        mcpProbeFlight = null;
      }
      wire.emit(null, 'mcp_servers', mcpSnapshot());
    })();
  }
  await mcpProbeFlight;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function fail(res, status, message, extra = {}) {
  send(res, status, { ok: false, error: message, ...extra });
}

async function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, absPath, { cache = false } = {}) {
  try {
    const data = await fsp.readFile(absPath);
    const ext = path.extname(absPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // Renderer assets are edited live; a cached bundle inside WKWebView is a
      // classic "my fix did nothing" trap.
      'Cache-Control': cache ? 'public, max-age=86400' : 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------- diagram download
// (grok-desktop src/server/index.js:692-780 + helpers 1258-1374, verbatim
// logic — the renderer posts Blobs here so ↓ SVG / ↓ PNG land in
// ~/Downloads even inside WKWebView, where <a download> is unreliable.)

function resolveDownloadsDir() {
  if (process.env.XDG_DOWNLOAD_DIR && fs.existsSync(process.env.XDG_DOWNLOAD_DIR)) {
    return process.env.XDG_DOWNLOAD_DIR;
  }
  // user-dirs.dirs
  try {
    const cfg = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'user-dirs.dirs',
    );
    if (fs.existsSync(cfg)) {
      const text = fs.readFileSync(cfg, 'utf8');
      const m = text.match(/^XDG_DOWNLOAD_DIR="?([^"\n]+)"?/m);
      if (m) {
        const expanded = m[1].replace('$HOME', os.homedir());
        if (fs.existsSync(expanded)) return expanded;
      }
    }
  } catch { /* ignore */ }
  return path.join(os.homedir(), 'Downloads');
}

/**
 * SVG → PNG for diagram export.
 * macOS: qlmanage · Linux/Guix: rsvg-convert (preferred) · ImageMagick convert
 * @param {Buffer} svgBuf
 * @returns {Promise<{ ok: boolean, buf?: Buffer, engine?: string, error?: string, detail?: string }>}
 */
async function rasterizeSvgToPng(svgBuf) {
  const tmpDir = path.join(os.tmpdir(), 'muse-desktop-raster');
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  const svgPath = path.join(tmpDir, `${stamp}.svg`);
  const pngPath = path.join(tmpDir, `${stamp}.png`);
  fs.writeFileSync(svgPath, svgBuf);

  const run = (bin, args) => new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ code, err }));
    child.on('error', (e) => resolve({ code: -1, err: e.message }));
  });

  try {
    if (process.platform === 'darwin') {
      const qlErr = await run('qlmanage', ['-t', '-s', '1200', '-o', tmpDir, svgPath]);
      const candidates = [
        path.join(tmpDir, `${stamp}.svg.png`),
        path.join(tmpDir, `${stamp}.png`),
      ];
      let out = candidates.find((c) => fs.existsSync(c));
      if (!out) {
        try {
          const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(stamp) && f.endsWith('.png'));
          if (files[0]) out = path.join(tmpDir, files[0]);
        } catch { /* ignore */ }
      }
      if (out && fs.existsSync(out)) {
        const buf = fs.readFileSync(out);
        try { fs.unlinkSync(svgPath); } catch { /* ignore */ }
        try { fs.unlinkSync(out); } catch { /* ignore */ }
        return { ok: true, buf, engine: 'qlmanage' };
      }
      return { ok: false, error: 'svg→png raster failed (qlmanage)', detail: qlErr?.err || `code=${qlErr?.code}` };
    }

    // Linux / Guix: rsvg-convert first, then ImageMagick
    for (const [bin, args, engine] of [
      ['rsvg-convert', ['-w', '1200', '-f', 'png', '-o', pngPath, svgPath], 'rsvg-convert'],
      ['convert', ['-background', 'none', '-density', '150', svgPath, pngPath], 'imagemagick'],
    ]) {
      const which = spawn('sh', ['-c', `command -v ${bin}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      const found = await new Promise((resolve) => {
        let o = '';
        which.stdout?.on('data', (c) => { o += c; });
        which.on('close', (code) => resolve(code === 0 && o.trim()));
        which.on('error', () => resolve(''));
      });
      if (!found) continue;
      const r = await run(bin, args);
      if (r.code === 0 && fs.existsSync(pngPath)) {
        const buf = fs.readFileSync(pngPath);
        try { fs.unlinkSync(svgPath); } catch { /* ignore */ }
        try { fs.unlinkSync(pngPath); } catch { /* ignore */ }
        return { ok: true, buf, engine };
      }
    }

    return {
      ok: false,
      error: 'svg→png raster failed (install rsvg-convert or imagemagick)',
      detail: 'no working rasterizer',
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Reveal file in OS file manager. */
function revealFile(filePath) {
  try {
    if (process.platform === 'darwin') {
      spawn('open', ['-R', filePath], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    if (process.platform === 'linux') {
      // GNOME: open containing folder (nautilus/xdg-open)
      const dir = path.dirname(filePath);
      spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

let cachedAgentInfo = null;
async function agentInfo() {
  if (cachedAgentInfo && Date.now() - cachedAgentInfo.ts < 30_000) return cachedAgentInfo.value;
  const value = await new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let proc;
    try {
      proc = spawn(MUSE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish({ ok: false, bin: MUSE_BIN, version: null, error: 'muse not found' });
      return;
    }
    proc.stdout?.on('data', (b) => {
      out += b.toString();
    });
    proc.on('error', (err) => finish({ ok: false, bin: MUSE_BIN, version: null, error: err.message }));
    proc.on('exit', (code) =>
      finish({
        ok: code === 0,
        bin: MUSE_BIN,
        version: out.trim().split('\n')[0] || null,
      }),
    );
    setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      finish({ ok: false, bin: MUSE_BIN, version: null, error: 'timeout' });
    }, 8000).unref?.();
  });
  cachedAgentInfo = { ts: Date.now(), value };
  return value;
}

// ---------------------------------------------------------------- routing

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const { pathname } = url;
  const method = (req.method || 'GET').toUpperCase();

  try {
    // ---- SSE -------------------------------------------------------
    if (pathname === '/api/events' && method === 'GET') {
      const clientId = url.searchParams.get('clientId') || randomUUID();
      const subscribe = url.searchParams.getAll('subscribe').filter(Boolean);
      wire.addClient(clientId, res, {
        chatIds: subscribe,
        lastEventId: req.headers['last-event-id'] || url.searchParams.get('lastEventId'),
      });
      return;
    }

    if (pathname === '/api/events/subscribe' && method === 'POST') {
      const body = await readJson(req);
      const ok = wire.subscribe(String(body.clientId || ''), body.chatIds);
      return send(res, ok ? 200 : 404, { ok });
    }

    // ---- host ------------------------------------------------------
    if (pathname === '/api/state' && method === 'GET') {
      return send(res, 200, {
        ok: true,
        pid: process.pid,
        port: PORT,
        host: HOST,
        version: pkg.version,
        name: pkg.productName || pkg.name,
        uptimeMs: Math.round(process.uptime() * 1000),
        sseClients: wire.clientCount,
        stats: sessions.stats(),
        stateDir: STATE,
      });
    }

    if (pathname === '/api/version' && method === 'GET') {
      return send(res, 200, { ok: true, version: pkg.version, name: pkg.productName || pkg.name });
    }

    // ---- debug (direct URL only, nothing user-facing links here) ---------
    if (pathname === '/api/debug' && method === 'GET') {
      return send(res, 200, {
        ok: true,
        ...debugSnapshot({ wire, sessions, pkg, port: PORT, host: HOST, stateDir: STATE }),
      });
    }

    if (pathname === '/api/debug/stream' && method === 'GET') {
      // A lean live feed for /debug.html: one snapshot every 2s. Deliberately
      // separate from SseWire — a debugging tap must not perturb the wire it
      // observes (no ring entries, no client slot).
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      const timer = setInterval(() => {
        try {
          const snap = debugSnapshot({ wire, sessions, pkg, port: PORT, host: HOST, stateDir: STATE });
          res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
        } catch {
          /* client went away mid-write; close below clears the timer */
        }
      }, 2000);
      timer.unref?.();
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (pathname === '/api/memory' && method === 'GET') {
      const stats = sessions.stats();
      return send(res, 200, {
        ok: true,
        freeMB: Math.round(os.freemem() / 1_048_576),
        totalMB: Math.round(os.totalmem() / 1_048_576),
        counts: { hot: stats.hot, running: stats.running },
        maxHotAgents: stats.maxHot,
        pressure: stats.hot >= stats.maxHot ? 'full' : '',
      });
    }

    if (pathname === '/api/agent' && method === 'GET') {
      const info = await agentInfo();
      return send(res, 200, { ok: true, agent: info, auth: sessions.lastAuth || null });
    }

    if (pathname === '/api/host/shutdown' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const killAgents = body.killAgents !== false;
      send(res, 202, { ok: true, killAgents });
      setTimeout(async () => {
        await sessions.shutdown({ killAgents });
        wire.closeAll();
        try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref?.();
      }, 50).unref?.();
      return;
    }

    // ---- auth ------------------------------------------------------
    if (pathname === '/api/auth' && method === 'GET') {
      const info = await agentInfo();
      return send(res, 200, {
        ok: true,
        agent: info,
        pending: sessions.lastAuth || null,
        command: terminalAuthCommand(sessions.lastAuth?.authMethods || []),
      });
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      // `login` is a terminal-type auth method: it needs a real TTY for the
      // device-code flow, so we hand it to Terminal.app rather than trying to
      // drive it over the MSP socket.
      const cmd = terminalAuthCommand(sessions.lastAuth?.authMethods || []);
      const line = [cmd.command, ...cmd.args].map((s) => `'${String(s).replace(/'/g, `'\\''`)}'`).join(' ');
      if (process.platform !== 'darwin') {
        return send(res, 200, { ok: false, manual: true, command: line });
      }
      const script = `tell application "Terminal"\n activate\n do script "${line.replace(/"/g, '\\"')}"\nend tell`;
      const p = spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore', detached: true });
      p.unref();
      return send(res, 200, { ok: true, launched: true, command: line });
    }

    // ---- groups ----------------------------------------------------
    if (pathname === '/api/groups' && method === 'GET') {
      return send(res, 200, { ok: true, ...sessions.groupsState() });
    }

    if (pathname === '/api/groups' && method === 'POST') {
      const body = await readJson(req);
      const group = sessions.createGroup({ name: body.name, position: body.position });
      return send(res, 201, { ok: true, group, ...sessions.groupsState() });
    }

    if (pathname === '/api/groups/reorder' && method === 'POST') {
      const body = await readJson(req);
      sessions.reorderGroups(body.order || body.ids || []);
      return send(res, 200, { ok: true, ...sessions.groupsState() });
    }

    const groupMatch = pathname.match(/^\/api\/groups\/([^/]+)(?:\/([^/]+))?$/);
    if (groupMatch) {
      const groupId = decodeURIComponent(groupMatch[1]);
      const action = groupMatch[2] || null;

      if (action === 'select' && method === 'POST') {
        const ok = sessions.selectGroup(groupId);
        return ok
          ? send(res, 200, { ok: true, ...sessions.groupsState(), chats: sessions.listChats() })
          : fail(res, 404, 'group not found');
      }

      if (!action && method === 'PATCH') {
        const body = await readJson(req);
        const group = sessions.renameGroup(groupId, body.name);
        return group
          ? send(res, 200, { ok: true, group, ...sessions.groupsState() })
          : fail(res, 404, 'group not found');
      }

      if (!action && method === 'DELETE') {
        const result = await sessions.removeGroup(groupId);
        if (!result) {
          // The store refuses to delete the last group — the sidebar must
          // always have somewhere to put a chat.
          const exists = !!store.getGroup(groupId);
          return fail(
            res,
            exists ? 409 : 404,
            exists ? 'ต้องเหลืออย่างน้อย 1 group' : 'group not found',
            exists ? { code: 'LAST_GROUP' } : {},
          );
        }
        return send(res, 200, {
          ok: true,
          removedChatIds: result.removedChatIds,
          ...sessions.groupsState(),
          chats: sessions.listChats(),
        });
      }
    }

    // ---- chats -----------------------------------------------------
    if (pathname === '/api/chats' && method === 'GET') {
      const groupId = url.searchParams.get('groupId');
      const chats = sessions.listChats();
      return send(res, 200, {
        ok: true,
        chats: groupId ? chats.filter((c) => c.groupId === groupId) : chats,
        ...sessions.groupsState(),
      });
    }

    if (pathname === '/api/chats' && method === 'POST') {
      const body = await readJson(req);
      const before = store.list().length;
      const chat = sessions.createChat(body);
      const created = store.list().length > before;
      return send(res, created ? 201 : 200, {
        ok: true,
        created,
        chat: sessions.chatSummary(chat),
      });
    }

    // ---- search ----------------------------------------------------
    // Cross-chat full-text search (SQLite FTS5 trigram, grok-desktop parity).
    if (pathname === '/api/search' && method === 'GET') {
      const q = url.searchParams.get('q') || url.searchParams.get('query') || '';
      const limit = Number(url.searchParams.get('limit') || 40);
      const groupId = url.searchParams.get('groupId') || undefined;
      const kind = url.searchParams.get('kind') || undefined;
      const surface = url.searchParams.get('surface') || url.searchParams.get('in') || undefined;
      try {
        return send(res, 200, sessions.search(q, { limit, groupId, kind, surface }));
      } catch (err) {
        return fail(res, 500, err?.message || 'search failed');
      }
    }

    if (pathname === '/api/search/stats' && method === 'GET') {
      try {
        return send(res, 200, { ok: true, ...(sessions.searchIndex?.stats?.() || { enabled: false }) });
      } catch (err) {
        return fail(res, 500, err?.message || 'stats failed');
      }
    }

    if (pathname === '/api/search/rebuild' && method === 'POST') {
      try {
        const r =
          sessions.searchIndex?.rebuildAll?.(sessions.store.list(), sessions.store.listGroups()) ||
          { ok: false, error: 'disabled' };
        return send(res, r.ok ? 200 : 500, { ok: !!r.ok, ...r });
      } catch (err) {
        return fail(res, 500, err?.message || 'rebuild failed');
      }
    }

    // ---- attachments -----------------------------------------------
    // Native macOS picker (osascript, grok-desktop parity) + an upload inbox
    // for dropped files (browsers hide their paths, so bytes come inline).
    if (pathname === '/api/pick-files' && method === 'POST') {
      const folder = url.searchParams.get('mode') === 'folder';
      if (process.platform !== 'darwin') {
        // Linux/Guix: no osascript, and no GTK binding in this process — drive
        // a freedesktop dialog binary instead. Resolved per request so a later
        // `guix install zenity` takes effect without restarting the host.
        // (Wayland gives us no way to parent the dialog to the shell window,
        // so it is its own toplevel and may open unfocused. Harmless.)
        const dialog = resolveDialog();
        if (!dialog) {
          return send(res, 200, { ok: false, paths: [], error: noDialogMessage() });
        }
        try {
          const stdout = await new Promise((resolve, reject) => {
            execFile(
              dialog.bin,
              dialogArgs(dialog.kind, { folder }),
              { timeout: 180000, maxBuffer: 1 << 20 },
              (err, out) => (err ? reject(err) : resolve(out)),
            );
          });
          return send(res, 200, { ok: true, paths: parsePickerPaths(stdout) });
        } catch (err) {
          // Dismissed dialog (exit 1, nothing selected) is a normal cancel.
          const canceled = isPickerCancel(err, '');
          return send(res, 200, {
            ok: true,
            canceled,
            paths: [],
            ...(canceled ? {} : { error: String(err?.message || err).slice(0, 200) }),
          });
        }
      }
      // `activate` brings the picker frontmost (host runs detached in the
      // background, so it would otherwise open behind the window).
      const chooser = folder
        ? 'choose folder with prompt "เลือกโฟลเดอร์ให้ Muse อ่าน (เลือกได้หลายโฟลเดอร์)" with multiple selections allowed'
        : 'choose file with prompt "แนบไฟล์ให้ Muse อ่าน (เลือกได้หลายไฟล์)" with multiple selections allowed';
      const script = [
        'activate',
        `set theItems to ${chooser}`,
        'set out to ""',
        'repeat with f in theItems',
        'set out to out & (POSIX path of (contents of f)) & linefeed',
        'end repeat',
        'return out',
      ];
      const args = script.flatMap((line) => ['-e', line]);
      try {
        const stdout = await new Promise((resolve, reject) => {
          execFile('osascript', args, { timeout: 180000, maxBuffer: 1 << 20 }, (err, out) =>
            err ? reject(err) : resolve(out),
          );
        });
        const paths = String(stdout || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        return send(res, 200, { ok: true, paths });
      } catch (err) {
        // Exit 1 + "User canceled" (-128) is a normal cancel, not an error.
        const canceled = /(-128|User canceled|User cancelled)/i.test(String(err?.message || err));
        return send(res, 200, {
          ok: true,
          canceled,
          paths: [],
          ...(canceled ? {} : { error: String(err?.message || err).slice(0, 200) }),
        });
      }
    }

    if (pathname === '/api/attachments/upload' && method === 'POST') {
      try {
        const body = await readJson(req, 32 * 1024 * 1024);
        const saved = saveUpload({
          dir: path.join(STATE, 'attach'),
          name: body.name,
          base64: body.base64,
        });
        return send(res, 200, { ok: true, ...saved });
      } catch (err) {
        return fail(res, err?.status || 500, err?.message || 'upload failed');
      }
    }

    if (pathname === '/api/interactions' && method === 'GET') {
      return send(res, 200, { ok: true, interactions: sessions.listPendingInteractions() });
    }

    const engagedMatch = pathname.match(/^\/api\/interactions\/([^/]+)\/engaged$/);
    if (engagedMatch && method === 'POST') {
      // Timed-prompt engagement (userInput/engaged): best-effort by
      // contract — always 200, the form is the guarantee.
      const done = sessions.engageInteraction(decodeURIComponent(engagedMatch[1]));
      return send(res, 200, { ok: true, engaged: !!done });
    }

    const interactionMatch = pathname.match(/^\/api\/interactions\/([^/]+)$/);
    if (interactionMatch && method === 'POST') {
      // ACK-safe submit: { answers } | { optionId } | { cancel, reason? }.
      // 200 lands (or duplicates) only after the RPC ack; 400 validates,
      // 404 is gone, 409 is a conflicting answer, 502 keeps the card with
      // retryable cause. The UI paints resolved from SSE, never this body.
      const body = await readJson(req);
      try {
        const result = await sessions.submitInteraction(
          decodeURIComponent(interactionMatch[1]),
          body || {},
        );
        return send(res, 200, result);
      } catch (err) {
        return fail(res, err?.status || 500, err?.message || 'submit failed', {
          code: err?.code || null,
          retryable: err?.retryable ?? null,
          questionId: err?.questionId || null,
          outcome: err?.outcome || null,
        });
      }
    }

    if (pathname === '/api/usage' && method === 'GET') {
      return send(res, 200, { ok: true, usage: await sessions.getUsage() });
    }

    // ---- cost ------------------------------------------------------
    // Static model rate table for the right-bar calculator (USD per 1M
    // tokens + the THB rate). The renderer multiplies session tokens by it.
    if (pathname === '/api/pricing' && method === 'GET') {
      return send(res, 200, { ok: true, pricing: priceTable(), thbPerUsd: thbPerUsd() });
    }

    // ---- notifications ---------------------------------------------
    // The WKWebView shell does not deliver Web Notifications reliably, so an
    // agent question also fans out through here: osascript posts a real macOS
    // banner even when the window is behind something else. Fire-and-forget —
    // a notification failure must never fail the turn it announces.
    // On Linux the banner path is the native GTK bridge (museNotify), not
    // this route — but the renderer still reports which channel fired, so
    // the host log shows the honest delivery story per question.
    if (pathname === '/api/notify' && method === 'POST') {
      const input = await readJson(req).catch(() => ({}));
      const payload = buildNotifyPayload(input);
      const channel = typeof input?.channel === 'string' ? input.channel.slice(0, 16) : '?';
      const ix = typeof input?.interactionId === 'string' ? input.interactionId.slice(0, 64) : '-';
      if (shouldDeliver(payload)) {
        const p = spawn('/usr/bin/osascript', notifyArgs(payload), {
          detached: true,
          stdio: 'ignore',
        });
        p.unref();
        console.log(`[notify] host banner ix=${ix} renderer-channel=${channel}`);
        return send(res, 200, { ok: true, delivered: true });
      }
      if (payload.text) console.log(`[notify] renderer-channel=${channel} ix=${ix} (host delivers on macOS only)`);
      return send(res, 200, { ok: true, delivered: false });
    }

    if (pathname === '/api/mcp/servers' && method === 'GET') {
      return send(res, 200, mcpSnapshot());
    }

    if (pathname === '/api/mcp/probe' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (name) {
        const result = await probeServer(name);
        mcpProbe.results.set(name, result);
        mcpProbe.probedAt = Date.now();
        wire.emit(null, 'mcp_servers', mcpSnapshot());
        return send(res, 200, { ok: true, result });
      }
      await runProbeAll();
      return send(res, 200, mcpSnapshot());
    }

    const mcpToggleMatch = pathname.match(/^\/api\/mcp\/servers\/([^/]+)\/enabled$/);
    if (mcpToggleMatch && method === 'POST') {
      const name = decodeURIComponent(mcpToggleMatch[1]);
      const body = await readJson(req).catch(() => ({}));
      if (typeof body?.enabled !== 'boolean') {
        return fail(res, 400, 'body.enabled must be boolean');
      }
      try {
        const { enabled } = setEnabled(name, body.enabled);
        mcpProbe.results.delete(name);
        // A toggle only reaches sessions spawned afterwards — drop every
        // idle agent now so the next prompt picks the new config up.
        const rotation = await sessions.releaseIdleClients('mcp config changed');
        wire.emit(null, 'mcp_servers', mcpSnapshot());
        return send(res, 200, { ok: true, name, enabled, ...rotation });
      } catch (err) {
        return fail(res, 404, err?.message || 'toggle failed');
      }
    }

    const subagentMatch = pathname.match(/^\/api\/chats\/([^/]+)\/subagents(?:\/([^/]+))?$/);
    if (subagentMatch && method === 'GET') {
      const chatId = decodeURIComponent(subagentMatch[1]);
      const itemId = subagentMatch[2] ? decodeURIComponent(subagentMatch[2]) : null;
      if (!sessions.store.get(chatId)) return fail(res, 404, 'chat not found');
      if (!itemId) {
        return send(res, 200, { ok: true, chatId, subagents: sessions.listSubagents(chatId) });
      }
      try {
        const drill = await sessions.readSubagent(chatId, itemId);
        return send(res, 200, { ok: true, chatId, itemId, ...drill });
      } catch (err) {
        if (err?.code === 'NOT_FOUND') return fail(res, 404, err.message);
        if (err?.code === 'NO_SESSION') return fail(res, 409, err.message, { code: 'NO_SESSION' });
        return fail(res, 502, err?.message || 'child read failed');
      }
    }

    const subagentCmdMatch = pathname.match(/^\/api\/chats\/([^/]+)\/subagents\/([^/]+)\/command$/);
    if (subagentCmdMatch && method === 'POST') {
      const chatId = decodeURIComponent(subagentCmdMatch[1]);
      const itemId = decodeURIComponent(subagentCmdMatch[2]);
      const body = await readJson(req).catch(() => ({}));
      try {
        const result = await sessions.subagentCommand(chatId, itemId, String(body?.action || ''), {
          body: body?.body,
          reason: body?.reason,
        });
        return send(res, 200, { ok: true, chatId, itemId, ...result });
      } catch (err) {
        if (err?.status) return fail(res, err.status, err.message, err.code ? { code: err.code } : {});
        return fail(res, 502, err?.message || 'subagent command failed');
      }
    }

    const childSessionMatch = pathname.match(/^\/api\/chats\/([^/]+)\/child-session\/([^/]+)$/);
    if (childSessionMatch && method === 'GET') {
      const chatId = decodeURIComponent(childSessionMatch[1]);
      const childSessionId = decodeURIComponent(childSessionMatch[2]);
      if (!sessions.store.get(chatId)) return fail(res, 404, 'chat not found');
      try {
        const drill = await sessions.readChildSession(chatId, childSessionId);
        return send(res, 200, { ok: true, chatId, childSessionId, ...drill });
      } catch (err) {
        return fail(res, 502, err?.message || 'child read failed');
      }
    }

    const chatMatch = pathname.match(/^\/api\/chats\/([^/]+)(?:\/([^/]+))?$/);
    if (chatMatch) {
      const chatId = decodeURIComponent(chatMatch[1]);
      const action = chatMatch[2] || null;

      if (!action && method === 'GET') {
        const chat = sessions.getChat(chatId);
        return chat ? send(res, 200, { ok: true, chat }) : fail(res, 404, 'chat not found');
      }

      if (action === 'turn' && method === 'GET') {
        const result = sessions.getTurn(chatId);
        if (!result) return fail(res, 404, 'chat not found');
        return result.turn
          ? send(res, 200, { ok: true, turn: result.turn })
          : fail(res, 404, 'no live turn');
      }

      if (action === 'goal' && method === 'GET') {
        if (!sessions.store.get(chatId)) return fail(res, 404, 'chat not found');
        return send(res, 200, { ok: true, chatId, goal: sessions.getGoal(chatId) });
      }

      if (action === 'goal' && method === 'POST') {
        const body = await readJson(req);
        try {
          const result = await sessions.goalCommand(chatId, String(body.action || ''));
          return send(res, 200, { ok: true, chatId, ...result });
        } catch (err) {
          return fail(res, err?.status || 500, err?.message || 'goal command failed', err?.code ? { code: err.code } : {});
        }
      }

      if (action === 'ctx' && method === 'GET') {
        if (!sessions.store.get(chatId)) return fail(res, 404, 'chat not found');
        return send(res, 200, { ok: true, chatId, ...sessions.getCtx(chatId) });
      }

      // Find-in-chat: generated content only, this chat, chronological.
      if (action === 'search' && method === 'GET') {
        if (!sessions.store.get(chatId)) return fail(res, 404, 'chat not found');
        const q = url.searchParams.get('q') || url.searchParams.get('query') || '';
        const limit = Number(url.searchParams.get('limit') || 80);
        const generatedOnly = url.searchParams.get('generatedOnly') !== '0';
        try {
          const out = sessions.searchIndex?.searchInSession?.(chatId, q, { limit, generatedOnly }) || {
            ok: false,
            error: 'disabled',
          };
          return send(res, 200, out);
        } catch (err) {
          return fail(res, 500, err?.message || 'search failed');
        }
      }

      if (!action && method === 'DELETE') {
        const ok = await sessions.removeChat(chatId);
        return send(res, ok ? 200 : 404, { ok });
      }

      if (!action && method === 'PATCH') {
        const body = await readJson(req);
        const patch = {};
        if (typeof body.title === 'string') patch.title = body.title;
        if (typeof body.cwd === 'string') patch.cwd = body.cwd;
        const chat = store.update(chatId, patch);
        if (!chat) return fail(res, 404, 'chat not found');
        wire.emit(chatId, 'chat_updated', { chat: sessions.chatSummary(chat) });
        return send(res, 200, { ok: true, chat: sessions.chatSummary(chat) });
      }

      if (action === 'prompt' && method === 'POST') {
        // Pasted image pixels ride inline as base64 — needs headroom past the
        // 1MB default (per-image caps still enforced in attachments.js).
        const body = await readJson(req, 64 * 1024 * 1024);
        try {
          const { turnId, message } = await sessions.prompt(chatId, body.text, {
            attachments: body.attachments,
          });
          return send(res, 202, { ok: true, turnId, message });
        } catch (err) {
          const status = err?.status || (err?.code === 'TURN_IN_FLIGHT' ? 409 : 500);
          return fail(res, status, err?.message || 'prompt failed', { code: err?.code || null });
        }
      }

      if (action === 'cancel' && method === 'POST') {
        const result = await sessions.cancel(chatId);
        return send(res, 200, { ok: true, ...result });
      }

      if (action === 'mode' && method === 'POST') {
        const body = await readJson(req);
        const result = await sessions.setMode(chatId, body.mode);
        return send(res, 200, { ok: true, ...result });
      }

      if (action === 'config' && method === 'POST') {
        const body = await readJson(req);
        try {
          const result = await sessions.setChatConfig(chatId, body);
          if (!result) return fail(res, 404, 'chat not found');
          return send(res, 200, { ok: true, ...result });
        } catch (err) {
          return fail(res, err?.status || 500, err?.message || 'config failed');
        }
      }

      if (action === 'config-refresh' && method === 'POST') {
        // Prewarm on user intent only (BUG-079): spawn + session/new, no
        // prompt — the reply carries the freshly advertised selects.
        try {
          const result = await sessions.refreshChatConfig(chatId);
          if (!result) return fail(res, 404, 'chat not found');
          return send(res, 200, { ok: true, ...result });
        } catch (err) {
          return fail(res, err?.status || 502, err?.message || 'agent start failed');
        }
      }

      if (action === 'agent' && method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        // Intent-gated warm (composer focus): a silent no-op when warming
        // is disabled. An explicit prewarm (no marker) always spawns.
        if (body?.warm && !sessions.defaults.createWarm) {
          return send(res, 200, { ok: true, warmed: false });
        }
        try {
          const client = await sessions.ensureClient(chatId);
          return send(res, 200, {
            ok: true,
            warmed: true,
            sessionId: client.sessionId,
            mode: client.sessionMode,
            agent: client.agentInfo,
          });
        } catch (err) {
          return fail(res, 502, err?.message || 'agent start failed');
        }
      }

      if (action === 'agent' && method === 'DELETE') {
        const ok = await sessions.releaseClient(chatId, 'client requested');
        return send(res, 200, { ok });
      }

      if (action === 'move' && method === 'POST') {
        const body = await readJson(req);
        const chat = sessions.moveChat(chatId, String(body.groupId || ''));
        return chat
          ? send(res, 200, { ok: true, chat: sessions.chatSummary(chat), ...sessions.groupsState() })
          : fail(res, 404, 'chat or group not found');
      }

    }

    // ---- diagram download ------------------------------------------
    if (method === 'POST' && pathname === '/api/download') {
      try {
        const body = await readJson(req, 48 * 1024 * 1024);
        const rawName = String(body.filename || 'download.bin').replace(/[/\\?%*:|"<>]/g, '_');
        let base = path.basename(rawName) || 'download.bin';
        const downloads = resolveDownloadsDir();
        fs.mkdirSync(downloads, { recursive: true });

        let buf;
        if (typeof body.base64 === 'string' && body.base64) {
          buf = Buffer.from(body.base64, 'base64');
        } else if (typeof body.text === 'string') {
          buf = Buffer.from(body.text, 'utf8');
        } else {
          return fail(res, 400, 'missing text or base64');
        }
        if (!buf.length) return fail(res, 400, 'empty payload');
        // Cap 40MB diagram/export
        if (buf.length > 40 * 1024 * 1024) return fail(res, 413, 'file too large');

        // Optional: SVG text → PNG (mac: qlmanage · Linux/Guix: rsvg-convert / convert)
        let rasterNote = null;
        if (body.rasterize === 'png') {
          try {
            const raster = await rasterizeSvgToPng(buf);
            if (!raster.ok) {
              return fail(res, 500, raster.error || 'svg→png raster failed', { detail: raster.detail });
            }
            buf = raster.buf;
            rasterNote = raster.engine;
            if (!base.toLowerCase().endsWith('.png')) {
              base = base.replace(/\.svg$/i, '') + '.png';
            }
          } catch (err) {
            return fail(res, 500, err?.message || String(err));
          }
        }

        let dest = path.join(downloads, base);
        if (fs.existsSync(dest)) {
          const ext = path.extname(base);
          const stem = path.basename(base, ext);
          dest = path.join(downloads, `${stem}-${Date.now()}${ext || ''}`);
        }
        fs.writeFileSync(dest, buf);

        // Reveal in file manager (Finder / xdg-open) best-effort
        let revealed = false;
        if (body.reveal !== false) {
          revealed = revealFile(dest);
        }

        console.log(`[download] saved ${dest} (${buf.length} bytes)${rasterNote ? ` raster=${rasterNote}` : ''}`);
        return send(res, 200, {
          ok: true,
          path: dest,
          filename: path.basename(dest),
          bytes: buf.length,
          revealed,
          raster: rasterNote,
        });
      } catch (err) {
        return fail(res, 500, err?.message || String(err));
      }
    }

    // Reveal an existing file in file manager (after host-side rasterize)
    if (method === 'POST' && pathname === '/api/download/reveal') {
      try {
        const body = await readJson(req);
        const filePath = String(body.path || '');
        if (!filePath || !fs.existsSync(filePath)) {
          return fail(res, 404, 'not found');
        }
        // Only allow under user home (Downloads / tmp)
        const home = os.homedir();
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(home + path.sep) && !resolved.startsWith(os.tmpdir())) {
          return fail(res, 403, 'path not allowed');
        }
        const revealed = revealFile(resolved);
        return send(res, 200, { ok: true, path: resolved, revealed });
      } catch (err) {
        return fail(res, 500, err?.message || String(err));
      }
    }

    // ---- static ----------------------------------------------------
    if (method === 'GET' || method === 'HEAD') {
      if (VENDOR[pathname]) {
        if (await serveStatic(res, VENDOR[pathname], { cache: true })) return;
        return fail(res, 404, 'vendor asset missing — run `npm install`');
      }
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const abs = path.join(RENDERER, rel);
      // Path traversal guard: everything served here must stay under RENDERER.
      if (abs === RENDERER || abs.startsWith(RENDERER + path.sep)) {
        if (await serveStatic(res, abs)) return;
      }
      if (pathname === '/') return fail(res, 500, 'renderer/index.html missing');
    }

    return fail(res, 404, `no route for ${method} ${pathname}`);
  } catch (err) {
    return fail(res, 500, err?.message || 'internal error');
  }
});

// ------------------------------------------------------------- lifecycle

server.listen(PORT, HOST, () => {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  const url = `http://${HOST}:${PORT}/`;
  console.log(`[muse-desktop] host v${pkg.version} pid=${process.pid} → ${url}`);
  console.log(`[muse-desktop] state=${STATE} agent=${MUSE_BIN}`);
  if (!process.env.NO_OPEN) {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  }
});

server.on('error', (err) => {
  console.error(`[muse-desktop] listen failed on ${HOST}:${PORT} — ${err.message}`);
  process.exit(1);
});

let shuttingDown = false;
async function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[muse-desktop] ${signal} — shutting down`);
  const keep = process.env.MUSE_DESKTOP_KEEP_ON_EXIT === '1';
  await sessions.shutdown({ killAgents: !keep });
  wire.closeAll();
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref?.();
}

process.on('SIGINT', () => void gracefulExit('SIGINT'));
process.on('SIGTERM', () => void gracefulExit('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[muse-desktop] uncaught', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[muse-desktop] unhandled rejection', err);
});

export { server, sessions, store, wire };
