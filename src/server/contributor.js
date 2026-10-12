// Contributor billing mode for the desktop.
//
// The CLI moved contributor mode out of the model list and into its own
// settings.json (contributor_mode_enabled): model/list no longer advertises
// the -contributor ids, so the desktop reads the flag itself. It decides
// which rate row prices a session and feeds the cost badge.
//
// The default is contributor ON — an absent key, a missing file, or an
// unreadable file all resolve to enabled. This deployment standardized on
// the contributor tier. An explicit false is always honored: the default
// never overrides a deliberate opt-out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The CLI's own config root: $XDG_CONFIG_HOME/muse, else ~/.config/muse. */
export function cliSettingsPath(env = process.env) {
  const base = env?.XDG_CONFIG_HOME?.trim()
    ? env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(base, 'muse', 'settings.json');
}

/**
 * Effective contributor state. Never throws — the cost bar must keep
 * painting even when the CLI config is missing or corrupt.
 * @returns {{ enabled: boolean, source: 'settings'|'default', path: string }}
 */
export function readContributorState(file = cliSettingsPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw?.contributor_mode_enabled === false) return { enabled: false, source: 'settings', path: file };
    if (raw?.contributor_mode_enabled === true) return { enabled: true, source: 'settings', path: file };
  } catch {
    /* missing or corrupt — fall through to the default below */
  }
  return { enabled: true, source: 'default', path: file };
}

/**
 * Explicitly switch the mode (the desktop's contributor toggle): writes
 * contributor_mode_enabled to the CLI settings, preserving every other key
 * and keeping a .bak of the pre-change file. Enabling also records the
 * disclosure acknowledgment — the toggle label carries the data-use notice,
 * so the click itself is the informed consent. Disabling leaves the
 * acknowledgment untouched. Throws on a missing-but-uncreatable path or a
 * malformed file (those are never overwritten); the route turns that into
 * a 500, never a silent no-op.
 * @returns {{ enabled: boolean, source: 'settings', path: string }}
 */
export function setContributorEnabled(enabled, { file = cliSettingsPath() } = {}) {
  if (typeof enabled !== 'boolean') throw new Error('enabled must be a boolean');
  let doc = null;
  let present = false;
  try {
    present = fs.existsSync(file);
    doc = present ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema_version: 1 };
  } catch {
    throw new Error(`refusing to rewrite unreadable settings at ${file}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`refusing to rewrite unreadable settings at ${file}`);
  }
  if (present) {
    try {
      if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
    } catch {
      /* the backup is a nicety, never a failure */
    }
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const next = { ...doc, contributor_mode_enabled: enabled };
  if (enabled) next.contributor_mode_disclosure_acknowledged = true;
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return { enabled, source: 'settings', path: file };
}

/**
 * Make contributor the default on disk: when the CLI settings file is
 * missing it is created minimal; when it exists without the key, the key
 * is added (a .bak of the pre-change file is kept). An explicit true/false
 * is never rewritten, a malformed file is never touched, and failures
 * resolve to the in-memory default instead of throwing.
 * Set MUSE_DESKTOP_CONTRIBUTOR_DEFAULT=0 to skip the write entirely.
 */
export function ensureContributorDefault({ file = cliSettingsPath(), env = process.env } = {}) {
  if (env?.MUSE_DESKTOP_CONTRIBUTOR_DEFAULT === '0') return readContributorState(file);
  try {
    // Existence first: a present-but-unparseable file belongs to the user
    // and must never be overwritten — only a truly missing file is created.
    const present = fs.existsSync(file);
    let doc = null;
    try {
      doc = present ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    } catch {
      doc = null;
    }
    if (present && doc && typeof doc === 'object' && !Array.isArray(doc)) {
      if ('contributor_mode_enabled' in doc) return readContributorState(file);
      try {
        if (!fs.existsSync(`${file}.bak`)) fs.copyFileSync(file, `${file}.bak`);
      } catch {
        /* the backup is a nicety, never a failure */
      }
      fs.writeFileSync(file, JSON.stringify({ ...doc, contributor_mode_enabled: true }, null, 2));
      return { enabled: true, source: 'default-written', path: file };
    }
    // A present-but-unparseable file belongs to the user — leave it alone.
    if (present) return { enabled: true, source: 'default', path: file };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ schema_version: 1, contributor_mode_enabled: true }, null, 2),
    );
    return { enabled: true, source: 'default-written', path: file };
  } catch {
    return { enabled: true, source: 'default', path: file };
  }
}
