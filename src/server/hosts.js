// MSP permission-card builders for the desktop shell.
//
// muse serve runs tools server-side, so there are no client-hosted terminals
// or files here (the ACP hosts.js in the kimi lineage had them). What remains
// is the renderer contract: every approval / question becomes a card payload
// { id, toolName, toolCallId, summary, subtype, body, options } that
// sessions._onPermission stores and broadcasts, exactly like before.

/**
 * Readable rendering of an ACP `{type:'diff'}` block: the path, then
 * `-old` / `+new` lines. Kept from the kimi lineage — extractToolOutput
 * stays tolerant of agents that stream diff blocks, and the unit test pins
 * the rendering.
 */
export function formatDiffPreview(block) {
  const lines = [];
  if (block?.path != null && block.path !== '') lines.push(String(block.path));
  const oldText = typeof block?.oldText === 'string' ? block.oldText : '';
  const newText = typeof block?.newText === 'string' ? block.newText : '';
  if (oldText) for (const line of oldText.split('\n')) lines.push(`- ${line}`);
  if (newText) for (const line of newText.split('\n')) lines.push(`+ ${line}`);
  return lines.join('\n');
}

function oneLine(s, cap) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap);
}

/**
 * Headline for an approval card from the MSP ApprovalSubject. The card must
 * show WHAT is being approved — a blind approve button is how `rm -rf`
 * happens. Capped at 240 chars; the full detail goes to mspApprovalBody.
 */
export function mspApprovalSummary(params = {}) {
  const subject = params?.subject && typeof params.subject === 'object' ? params.subject : {};
  const kind = String(subject.kind || '');
  const toolName = String(params?.toolName || subject.toolName || 'tool');
  const rawArgs = typeof params?.rawArgs === 'string' ? params.rawArgs : '';

  switch (kind) {
    case 'shell': {
      const cmd = String(subject.command || rawArgs || '').trim();
      if (cmd) return oneLine(cmd, 240);
      break;
    }
    case 'fileAccess': {
      const bits = [subject.access, subject.path].filter(Boolean).map(String);
      if (bits.length) return oneLine(bits.join(' '), 240);
      break;
    }
    case 'network': {
      const host = String(subject.host || '');
      const port = subject.port != null ? `:${subject.port}` : '';
      const proto = subject.protocol ? `${subject.protocol} ` : '';
      if (host) return oneLine(`${proto}${host}${port}`, 240);
      break;
    }
    case 'unixSocket': {
      if (subject.path) return oneLine(String(subject.path), 240);
      break;
    }
    case 'process': {
      const cmd = String(subject.command || subject.target || '').trim();
      if (cmd) return oneLine(cmd, 240);
      break;
    }
    default: {
      // `tool` and unknown kinds: lead with the tool name plus the most
      // telling arg — a command, path, pattern or URL when the verbatim
      // args JSON carries one, else the raw args themselves.
      if (rawArgs) {
        try {
          const parsed = JSON.parse(rawArgs);
          if (parsed && typeof parsed === 'object') {
            const pick =
              parsed.command ?? parsed.cmd ?? parsed.path ?? parsed.file ??
              parsed.file_path ?? parsed.pattern ?? parsed.url ?? parsed.prompt ?? null;
            if (pick != null && pick !== '') {
              const s = oneLine(typeof pick === 'string' ? pick : JSON.stringify(pick), 200);
              if (s) return `${toolName} ${s}`.slice(0, 240);
            }
          }
        } catch {
          /* not JSON — fall through to the raw slice */
        }
        const flat = oneLine(rawArgs, 200);
        if (flat) return `${toolName} ${flat}`.slice(0, 240);
      }
      break;
    }
  }
  if (rawArgs) {
    const flat = oneLine(rawArgs, 200);
    if (flat) return `${toolName} ${flat}`.slice(0, 240);
  }
  return toolName;
}

/**
 * Full detail for the approval card body. Empty when it would add nothing
 * over the summary — the renderer then shows the summary chip instead of a
 * duplicated markdown block (same rule as BUG-026's ordinary approvals).
 */
export function mspApprovalBody(params = {}) {
  const subject = params?.subject && typeof params.subject === 'object' ? params.subject : {};
  const kind = String(subject.kind || '');
  const rawArgs = typeof params?.rawArgs === 'string' ? params.rawArgs : '';
  const summary = mspApprovalSummary(params);

  let full = '';
  if (kind === 'shell' || kind === 'process') {
    full = String(subject.command || subject.target || rawArgs || '').trim();
  } else if (kind === 'fileAccess') {
    full = [subject.access, subject.path].filter(Boolean).join(' ');
  } else if (kind === 'network') {
    const host = String(subject.host || '');
    full = host ? `${subject.protocol ? `${subject.protocol} ` : ''}${host}${subject.port != null ? `:${subject.port}` : ''}` : rawArgs;
  } else if (kind === 'unixSocket') {
    full = String(subject.path || rawArgs || '');
  } else if (rawArgs) {
    try {
      full = JSON.stringify(JSON.parse(rawArgs), null, 2);
    } catch {
      full = rawArgs;
    }
  }
  full = String(full || '').trim().slice(0, 8000);
  if (!full) return '';
  // Same text the headline already shows (modulo whitespace) → no body.
  // Anything longer than the 240-char headline adds information.
  if (full.length <= 240 && oneLine(full, 240) === summary) return '';
  return full;
}

