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

export function mspDecisionIsApprove(decision) {
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
  const approves = list.filter((c) => mspDecisionIsApprove(c?.decision));
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
    list.find((c) => !mspDecisionIsApprove(c?.decision)) ||
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
 * Schema ceiling for user-authored answer text (binary 1.4.3
 * UserInputAnswerParams: freeText <= 500, note <= 500). Both client and
 * server validation pin this constant — the binary answers anything past it
 * with -32057, so the form must refuse first.
 */
export const USER_INPUT_TEXT_MAX = 500;

/**
 * Normalize the wire `questions` array into the renderer's form model.
 * Every question keeps its wire `id` (the answer's `questionId`), its
 * closed-vocabulary `mode`, its label options, and a `freeText` flag for
 * questions with no options.
 *
 * Ids and labels are preserved EXACTLY as the wire sent them — labels ARE
 * the answer ids (the schema defines no option ids), so trimming or
 * re-casing them here would answer a different pick than the user made.
 * Blank ids/labels fail validation instead of being silently fixed.
 *
 * Selection bounds are validated, never silently rewritten: a present
 * min/max must be an integer >= 0, min must not exceed max (for questions
 * WITH options — bounds don't constrain free text), and min:0 is legal
 * (an empty multi-pick answers it). Absent bounds default to min 1 (0
 * when options-less) / max options.length. An invalid bound makes the
 * whole frame malformed — the client auto-cancels with a trace rather
 * than guessing. Returns { questions } or { error } for a frame no form
 * can answer.
 */
export function normalizeUserInputQuestions(params = {}) {
  const raw = Array.isArray(params?.questions) ? params.questions : [];
  if (!raw.length) return { error: 'no questions' };
  const questions = [];
  for (const q of raw) {
    const id = String(q?.id ?? '');
    const mode = String(q?.selection?.mode ?? '');
    if (!id.trim()) return { error: 'question without id' };
    if (mode !== 'single' && mode !== 'multiple') return { error: `question ${id}: unknown mode` };
    const options = [];
    for (const o of Array.isArray(q?.options) ? q.options : []) {
      const label = String(o?.label ?? '');
      if (!label.trim()) continue; // unpickable — skip, don't rewrite
      options.push({ label, description: String(o?.description ?? '') });
    }
    const sel = q?.selection || {};
    let { minSelections, maxSelections } = sel;
    if (minSelections == null) minSelections = options.length ? 1 : 0;
    if (maxSelections == null) maxSelections = options.length;
    if (!Number.isInteger(minSelections) || minSelections < 0) {
      return { error: `question ${id}: bad minSelections` };
    }
    if (!Number.isInteger(maxSelections) || maxSelections < 0) {
      return { error: `question ${id}: bad maxSelections` };
    }
    // Bounds only constrain picks: options-less (free-text) questions
    // default to min 0 / max 0 instead of tripping min > max.
    if (options.length && minSelections > maxSelections) {
      return { error: `question ${id}: minSelections exceeds maxSelections` };
    }
    questions.push({
      id,
      header: String(q?.header ?? ''),
      question: String(q?.question ?? ''),
      mode,
      minSelections,
      maxSelections,
      options,
      freeText: options.length === 0,
    });
  }
  return { questions };
}

/**
 * The card payload for a userInput/request(ed) frame — every shape the form
 * UI can answer: any number of questions, single- or multi-select, and
 * free-text (options-less) questions. `questions` is the form model;
 * single-question single-select cards also keep the legacy top-level
 * `options` (labels verbatim) so the transcript card keeps its one-click
 * row and the old contract stays green. Returns null only for a frame no
 * form can answer — the client auto-cancels those with a notice instead
 * of stranding the turn.
 */
export function mspUserInputCard(params = {}) {
  const userInputId = String(params?.userInputId || '').trim();
  if (!userInputId) return null;
  const { questions, error } = normalizeUserInputQuestions(params);
  if (error || !questions) return null;

  const lines = [];
  for (const q of questions) {
    const head = q.header || q.question;
    if (head && questions.length > 1) lines.push(`**${head}**`);
    if (q.question && questions.length === 1) lines.push(q.question);
    if (q.question && questions.length > 1 && q.question !== q.header) lines.push(q.question);
    for (const o of q.options) {
      lines.push(`- **${o.label}**${o.description ? ` — ${o.description}` : ''}`);
    }
    if (q.freeText) lines.push('*พิมพ์คำตอบเอง*');
  }
  const body = lines.join('\n').slice(0, 8000);
  const firstText = questions[0].question || questions[0].header;
  const summary = questions.length === 1
    ? oneLine(firstText, 240) || 'Choose an option'
    : oneLine(`${questions.length} คำถาม: ${firstText}`, 240);
  const single = questions.length === 1 && !questions[0].freeText && questions[0].mode === 'single';
  return {
    id: userInputId,
    userInputId,
    questionId: questions.length === 1 ? questions[0].id : null,
    toolName: String(params?.toolName || 'AskUserQuestion'),
    toolCallId: params?.toolCallId != null ? String(params.toolCallId) : null,
    summary,
    subtype: 'ask',
    body,
    questions,
    // Milliseconds the host waits before auto-resolving a timed prompt
    // (schema UserInputRequestParams.autoResolutionMs); absent = waits for
    // the human. The renderer sends userInput/engaged on first interaction
    // so the countdown disarms while the form is open.
    autoResolutionMs: Number.isFinite(params?.autoResolutionMs) ? params.autoResolutionMs : null,
    options: single
      ? questions[0].options.map((o) => ({ optionId: o.label, name: o.label, kind: 'allow_once' }))
      : [],
  };
}

/**
 * Validate a renderer answer set against the card's questions — the same
 * rules the binary enforces (UserInputAnswerParams: answer EVERY question;
 * exactly one of selectedLabel / selectedLabels / freeText per answer;
 * multi within min/max; freeText and note <= 500). Atomic: one bad entry
 * rejects the whole set with a machine `code` plus a Thai `error` the UI
 * can show verbatim. Pure — the node suite pins every shape.
 *
 * Ids and labels compare EXACTLY (no trimming): labels are the answer ids
 * on the wire, and a spaced label (' SQLite ') is a different pick than
 * its trimmed twin. Bounds come from normalize as validated (min:0 allows
 * an empty multi-pick) — never recomputed here.
 *
 * freeText is a first-class alternative for EVERY question, not just
 * options-less ones: the schema allows it independently per answer and
 * defines no allowOther gate, so the form offers Other/text on choice
 * questions too (until binary evidence contradicts the export).
 */
export function validateUserInputAnswers(questions = [], answers = []) {
  const qs = Array.isArray(questions) ? questions : [];
  const list = Array.isArray(answers) ? answers : [];
  if (!qs.length) return { ok: false, code: 'NO_QUESTIONS', error: 'คำถามหมดอายุหรือไม่ถูกต้อง' };
  if (list.length !== qs.length) {
    return {
      ok: false,
      code: 'ANSWER_INCOMPLETE',
      error: `ต้องตอบให้ครบ ${qs.length} ข้อ (ส่งมา ${list.length} ข้อ)`,
    };
  }
  const byId = new Map(qs.map((q) => [String(q?.id ?? ''), q]));
  const seen = new Set();
  const clean = [];
  for (const a of list) {
    const questionId = String(a?.questionId ?? '');
    const q = byId.get(questionId);
    if (!q || !questionId.trim()) {
      return { ok: false, code: 'UNKNOWN_QUESTION', error: 'มีคำตอบที่ไม่ตรงกับคำถาม', questionId };
    }
    if (seen.has(questionId)) {
      return { ok: false, code: 'ANSWER_DUPLICATE', error: 'ตอบคำถามเดิมซ้ำ', questionId };
    }
    seen.add(questionId);
    const head = q.header || q.question || questionId;
    const hasLabel = typeof a?.selectedLabel === 'string' && a.selectedLabel.trim() !== '';
    const hasLabels = Array.isArray(a?.selectedLabels);
    const hasText = typeof a?.freeText === 'string' && a.freeText.trim() !== '';
    const shapes = [hasLabel, hasLabels, hasText].filter(Boolean).length;
    if (shapes !== 1) {
      return {
        ok: false, code: 'ANSWER_SHAPE', questionId,
        error: `คำถาม “${head}” ต้องเลือกหรือพิมพ์คำตอบอย่างใดอย่างหนึ่ง`,
      };
    }
    const note = a?.note == null || a.note === '' ? undefined : String(a.note);
    if (note !== undefined && note.length > USER_INPUT_TEXT_MAX) {
      return {
        ok: false, code: 'NOTE_TOO_LONG', questionId,
        error: `โน้ตของ “${head}” ยาวเกิน ${USER_INPUT_TEXT_MAX} ตัวอักษร`,
      };
    }
    const entry = { questionId, ...(note !== undefined ? { note } : {}) };
    if (hasText) {
      // First-class freeText on ANY question (schema: independent
      // alternative, no allowOther gate) — the form's Other/text answer.
      const text = a.freeText.trim();
      if (text.length > USER_INPUT_TEXT_MAX) {
        return {
          ok: false, code: 'TEXT_TOO_LONG', questionId,
          error: `คำตอบของ “${head}” ยาวเกิน ${USER_INPUT_TEXT_MAX} ตัวอักษร`,
        };
      }
      entry.freeText = text;
    } else if (q.freeText) {
      return {
        ok: false, code: 'ANSWER_SHAPE', questionId,
        error: `คำถาม “${head}” ต้องพิมพ์คำตอบ`,
      };
    } else if (q.mode === 'single') {
      if (!hasLabel || !q.options.some((o) => o.label === a.selectedLabel)) {
        return {
          ok: false, code: 'UNKNOWN_LABEL', questionId,
          error: `ตัวเลือกของ “${head}” ไม่ถูกต้อง`,
        };
      }
      entry.selectedLabel = a.selectedLabel;
    } else {
      const picks = [...new Set((a.selectedLabels || []).map((s) => String(s)).filter((s) => s.trim() !== ''))];
      const min = q.minSelections ?? 1;
      const max = q.maxSelections ?? q.options.length;
      if (picks.length < min || picks.length > max) {
        return {
          ok: false, code: 'SELECTION_BOUNDS', questionId,
          error: min === max
            ? `คำถาม “${head}” ต้องเลือก ${min} ข้อ`
            : `คำถาม “${head}” ต้องเลือก ${min}–${max} ข้อ`,
        };
      }
      const bad = picks.find((p) => !q.options.some((o) => o.label === p));
      if (bad) {
        return {
          ok: false, code: 'UNKNOWN_LABEL', questionId,
          error: `ตัวเลือก “${bad}” ไม่ถูกต้อง`,
        };
      }
      entry.selectedLabels = picks;
    }
    clean.push(entry);
  }
  return { ok: true, answers: clean };
}

/**
 * Validate an approval decision against the CURRENT choices — the policy
 * gate: an unknown choiceId is a 400, never a blind decide (the binary
 * would -32052 it; the desktop refuses first). The settle sweep is the
 * only caller allowed to fall back to a deny choice, and it says so.
 */
export function validateApprovalDecision(choices = [], choiceId = '') {
  const list = Array.isArray(choices) ? choices : [];
  const want = String(choiceId || '').trim();
  const hit = list.find((c) => String(c?.choiceId || '') === want);
  if (!want || !hit) {
    return { ok: false, code: 'UNKNOWN_CHOICE', error: 'ตัวเลือกการอนุญาตไม่ถูกต้องหรือหมดอายุแล้ว' };
  }
  return { ok: true, choice: hit };
}

/**
 * Short display rows for a landed answer set — what the resolved card and
 * the popup history show per question (labels verbatim, free text capped).
 */
export function summarizeUserInputAnswers(questions = [], answers = []) {
  const byId = new Map((Array.isArray(questions) ? questions : []).map((q) => [String(q?.id || ''), q]));
  return (Array.isArray(answers) ? answers : []).map((a) => {
    const q = byId.get(String(a?.questionId || ''));
    const head = q?.header || q?.question || String(a?.questionId || '');
    let display = '';
    if (typeof a?.selectedLabel === 'string') display = a.selectedLabel;
    else if (Array.isArray(a?.selectedLabels)) display = a.selectedLabels.join(', ');
    else if (typeof a?.freeText === 'string') display = a.freeText;
    return { questionId: String(a?.questionId || ''), header: head, display: oneLine(display, 160) };
  });
}

/**
 * Stable stringify for submission idempotency keys: key order cannot flip
 * the key, or an identical retry would look conflicting. Keys/values only
 * (no functions, no undefined holes) — answers are JSON by construction.
 */
export function submissionKey(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().map((k) => [k, norm(v[k])]);
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/**
 * Sort a point-in-time `approval/listPending` userInputs snapshot into what
 * the recovery poll must do (BUG-084): chat f381a7e1 held a prompt for 2h
 * with no card and no trace — its auto-cancel was rejected
 * (`missing field 'reason'`) and swallowed silently — so the watchdog
 * re-reads pending prompts and acts: mount what the form UI can answer
 * (every well-formed shape since 1.1.33), cancel the malformed remainder,
 * and escalate what we already cancelled but the agent still holds past
 * grace.
 *
 * Pure: `pending` is the raw userInputs array, `knownIds` the mounted card
 * ids, `cancelledAt` id → cancel-timestamp ms. Repeats and id-less entries
 * are dropped. A mounted card is the human's to answer — never re-driven.
 */
export function classifyPendingUserInputs({
  pending = [],
  knownIds = new Set(),
  cancelledAt = new Map(),
  now = Date.now(),
  graceMs = 30_000,
} = {}) {
  const mount = [];
  const cancel = [];
  const escalate = [];
  const seen = new Set();
  for (const p of pending) {
    const id = String(p?.userInputId || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (knownIds.has(id)) continue;
    const cancelledTs = cancelledAt.get(id);
    if (cancelledTs != null) {
      if (now - cancelledTs >= graceMs) {
        escalate.push({
          userInputId: id,
          waitedMs: now - cancelledTs,
          questions: Array.isArray(p?.questions) ? p.questions : [],
        });
      }
      continue;
    }
    if (mspUserInputCard(p)) mount.push(p);
    else cancel.push(p);
  }
  return { mount, cancel, escalate };
}
