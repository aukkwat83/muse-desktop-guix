// Native file/folder picker for non-macOS hosts (attach popover).
//
// The darwin branch in index.js drives `osascript`, which does not exist on
// Linux, and the host is a plain Node process with no GTK binding of its own —
// so we shell out to whichever freedesktop dialog is installed. Before this
// module the popover's two browse buttons were dead controls on Linux: the route
// hard-returned "native picker available on macOS only" and the renderer only
// surfaced it as a hover tooltip.
//
// Everything except resolveDialog() is pure, so the argv/parse/cancel rules are
// unit-testable without spawning a GUI (scripts/unit-test-guix-platform.mjs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Dialog binaries we know how to drive, best first.
 * qarma (Qt) and yad (fork) accept zenity's --file-selection argv, so they share
 * its kind; kdialog has its own flags.
 */
const DIALOGS = [
  { bin: 'zenity', kind: 'zenity' },
  { bin: 'qarma', kind: 'zenity' },
  { bin: 'yad', kind: 'zenity' },
  { bin: 'kdialog', kind: 'kdialog' },
];

/** @param {string} p absolute path or bare name @returns {'zenity'|'kdialog'} */
export function dialogKindFor(p) {
  const base = path.basename(String(p || '')).toLowerCase();
  const known = DIALOGS.find((d) => d.bin === base);
  return known ? known.kind : 'zenity';
}

/**
 * Where to look for a dialog binary. Guix has no FHS, so /usr/bin is a fallback
 * rather than the primary location, and the profile dirs come first.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function dialogSearchPaths(env = process.env) {
  const home = os.homedir();
  const fromPath = String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  return [
    path.join(home, '.guix-profile', 'bin'),
    '/run/current-system/profile/bin',
    ...fromPath,
    '/usr/bin',
  ];
}

/**
 * Locate a usable dialog. Probed per request, not cached at import: the host may
 * outlive a `guix install`, and it can be launched from a different profile
 * (guix shell / FHS container) than the one that will later provide zenity.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{bin: string, kind: 'zenity'|'kdialog'}|null}
 */
export function resolveDialog(env = process.env) {
  const override = env.MUSE_DESKTOP_FILE_DIALOG;
  if (override) {
    try {
      if (fs.existsSync(override)) return { bin: override, kind: dialogKindFor(override) };
    } catch { /* fall through to the probe */ }
  }
  const dirs = dialogSearchPaths(env);
  for (const d of DIALOGS) {
    for (const dir of dirs) {
      const abs = path.join(dir, d.bin);
      try {
        if (fs.existsSync(abs)) return { bin: abs, kind: d.kind };
      } catch { /* unreadable dir — keep probing */ }
    }
  }
  return null;
}

/**
 * argv for the dialog. Note this is handed to execFile (no shell), so the
 * separator below must be a real newline character, not a shell-quoted "\n".
 * zenity's default separator is "|", which is a legal character in a POSIX
 * filename, so overriding it is required for correctness, not just taste.
 * @param {'zenity'|'kdialog'} kind
 * @param {{folder?: boolean, title?: string}} [opts]
 * @returns {string[]}
 */
export function dialogArgs(kind, opts = {}) {
  const folder = !!opts.folder;
  const title =
    opts.title ||
    (folder
      ? 'เลือกโฟลเดอร์ให้ Muse อ่าน (เลือกได้หลายโฟลเดอร์)'
      : 'แนบไฟล์ให้ Muse อ่าน (เลือกได้หลายไฟล์)');

  if (kind === 'kdialog') {
    // kdialog joins multiple results with spaces unless --separate-output;
    // --getexistingdirectory takes a single directory only.
    return folder
      ? ['--title', title, '--getexistingdirectory', os.homedir()]
      : ['--title', title, '--multiple', '--separate-output', '--getopenfilename', os.homedir()];
  }

  const args = ['--file-selection', '--multiple', '--separator=\n', `--title=${title}`];
  if (folder) args.push('--directory');
  return args;
}

/**
 * Split dialog stdout into absolute paths.
 * @param {string} stdout
 * @returns {string[]}
 */
export function parsePickerPaths(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Did the user dismiss the dialog rather than hit a real failure?
 * zenity and kdialog both exit 1 with empty stdout on cancel, which the exit
 * code alone cannot distinguish from an error — so "non-zero and nothing
 * selected" is the cancel signal, and anything that produced paths is a success.
 * @param {any} err execFile error (or null)
 * @param {string} stdout
 * @returns {boolean}
 */
export function isPickerCancel(err, stdout) {
  if (!err) return false;
  if (parsePickerPaths(stdout).length) return false;
  const code = typeof err.code === 'number' ? err.code : null;
  return code === 1 || code === 255;
}

/**
 * Message shown (visibly, in the popover) when no dialog binary exists.
 * @returns {string}
 */
export function noDialogMessage() {
  return 'ไม่พบโปรแกรมเลือกไฟล์ของระบบ — ติดตั้งด้วย `guix install zenity` หรือวางพาธเองด้านล่าง';
}