/** MSP availableChoices → the card's option list (ids pass straight back). */
export function mspApprovalOptions(params = {}) {
  const raw = Array.isArray(params?.availableChoices) ? params.availableChoices : [];
  return raw
    .map((c) => {
      const optionId = String(c?.choiceId ?? '').trim();
      if (!optionId) return null;
      return {
        optionId,
        name: c?.label != null ? String(c.label) : optionId,
        kind: c?.scope != null ? String(c.scope) : undefined,
      };
    })
    .filter(Boolean);
}

/**
 * The full card payload for an approval/request(ed) frame, or null when the
 * frame carries no usable approval id. requirementId rides along for the
 * multi-stage race guard on approval/decide.
 */
export function mspApprovalCard(params = {}) {
  const approvalId = String(params?.approvalId || '').trim();
  if (!approvalId) return null;
  const subject = params?.subject && typeof params.subject === 'object' ? params.subject : {};
  return {
    id: approvalId,
    approvalId,
    requirementId: params?.currentRequirementId ?? null,
    toolName: String(params?.toolName || subject.toolName || 'tool'),
    toolCallId: params?.toolCallId != null ? String(params.toolCallId) : null,
    summary: mspApprovalSummary(params),
    subtype: null,
    body: mspApprovalBody(params),
    options: mspApprovalOptions(params),
  };
}

function isApproveDecision(decision) {
  return (
    decision === 'approved' ||
    decision === 'approvedForSession' ||
    decision === 'approvedPolicyAmendment'
  );
}

function isDenyDecision(decision) {
  return decision === 'denied' || decision === 'deniedPolicyAmendment';
}

function choiceScopeRank(scope) {
  // Wider grant first for auto-approve: fewer future prompts.
  if (scope === 'localPersistent') return 0;
  if (scope === 'session') return 1;
  return 2;
}

/**
 * Pick the choice an always-approve session decides by itself: the widest
 * approve grant on offer, else the first approve, else null (caller falls
 * back to surfacing a card rather than deciding blind).
 */
export function pickMspApproveChoice(choices = []) {
  const list = Array.isArray(choices) ? choices : [];
  const approves = list.filter((c) => isApproveDecision(c?.decision));
  if (!approves.length) return null;
  return [...approves].sort(
    (a, b) => choiceScopeRank(a?.scope) - choiceScopeRank(b?.scope),
  )[0];
}

/** The choice a settle/timeout path denies with: an explicit deny, else the last resort. */
export function pickMspDenyChoice(choices = []) {
  const list = Array.isArray(choices) ? choices : [];
  return (
    list.find((c) => isDenyDecision(c?.decision)) ||
    list.find((c) => !isApproveDecision(c?.decision)) ||
    null
  );
}

/** A session-or-wider grant engages sticky approve for the rest of the session. */
export function mspChoiceIsSticky(choice) {
  const scope = String(choice?.scope || '');
  if (scope === 'session' || scope === 'localPersistent') return true;
  return /always/i.test(String(choice?.choiceId || ''));
}

/**
 * The card payload for a userInput/request(ed) frame — but ONLY the shape the
 * card UI can actually answer: exactly one single-select question with
 * options. optionIds are the labels verbatim; resolvePermission maps the
 * picked label back into userInput/answer. Anything else (multi-question,
 * multi-select, free-text-only) returns null and the client auto-cancels
 * with a notice instead of stranding the turn — the card posts a single
 * optionId and userInput/answer requires every question answered.
 */
export function mspUserInputCard(params = {}) {
  const userInputId = String(params?.userInputId || '').trim();
  const questions = Array.isArray(params?.questions) ? params.questions : [];
  if (!userInputId || questions.length !== 1) return null;
  const q = questions[0] || {};
  if (String(q?.selection?.mode || '') !== 'single') return null;
  const options = Array.isArray(q?.options) ? q.options : [];
  if (!options.length) return null;

  const questionText = String(q?.question || '').trim();
  const lines = [];
  if (questionText) lines.push(questionText);
  for (const o of options) {
    const label = String(o?.label || '').trim();
    if (!label) continue;
    const desc = String(o?.description || '').trim();
    lines.push(`- **${label}**${desc ? ` — ${desc}` : ''}`);
  }
  const body = lines.join('\n').slice(0, 8000);
  return {
    id: userInputId,
    userInputId,
    questionId: String(q?.id || ''),
    toolName: String(params?.toolName || 'AskUserQuestion'),
    toolCallId: params?.toolCallId != null ? String(params.toolCallId) : null,
    summary: oneLine(questionText, 240) || 'Choose an option',
    subtype: 'ask',
    body,
    options: options
      .map((o) => String(o?.label || '').trim())
      .filter(Boolean)
      .map((label) => ({ optionId: label, name: label, kind: 'allow_once' })),
  };
}
