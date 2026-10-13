// Slash command parsing (BUG-053), ported from grok-desktop's
// handleSlashCommands (app.js:1857-1891). Pure: returns an intent, app.js
// executes it against the existing POST /mode flow.
//
// The modes here are muse-desktop's internal SessionMode names
// ('normal'|'plan'|'always' — src/server/session-mode.js), NOT MSP wire ids:
// the server resolves those against the agent's advertised configOptions via
// MspClient.resolveModeId(). Never hardcode a wire id in the renderer.

/**
 * @param {string} text raw composer text
 * @returns {{ type: 'none' }
 *   | { type: 'mode', mode: 'plan'|'normal'|'always', rest: string }
 *   | { type: 'toggle-always' }
 *   | { type: 'research', rest: string }
 *   | { type: 'research-toggle', enabled: boolean | null }
 *   | { type: 'unknown', name: string }}
 */
export function parseSlashCommand(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('/')) return { type: 'none' };

  // /plan [description] — switch to plan mode, then send the rest if present.
  let m = t.match(/^\/plan(?:\s+([\s\S]+))?$/i);
  if (m) return { type: 'mode', mode: 'plan', rest: (m[1] || '').trim() };

  // /always-approve [on|off] — bare form toggles against the current mode,
  // which only the renderer knows, so the parser defers it.
  m = t.match(/^\/always-approve(?:\s+(on|off))?$/i);
  if (m) {
    const arg = (m[1] || '').toLowerCase();
    if (arg === 'on') return { type: 'mode', mode: 'always', rest: '' };
    if (arg === 'off') return { type: 'mode', mode: 'normal', rest: '' };
    return { type: 'toggle-always' };
  }

  // /ask → back to normal mode.
  if (/^\/ask\s*$/i.test(t)) return { type: 'mode', mode: 'normal', rest: '' };

  // /deep-research (v1.1.39): bare toggles this chat's Deep Research
  // pill, on|off sets it, anything else is a one-shot research topic —
  // the desktop harness rides on the wire, the topic stays verbatim.
  m = t.match(/^\/deep-research(?:\s+([\s\S]+))?$/i);
  if (m) {
    const rest = (m[1] || '').trim();
    if (!rest) return { type: 'research-toggle', enabled: null };
    if (/^on$/i.test(rest)) return { type: 'research-toggle', enabled: true };
    if (/^off$/i.test(rest)) return { type: 'research-toggle', enabled: false };
    return { type: 'research', rest };
  }

  // A leading slash that is none of the above: the caller must not eat the
  // text — it goes out as a normal prompt behind a Thai notice.
  return { type: 'unknown', name: t.split(/\s+/, 1)[0] };
}

export default parseSlashCommand;
