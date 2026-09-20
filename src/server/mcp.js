// MCP catalog + status probing for Muse Desktop.
//
// MSP exposes no runtime MCP surface (no list/status/toggle method on the
// stable or experimental schema, and `session/start`'s `config.mcpServers`
// needs a `sessionMcp` capability this host never grants). The only control
// plane is the host's own settings file:
//
//   ${XDG_CONFIG_HOME:-~/.config}/muse/settings.json  →  mcpServers
//
// Probed facts (2026-09-20, real `muse serve` + model turns):
//   - the host loads settings.json servers into every session; tools surface
//     as `mcp__<server>.<tool>` via deferred discovery;
//   - per-server `"enabled": false` is honored (github tools vanished, then
//     reappeared after restore); there is no other disable flag;
//   - a new serve process re-reads the file, so a toggle takes effect on the
//     next agent spawn — never on a running session.
//
// This module therefore does three things the wire cannot:
//   1. read the catalog (safe fields only — see SAFE_ENTRY),
//   2. probe each server with a real MCP handshake (status for the panel),
//   3. flip `enabled` (toggle), with a backup before every write.
//
// SECURITY: full entries (command/args/env/headers/url) never leave this
// module's callers on the server. The HTTP layer only ever sees the safe
// projection. Grep for `fullEntry` if you touch this file — it must not
// appear in any response body.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MCP_PROBE_TIMEOUT_MS = Number(process.env.MUSE_DESKTOP_MCP_PROBE_MS || 10_000);
export const MCP_PROBE_CONCURRENCY = Number(process.env.MUSE_DESKTOP_MCP_PROBE_FANOUT || 4);
const BACKUP_SUFFIX = '.bak-muse-desktop';

export function settingsPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'muse', 'settings.json');
}

function transportOf(entry) {
  if (entry && typeof entry === 'object') {
    if (typeof entry.command === 'string' && entry.command) return 'stdio';
    if (typeof entry.url === 'string' && entry.url) return 'http';
  }
  return 'unknown';
}

function hostOf(url) {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Safe projection: everything the UI may see. No command/args/env/headers. */
export function safeEntry(name, entry) {
  const transport = transportOf(entry);
  return {
    name,
    transport,
    mode: typeof entry?.mode === 'string' ? entry.mode : 'optional',
    enabled: entry?.enabled !== false,
    ...(transport === 'http' ? { host: hostOf(entry.url) } : {}),
  };
}

function readSettingsFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('settings.json is not a JSON object');
  }
  return { raw, doc };
}

/**
 * The configured catalog. Returns `{ servers, error }` — error is set (and
 * servers empty) when the file is missing or unparseable, so the panel can
 * say so instead of showing a misleading empty list.
 */
export function readCatalog(file = settingsPath()) {
  try {
    const { doc } = readSettingsFile(file);
    const servers = doc.mcpServers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
      return { servers: [], error: null };
    }
    return {
      servers: Object.keys(servers).sort().map((name) => safeEntry(name, servers[name])),
      error: null,
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return { servers: [], error: 'settings.json not found' };
    return { servers: [], error: `settings.json unreadable: ${shortErr(err)}` };
  }
}

/** Full entries for the prober. SERVER-SIDE ONLY — never serialize to HTTP. */
export function readFullEntries(file = settingsPath()) {
  const { doc } = readSettingsFile(file);
  const servers = doc?.mcpServers;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
}

function shortErr(err, max = 160) {
  const msg = err instanceof Error ? err.message : String(err ?? 'unknown error');
  const flat = msg.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ---------------------------------------------------------------- probing

const INIT_REQ = {
  jsonrpc: '2.0',
  id: 'probe-init',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'muse-desktop-probe', version: '1.0.0' },
  },
};

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Stdout cap per probe — big tool schemas (azure/gitlab) clear 64KB easily. */
const PROBE_STDOUT_CAP = 1_000_000;

function probeStdio(fullEntry, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    let handshook = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(result);
    };
    let child;
    try {
      child = spawn(fullEntry.command, fullEntry.args || [], {
        env: { ...process.env, ...(fullEntry.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ status: 'failed', latencyMs: Date.now() - t0, error: shortErr(err) });
      return;
    }
    const timer = setTimeout(() => {
      // A stall after the handshake still proves the server is alive — only
      // the optional tool count is lost.
      finish(handshook
        ? { status: 'connected', latencyMs: Date.now() - t0, tools: null }
        : { status: 'failed', latencyMs: Date.now() - t0, error: `handshake timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    child.on('error', (err) => {
      clear();
      finish({ status: 'failed', latencyMs: Date.now() - t0, error: shortErr(err) });
    });
    child.on('exit', (code) => {
      if (done) return;
      clear();
      finish({
        status: 'failed',
        latencyMs: Date.now() - t0,
        error: code === 0 ? 'server exited before handshake' : `server exited (code ${code}) before handshake`,
      });
    });
    let buf = '';
    let listed = false;
    child.stdout.on('data', (chunk) => {
      if (done) return;
      buf += chunk.toString('utf8');
      if (buf.length > PROBE_STDOUT_CAP) {
        clear();
        // Past the handshake the server is definitively alive — only the
        // (optional) tool count is lost to the flood.
        finish(handshook
          ? { status: 'connected', latencyMs: Date.now() - t0, tools: null }
          : { status: 'failed', latencyMs: Date.now() - t0, error: 'server flooded stdout before handshake' });
        return;
      }
      let nl;
      while (!done && (nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = parseJsonLine(line);
        if (!msg || typeof msg !== 'object') continue;
        if (msg.id === 'probe-init' && !listed) {
          if (msg.error) {
            clear();
            finish({ status: 'failed', latencyMs: Date.now() - t0, error: shortErr(msg.error.message || 'initialize rejected') });
            return;
          }
          if (msg.result && typeof msg.result === 'object') {
            // Handshake accepted — ask for the tool list so the panel can
            // show a count, then report connected either way.
            handshook = true;
            listed = true;
            try {
              child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'probe-tools', method: 'tools/list', params: {} })}\n`);
            } catch {
              clear();
              finish({ status: 'connected', latencyMs: Date.now() - t0, tools: null });
            }
          }
          continue;
        }
        if (msg.id === 'probe-tools') {
          clear();
          const tools = msg?.result?.tools;
          finish({
            status: 'connected',
            latencyMs: Date.now() - t0,
            tools: Array.isArray(tools) ? tools.length : null,
          });
        }
      }
    });
    try {
      child.stdin.write(`${JSON.stringify(INIT_REQ)}\n`);
    } catch (err) {
      clear();
      finish({ status: 'failed', latencyMs: Date.now() - t0, error: shortErr(err) });
    }
  });
}

