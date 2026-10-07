// On-disk subscription-usage snapshot for external readers.
//
// The in-memory cache in SessionManager feeds the UI pill; this file feeds
// Übersicht (ai-limits-ubersicht/collect.py), which cannot talk to the agent
// hosts directly — they refuse external connections. Same payload shape as
// `usage/read` (sanitized): { tier, observedAtMs, window, weekly }.
//
// Writers must never throw: a failed snapshot write must not break a turn.

import fs from 'node:fs';
import path from 'node:path';

export const USAGE_CACHE_VERSION = 1;
export const USAGE_CACHE_NAME = 'usage.json';

export function usageCacheFile(stateDir) {
  return path.join(stateDir, USAGE_CACHE_NAME);
}

export function usageCachePayload(usage, nowMs = Date.now()) {
  return { version: USAGE_CACHE_VERSION, writtenAtMs: nowMs, usage: usage ?? null };
}

/** Atomic tmp+rename write. Returns true on success, false on any failure. */
export function writeUsageCache(file, usage, nowMs = Date.now()) {
  if (!file || !usage) return false;
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(usageCachePayload(usage, nowMs)));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
