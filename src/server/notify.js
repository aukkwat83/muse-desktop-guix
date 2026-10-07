// macOS banner payload for agent questions (POST /api/notify).
//
// The WKWebView shell does not deliver Web Notifications reliably, so an
// agent question also fans out through osascript here — a real banner even
// when the window is behind something else. Pure builders (unit-tested);
// index.js owns the spawn itself. Fire-and-forget by contract: a
// notification failure must never fail the turn it announces.

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