async function probeHttp(fullEntry, timeoutMs) {
  const t0 = Date.now();
  const fail = (error) => ({ status: 'failed', latencyMs: Date.now() - t0, error });
  let headers = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  if (fullEntry.headers && typeof fullEntry.headers === 'object') {
    headers = { ...headers, ...fullEntry.headers };
  }
  let res;
  try {
    res = await fetch(fullEntry.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...INIT_REQ, id: 'probe-init' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(shortErr(err));
  }
  try {
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok) return fail(`HTTP ${res.status}`);
    if (ctype.includes('text/event-stream')) {
      const text = await res.text();
      const line = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith('data:'));
      const payload = line ? parseJsonLine(line.slice(5).trim()) : null;
      if (payload?.result) return { status: 'connected', latencyMs: Date.now() - t0, tools: null };
      return fail(shortErr(payload?.error?.message || 'handshake rejected'));
    }
    const payload = await res.json();
    if (payload?.result) return { status: 'connected', latencyMs: Date.now() - t0, tools: null };
    return fail(shortErr(payload?.error?.message || 'handshake rejected'));
  } catch (err) {
    return fail(shortErr(err));
  }
}

/** Probe one server by name. Disabled servers are never spawned. */
export async function probeServer(name, { file = settingsPath(), timeoutMs = MCP_PROBE_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  let entries;
  try {
    entries = readFullEntries(file);
  } catch (err) {
    return { name, status: 'failed', latencyMs: Date.now() - t0, error: shortErr(err) };
  }
  const entry = entries[name];
  if (!entry || typeof entry !== 'object') {
    return { name, status: 'unknown', latencyMs: Date.now() - t0, error: 'not in catalog' };
  }
  if (entry.enabled === false) {
    return { name, status: 'disabled', latencyMs: 0, error: null };
  }
  const transport = transportOf(entry);
  if (transport === 'stdio') {
    return { name, ...await probeStdio(entry, timeoutMs) };
  }
  if (transport === 'http') {
    return { name, ...await probeHttp(entry, timeoutMs) };
  }
  return { name, status: 'failed', latencyMs: Date.now() - t0, error: 'entry has neither command nor url' };
}

/** Probe every enabled server with bounded fanout. Never throws per-server. */
export async function probeAll({ file = settingsPath(), timeoutMs = MCP_PROBE_TIMEOUT_MS, concurrency = MCP_PROBE_CONCURRENCY } = {}) {
  let names;
  try {
    const entries = readFullEntries(file);
    names = Object.keys(entries).sort();
  } catch (err) {
    return { results: [], probedAt: Date.now(), error: shortErr(err) };
  }
  const results = new Array(names.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(concurrency, names.length || 1))).fill(null).map(async () => {
    while (next < names.length) {
      const i = next++;
      try {
        results[i] = await probeServer(names[i], { file, timeoutMs });
      } catch (err) {
        results[i] = { name: names[i], status: 'failed', latencyMs: 0, error: shortErr(err) };
      }
    }
  });
  await Promise.all(workers);
  return { results, probedAt: Date.now(), error: null };
}

// ---------------------------------------------------------------- toggle

/**
 * Flip one server's `enabled` flag. Enabling deletes the flag (restoring the
 * pristine entry shape); disabling sets it false. Writes a `.bak-muse-desktop`
 * backup first. Returns `{ enabled }` or throws.
 */
export function setEnabled(name, enabled, file = settingsPath()) {
  const { doc } = readSettingsFile(file);
  const servers = doc.mcpServers;
  if (!servers || typeof servers !== 'object' || !servers[name] || typeof servers[name] !== 'object') {
    throw new Error(`unknown MCP server: ${name}`);
  }
  if (enabled) {
    delete servers[name].enabled;
  } else {
    servers[name].enabled = false;
  }
  fs.copyFileSync(file, `${file}${BACKUP_SUFFIX}`);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { enabled: servers[name].enabled !== false };
}
