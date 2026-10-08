// Question inbox — the popup + queue behind agent questions (1.1.33).
//
// The transcript card stays the always-visible fallback, but multi-question
// and free-text forms need room: the inbox is a non-modal anchored panel
// (popover.js) listing every unanswered interaction — asks first, oldest
// first — with the selected one rendered as a full form. Design rules:
//
// - Never steals focus on auto-surface: the composer keeps focus, caret
//   and draft; focus moves only on explicit user action, and closing
//   returns focus to whatever held it before.
// - Drafts live outside the DOM (per-ixId store, sessionStorage-backed),
//   so close/reopen, SSE updates, chat switches, retries and reloads can
//   never eat typed-but-unsent answers. Cleared only on resolved.
// - Submit/cancel go through the same ACK-safe POST the cards use; the
//   form paints resolved from SSE, never from the HTTP body.
//
// Pure core (draft store, answer collection, ordering) has no top-level
// DOM touch and is covered from Node; the builders need a document.

import { iconElement } from './icons.js?v=1.0.0';

/** Schema ceiling for freeText/note (binary 1.4.3 UserInputAnswer). */
export const INBOX_TEXT_MAX = 500;

const STORAGE_PREFIX = 'md.qDraft.';

/**
 * Per-question answer drafts keyed by interaction id. Values are plain
 * objects { [questionId]: { selectedLabel?, selectedLabels?, freeText?,
 * note? } }, mirrored as JSON under md.qDraft.<ixId> so a reload cannot
 * eat them (same shape as composer-draft.js, object-valued).
 */
export function createQuestionDraftStore(opts = {}) {
  const byIx = new Map();
  const persist = opts.persist !== false;
  const storage =
    opts.storage !== undefined
      ? opts.storage
      : typeof sessionStorage !== 'undefined'
        ? sessionStorage
        : null;

  const key = (ixId) => STORAGE_PREFIX + String(ixId || '');

  function read(ixId) {
    const id = String(ixId || '');
    if (!id) return {};
    if (byIx.has(id)) return byIx.get(id) || {};
    if (persist && storage) {
      try {
        const raw = storage.getItem(key(id));
        if (raw != null) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            byIx.set(id, parsed.values || {});
            return byIx.get(id);
          }
        }
      } catch {
        /* corrupt / private mode — memory-only */
      }
    }
    return {};
  }

  function write(ixId, values) {
    const id = String(ixId || '');
    if (!id) return;
    byIx.set(id, values || {});
    if (persist && storage) {
      try {
        if (values && Object.keys(values).length) {
          storage.setItem(key(id), JSON.stringify({ values, updatedAt: Date.now() }));
        } else {
          storage.removeItem(key(id));
        }
      } catch {
        /* ignore */
      }
    }
  }

  return {
    /** All drafted values for one interaction ({} when none). */
    get(ixId) {
      return { ...read(ixId) };
    },
    /** Merge one question's partial values into the draft. */
    setQuestion(ixId, questionId, patch) {
      const values = { ...read(ixId) };
      const qid = String(questionId || '');
      if (!qid) return;
      values[qid] = { ...(values[qid] || {}), ...(patch || {}) };
      write(ixId, values);
    },
    /** Replace the whole draft (form reset paths). */
    setAll(ixId, values) {
      write(ixId, { ...(values || {}) });
    },
    /** Drop the draft — only on resolved, never on close/retry. */
    clear(ixId) {
      const id = String(ixId || '');
      if (!id) return;
      byIx.delete(id);
      if (persist && storage) {
        try {
          storage.removeItem(key(id));
        } catch {
          /* ignore */
        }
      }
    },
    has(ixId) {
      const id = String(ixId || '');
      if (!id) return false;
      if (byIx.has(id)) return Object.keys(byIx.get(id) || {}).length > 0;
      if (persist && storage) {
        try {
          return storage.getItem(key(id)) != null;
        } catch {
          return false;
        }
      }
      return false;
    },
  };
}

/**
 * Collect a draft into a submittable answers array — the client-side
 * mirror of the server validator (same rules, same Thai errors, so the
 * form refuses before the POST does). Atomic like the server: one bad
 * entry fails the whole set. Labels compare exactly (they are wire ids);
 * bounds are used as validated (min:0 allows an empty multi-pick); and
 * freeText answers ANY question via the Other row (schema: independent
 * alternative, no allowOther gate).
 */
export function draftToAnswers(questions = [], values = {}) {
  const qs = Array.isArray(questions) ? questions : [];
  const vals = values && typeof values === 'object' ? values : {};
  if (!qs.length) return { ok: false, code: 'NO_QUESTIONS', error: 'คำถามหมดอายุหรือไม่ถูกต้อง' };
  const answers = [];
  for (const q of qs) {
    const qid = String(q?.id ?? '');
    const head = q?.header || q?.question || qid;
    const v = vals[qid] || {};
    const note = v.note == null || String(v.note) === '' ? undefined : String(v.note);
    if (note !== undefined && note.length > INBOX_TEXT_MAX) {
      return { ok: false, code: 'NOTE_TOO_LONG', questionId: qid, error: `โน้ตของ “${head}” ยาวเกิน ${INBOX_TEXT_MAX} ตัวอักษร` };
    }
    const entry = { questionId: qid, ...(note !== undefined ? { note } : {}) };
    const text = typeof v.freeText === 'string' ? v.freeText.trim() : '';
    if (v.other || q.freeText) {
      // Other/text answer (or a natively free-text question): text required.
      if (!text) {
        return {
          ok: false, code: 'ANSWER_SHAPE', questionId: qid,
          error: v.other && !q.freeText ? `“${head}” เลือก “อื่นๆ” แล้วต้องพิมพ์คำตอบ` : `“${head}” ต้องพิมพ์คำตอบ`,
        };
      }
      if (text.length > INBOX_TEXT_MAX) {
        return { ok: false, code: 'TEXT_TOO_LONG', questionId: qid, error: `คำตอบของ “${head}” ยาวเกิน ${INBOX_TEXT_MAX} ตัวอักษร` };
      }
      entry.freeText = text;
    } else if (q.mode === 'multiple') {
      const picks = [...new Set((Array.isArray(v.selectedLabels) ? v.selectedLabels : []).map((s) => String(s)).filter((s) => s.trim() !== ''))];
      const min = q.minSelections ?? 1;
      const max = q.maxSelections ?? (q.options || []).length;
      const known = new Set((q.options || []).map((o) => o.label));
      if (picks.length < min || picks.length > max || picks.some((p) => !known.has(p))) {
        return {
          ok: false, code: 'SELECTION_BOUNDS', questionId: qid,
          error: min === max ? `“${head}” ต้องเลือก ${min} ข้อ` : `“${head}” ต้องเลือก ${min}–${max} ข้อ`,
        };
      }
      entry.selectedLabels = picks;
    } else {
      const label = typeof v.selectedLabel === 'string' ? v.selectedLabel : '';
      const known = new Set((q.options || []).map((o) => o.label));
      if (!known.has(label)) {
        return { ok: false, code: 'UNKNOWN_LABEL', questionId: qid, error: `“${head}” ต้องเลือก 1 ข้อ` };
      }
      entry.selectedLabel = label;
    }
    answers.push(entry);
  }
  return { ok: true, answers };
}

/** Answered/total count for the submit button label. */
export function draftCompleteness(questions = [], values = {}) {
  const qs = Array.isArray(questions) ? questions : [];
  const vals = values && typeof values === 'object' ? values : {};
  const hasText = (v) => typeof v.freeText === 'string' && v.freeText.trim() !== '';
  let done = 0;
  for (const q of qs) {
    const v = vals[String(q?.id ?? '')] || {};
    if (v.other || q.freeText) {
      if (hasText(v)) done++;
    } else if (q.mode === 'multiple') {
      const min = q.minSelections ?? 1;
      const n = Array.isArray(v.selectedLabels) ? v.selectedLabels.filter((s) => String(s).trim() !== '').length : 0;
      if (n >= min) done++;
    } else if (typeof v.selectedLabel === 'string' && v.selectedLabel.trim() !== '') {
      done++;
    }
  }
  return { done, total: qs.length };
}

/**
 * Route-receipt verdict for one shell tap route: may the page confirm it
 * (clearing the shell's retained queue), or must the route survive?
 *
 * - `applied`: the inbox opened ON the routed question — confirm.
 * - `moot`: the question is authoritatively gone — a locally SEEN
 *   resolve (tombstone) or a successful FRESH server lookup that no
 *   longer lists it. A merely empty local list is NOT gone: a failed
 *   boot GET or chat fetch also yields [], and confirming that would
 *   discard a live route. Only positive applied/moot clears the queue.
 * - `retain`: still pending server-side, or the lookup failed transport
 *   (bounded retries, then quiet — the shell re-flushes on later page
 *   events; never a rapid poll, never pretend-applied).
 * - `none`: no route was pending.
 *
 * `lookupAbsent` resolves true when fresh server truth lacks the id and
 * REJECTS on transport failure (those are different answers).
 */
export async function routeReceiptVerdict({
  selectedId = null,
  route = null,
  hasTombstone = false,
  lookupAbsent = null,
  maxAttempts = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  // Local aliases: the no-undef contract tracks const/let bindings, not
  // destructured-parameter callees with nested-paren defaults.
  const lookup = lookupAbsent;
  const wait = sleep;
  if (!route?.ixId) return 'none';
  if (selectedId === route.ixId) return 'applied';
  if (hasTombstone) return 'moot';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      if (await lookup()) return 'moot';
      return 'retain';
    } catch {
      if (attempt + 1 < maxAttempts) await wait(1500 * (attempt + 1));
    }
  }
  return 'retain';
}

/**
 * Does a tap route need hydration before it can open? TRUE unless the
 * question is already local AND its chat is the loaded one. Deliberately
 * NOT a function of activeId: selectChat sets activeId BEFORE its
 * awaited GET, so a failed first fetch leaves activeId set with nothing
 * loaded — skipping hydration on activeId-match strands retried taps
 * forever (the same-active-ID retry trap).
 */
export function routeHydrationNeeded({ chatId = '', loadedChatId = null, ixPresent = false } = {}) {
  if (ixPresent && (!chatId || loadedChatId === chatId)) return false;
  return true;
}

/**
 * Apply one shell tap route: hydrate the target chat when needed
 * (guarded select — safe to re-run on retries), then open the exact
 * form. A failed select still falls through to open: the receipt
 * verifier retains the route and its bounded lookup can recover once
 * the server is healthy again. `isCurrent` guards route identity after
 * the await — a stale route never paints over a newer tap.
 * Returns 'opened', 'stale', or 'none'. Never throws for transport.
 */
export async function applyQuestionRoute({
  route = null,
  loadedChatId = null,
  ixPresent = false,
  selectChatFn = null,
  openFn = null,
  isCurrent = null,
} = {}) {
  if (!route?.ixId) return 'none';
  const current = typeof isCurrent === 'function' ? isCurrent : () => true;
  if (routeHydrationNeeded({ chatId: route.chatId, loadedChatId, ixPresent })) {
    try {
      await selectChatFn(route.chatId);
    } catch {
      /* fall through to open — the verifier retains on failure */
    }
    if (!current()) return 'stale';
  } else if (!current()) {
    return 'stale';
  }
  openFn(route.ixId);
  return 'opened';
}

/**
 * Inbox queue order: questions before approvals (a question blocks on
 * knowledge only the human has; an approval can wait its turn), oldest
 * first inside each group — first asked, first served.
 */
export function orderInboxItems(items = []) {
  const rank = (ix) => (ix?.subtype === 'ask' ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || (a?.ts || 0) - (b?.ts || 0));
}

// ------------------------------------------------------------ DOM builders
// Every agent string lands via textContent — never innerHTML. Icons come
// from the closed registry. All DOM lives behind these builders so app.js
// owns state/events and never hand-builds form markup.

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function icon(name, cls = 'ico ico-sm') {
  return iconElement(name, cls) || document.createElement('span');
}

/** Queue row: which chat asked, and the gist of what it needs. */
function inboxItemNode(ix, chatTitle, selected, onSelect) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `qinbox-item${selected ? ' selected' : ''}`;
  b.dataset.ixId = ix.id;
  const dot = el('span', `qinbox-dot${ix.subtype === 'ask' ? ' ask' : ' approval'}`);
  dot.setAttribute('aria-hidden', 'true');
  const main = el('span', 'qinbox-item-main');
  main.append(el('span', 'qinbox-item-chat', chatTitle || 'แชท'));
  main.append(el('span', 'qinbox-item-sum', ix.summary || (ix.subtype === 'ask' ? 'agent มีคำถาม' : 'รอการอนุญาต')));
  b.append(dot, main);
  b.append(icon('chevRight'));
  b.addEventListener('click', () => onSelect(ix.id));
  return b;
}

/** Rebuild the queue list only — the form (and its caret) is untouched. */
export function updateInboxList(panel, items = [], selectedId = null, chatTitleOf = null, onSelect = null) {
  const list = panel?.querySelector?.(':scope > .qinbox-body > .qinbox-queue');
  if (!list) return;
  list.replaceChildren();
  const ordered = orderInboxItems(items);
  if (!ordered.length) {
    list.append(el('div', 'qinbox-empty', 'ไม่มีคำถามค้างอยู่'));
    return;
  }
  for (const ix of ordered) {
    list.append(inboxItemNode(ix, chatTitleOf?.(ix.chatId) || 'แชท', ix.id === selectedId, (id) => onSelect?.(id)));
  }
  const head = panel.querySelector(':scope > .qinbox-head > .qinbox-count');
  if (head) head.textContent = `(${ordered.length})`;
}

function optionRow(ixId, q, opt, checked, multi, onPick, collect = null) {
  const label = el('label', 'qform-opt');
  const input = document.createElement('input');
  input.type = multi ? 'checkbox' : 'radio';
  input.name = `q-${ixId}-${q.id}`;
  input.value = opt.label;
  if (checked) input.checked = true;
  input.addEventListener('change', () => onPick(opt.label, input.checked));
  const text = el('span', 'qform-opt-text', opt.label);
  label.append(input, text);
  if (opt.description) label.append(el('span', 'qform-opt-desc', opt.description));
  if (collect) collect.push(input); // Other-unchecks-options needs the live inputs
  return label;
}

/**
 * The “other, type your own” row under every choice question. The MSP
 * schema allows freeText as an independent answer alternative for any
 * question (no allowOther gate), so choice questions get it too — picks
 * and typed text are mutually exclusive in the draft (last writer wins),
 * while both halves of the draft survive for toggling back.
 */
function otherRow(ixId, q, value, multi, cbs, hooks = {}) {
  const frag = document.createDocumentFragment();
  const row = el('label', 'qform-opt qform-other');
  const input = document.createElement('input');
  input.type = multi ? 'checkbox' : 'radio';
  input.name = `q-${ixId}-${q.id}`;
  input.value = '__other__';
  if (value.other) input.checked = true;
  input.addEventListener('change', () => {
    if (input.checked) hooks.onOtherSelect?.();
    cbs.onDraft(ixId, q.id, input.checked ? { other: true, selectedLabels: [] } : { other: false });
    cbs.onEngage(ixId);
  });
  row.append(input, el('span', 'qform-opt-text', 'อื่นๆ… (พิมพ์เอง)'));
  frag.append(row);
  const ta = document.createElement('textarea');
  ta.className = 'qform-text qform-other-text';
  ta.rows = 2;
  ta.placeholder = 'พิมพ์คำตอบเอง…';
  ta.maxLength = INBOX_TEXT_MAX;
  ta.value = typeof value.freeText === 'string' ? value.freeText : '';
  ta.setAttribute('aria-label', 'คำตอบอื่นๆ');
  ta.addEventListener('input', () => {
    input.checked = true; // typing selects Other for this question
    hooks.onOtherSelect?.();
    cbs.onDraft(ixId, q.id, { freeText: ta.value, other: true, selectedLabels: [] });
    cbs.onEngage(ixId);
  });
  ta.addEventListener('focus', () => cbs.onEngage(ixId), { once: true });
  frag.append(ta);
  return { node: frag, input, ta };
}

function questionNode(ixId, q, value, cbs) {
  const wrap = el('div', 'qform-q');
  wrap.dataset.qid = q.id;
  if (q.header) wrap.append(el('div', 'qform-qhead', q.header));
  if (q.question && q.question !== q.header) wrap.append(el('div', 'qform-qtext', q.question));
  if (q.freeText) {
    const ta = document.createElement('textarea');
    ta.className = 'qform-text';
    ta.rows = 2;
    ta.placeholder = 'พิมพ์คำตอบ…';
    ta.maxLength = INBOX_TEXT_MAX;
    ta.value = typeof value.freeText === 'string' ? value.freeText : '';
    ta.setAttribute('aria-label', q.header || q.question || 'คำตอบ');
    ta.addEventListener('input', () => {
      cbs.onDraft(ixId, q.id, { freeText: ta.value });
      cbs.onEngage(ixId);
    });
    ta.addEventListener('focus', () => cbs.onEngage(ixId), { once: true });
    wrap.append(ta);
  } else if (q.mode === 'multiple') {
    // LIVE mirror of the draft picks: every change handler mutates THIS
    // set, so consecutive clicks accumulate. Deriving each update from a
    // set captured once at build forks state — the DOM shows [x, y] while
    // the POST carries only [y] (real browser P1: the second handler
    // re-read the stale build-time set).
    const picked = new Set(Array.isArray(value.selectedLabels) ? value.selectedLabels : []);
    const box = el('div', 'qform-opts');
    const hint = q.minSelections === q.maxSelections
      ? `เลือก ${q.minSelections} ข้อ`
      : `เลือก ${q.minSelections}–${q.maxSelections} ข้อ`;
    box.append(el('div', 'qform-hint', hint));
    const optInputs = [];
    // `other` fills below; pick handlers run only on user clicks, long
    // after the branch built — the forward reference is safe.
    let other = null;
    for (const opt of q.options || []) {
      box.append(optionRow(ixId, q, opt, picked.has(opt.label) && !value.other, true, (labelText, on) => {
        if (on) picked.add(labelText);
        else picked.delete(labelText);
        if (other) other.input.checked = false; // a pick un-selects Other, DOM included
        cbs.onDraft(ixId, q.id, { selectedLabels: [...picked], other: false });
        cbs.onEngage(ixId);
      }, optInputs));
    }
    other = otherRow(ixId, q, value, true, cbs, {
      onOtherSelect: () => {
        picked.clear();
        for (const i of optInputs) i.checked = false;
      },
    });
    box.append(other.node);
    wrap.append(box);
  } else {
    const box = el('div', 'qform-opts');
    let other = null;
    for (const opt of q.options || []) {
      box.append(optionRow(ixId, q, opt, value.selectedLabel === opt.label && !value.other, false, (labelText) => {
        if (other) other.input.checked = false;
        cbs.onDraft(ixId, q.id, { selectedLabel: labelText, other: false });
        cbs.onEngage(ixId);
      }));
    }
    other = otherRow(ixId, q, value, false, cbs);
    box.append(other.node);
    wrap.append(box);
  }
  const note = document.createElement('input');
  note.type = 'text';
  note.className = 'qform-note';
  note.placeholder = 'โน้ตเพิ่มเติม (ไม่บังคับ)';
  note.maxLength = INBOX_TEXT_MAX;
  note.value = typeof value.note === 'string' ? value.note : '';
  note.setAttribute('aria-label', 'โน้ตเพิ่มเติม');
  note.addEventListener('input', () => cbs.onDraft(ixId, q.id, { note: note.value }));
  wrap.append(note);
  return wrap;
}

/** Full form for one ask interaction: every question + submit/cancel. */
export function buildQuestionForm(ix, values = {}, submit = null, cbs = {}) {
  const form = el('div', 'qform');
  form.dataset.ixId = ix.id;
  const questions = Array.isArray(ix.questions) ? ix.questions : [];
  for (const q of questions) {
    form.append(questionNode(ix.id, q, values[String(q?.id || '')] || {}, cbs));
  }
  const foot = el('div', 'qform-foot');
  const err = el('div', 'qform-err', submit?.error || '');
  err.setAttribute('role', 'alert');
  err.hidden = !submit?.error;
  foot.append(err);
  const actions = el('div', 'qform-actions');
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'btn primary qform-send';
  const { done, total } = draftCompleteness(questions, values);
  send.textContent = total > 1 ? `ส่งคำตอบ (${done}/${total})` : 'ส่งคำตอบ';
  send.disabled = !!submit?.submitting;
  if (submit?.submitting) {
    send.replaceChildren();
    send.append(icon('refresh', 'ico ico-sm spin'), document.createTextNode('กำลังส่ง…'));
  }
  send.addEventListener('click', () => cbs.onSubmit?.(ix.id));
  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'btn ghost qform-skip';
  skip.textContent = 'ข้ามคำถามนี้';
  skip.title = 'ยกเลิกคำถาม — agent จะตอบต่อเองโดยไม่มีคำตอบ';
  skip.disabled = !!submit?.submitting;
  skip.addEventListener('click', () => cbs.onCancel?.(ix.id));
  actions.append(send, skip);
  foot.append(actions);
  form.append(foot);
  return form;
}

/** Compact approval surface inside the inbox (options + submit state). */
export function buildApprovalMini(ix, submit = null, cbs = {}) {
  const wrap = el('div', 'qform-ap');
  wrap.dataset.ixId = ix.id;
  wrap.append(el('div', 'qform-qhead', `ขออนุญาตใช้ ${ix.toolName || 'tool'}`));
  if (ix.body) wrap.append(el('div', 'qform-qtext', ix.body.slice(0, 2000)));
  else if (ix.summary) wrap.append(el('div', 'qform-qtext', ix.summary));
  const err = el('div', 'qform-err', submit?.error || '');
  err.setAttribute('role', 'alert');
  err.hidden = !submit?.error;
  wrap.append(err);
  const actions = el('div', 'qform-actions');
  for (const opt of ix.options || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = opt.name || opt.optionId;
    b.disabled = !!submit?.submitting;
    b.addEventListener('click', () => cbs.onApprove?.(ix.id, opt.optionId));
    actions.append(b);
  }
  if (submit?.submitting) {
    const spin = el('span', 'qform-sending', 'กำลังส่ง…');
    spin.prepend(icon('refresh', 'ico ico-sm spin'));
    actions.append(spin);
  }
  wrap.append(actions);
  return wrap;
}

/**
 * The panel root. `items` are unresolved interactions across chats
 * ({...ix, chatId}); `selected` is the interaction under the form (or
 * null for the empty state). Callbacks: onSelect/onDraft/onSubmit/
 * onCancel/onApprove/onEngage/onClose.
 */
export function buildInboxPanel({ items = [], selected = null, values = {}, submit = null, chatTitleOf = null, cbs = {} } = {}) {
  const panel = el('div', 'qinbox');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'คำถามจาก Muse');
  const head = el('div', 'qinbox-head');
  head.append(icon('alert'));
  head.append(el('span', 'qinbox-title', 'คำถามจาก Muse'));
  head.append(el('span', 'qinbox-count', `(${items.length})`));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn ghost qinbox-close';
  close.title = 'เลื่อนไปก่อน (Esc) — คำถามยังค้างอยู่ เปิดใหม่ได้จากปุ่มกระดิ่ง';
  close.setAttribute('aria-label', 'เลื่อนไปก่อน');
  close.append(icon('x'));
  close.addEventListener('click', () => cbs.onClose?.());
  head.append(close);
  panel.append(head);
  const body = el('div', 'qinbox-body');
  const queue = el('div', 'qinbox-queue');
  queue.setAttribute('role', 'listbox');
  queue.setAttribute('aria-label', 'คำถามที่รอคำตอบ');
  body.append(queue);
  const formWrap = el('div', 'qinbox-form');
  if (!items.length) {
    formWrap.append(el('div', 'qinbox-empty', 'ไม่มีคำถามค้างอยู่ — agent ทำงานต่อได้เลย'));
  } else if (selected?.subtype === 'ask') {
    formWrap.append(buildQuestionForm(selected, values, submit, cbs));
  } else if (selected) {
    formWrap.append(buildApprovalMini(selected, submit, cbs));
  }
  body.append(formWrap);
  panel.append(body);
  updateInboxList(panel, items, selected?.id || null, chatTitleOf, (id) => cbs.onSelect?.(id));
  return panel;
}

/**
 * Repaint the selected form's footer in place (submitting spinner, error
 * line, completeness count) WITHOUT rebuilding the inputs — a rebuild
 * mid-keystroke would drop the caret and the half-typed value's focus.
 * Falls back to a form rebuild when the footer is missing.
 */
export function updateInboxSubmit(panel, ix, values = {}, submit = null, cbs = {}) {
  const formWrap = panel?.querySelector?.(':scope > .qinbox-body > .qinbox-form');
  if (!formWrap) return;
  const current = formWrap.firstElementChild;
  const sameForm = current?.dataset?.ixId === ix?.id;
  // Approval minis and missing forms rebuild wholesale (no text caret at
  // stake); question forms repaint the footer only.
  if (!sameForm || ix?.subtype !== 'ask') {
    formWrap.replaceChildren();
    if (ix?.subtype === 'ask') {
      const built = buildQuestionForm(ix, values, submit, cbs);
      if (submit?.submitting) {
        for (const field of built.querySelectorAll('input, textarea, select')) field.disabled = true;
      }
      formWrap.append(built);
    } else if (ix) formWrap.append(buildApprovalMini(ix, submit, cbs));
    else formWrap.append(el('div', 'qinbox-empty', 'ไม่มีคำถามค้างอยู่ — agent ทำงานต่อได้เลย'));
    return;
  }
  const err = current.querySelector(':scope > .qform-foot > .qform-err');
  if (err) {
    err.textContent = submit?.error || '';
    err.hidden = !submit?.error;
  }
  const send = current.querySelector(':scope > .qform-foot .qform-send');
  if (send) {
    send.disabled = !!submit?.submitting;
    if (submit?.submitting) {
      send.replaceChildren();
      send.append(icon('refresh', 'ico ico-sm spin'), document.createTextNode('กำลังส่ง…'));
    } else {
      const { done, total } = draftCompleteness(ix.questions || [], values);
      send.textContent = total > 1 ? `ส่งคำตอบ (${done}/${total})` : 'ส่งคำตอบ';
    }
  }
  const skip = current.querySelector(':scope > .qform-foot .qform-skip');
  if (skip) skip.disabled = !!submit?.submitting;
  // While a submit is in flight the form is read-only: input typed during
  // the flight would silently miss the POST body. Drafts are untouched,
  // so a failure re-enables with everything still there.
  for (const field of current.querySelectorAll('input, textarea, select')) {
    field.disabled = !!submit?.submitting;
  }
}

/** Capture the caret-bearing field inside the form (for rebuild restore). */
export function captureFormFocus(panel) {
  const active = document.activeElement;
  const form = panel?.querySelector?.(':scope > .qinbox-body > .qinbox-form');
  if (!active || !form || !form.contains(active)) return null;
  const qWrap = active.closest?.('[data-qid]');
  if (!qWrap) return null;
  let field = null;
  if (active.classList?.contains('qform-text')) field = 'text';
  else if (active.classList?.contains('qform-note')) field = 'note';
  else return null;
  let start = null;
  let end = null;
  try {
    start = active.selectionStart;
    end = active.selectionEnd;
  } catch {
    /* not selectable */
  }
  return { qid: qWrap.dataset.qid, field, start, end };
}

/** Restore a captured caret after a form rebuild (no-op when stale). */
export function restoreFormFocus(panel, cap) {
  if (!cap) return false;
  const form = panel?.querySelector?.(':scope > .qinbox-body > .qinbox-form');
  const qWrap = form?.querySelector?.(`[data-qid="${CSS.escape(cap.qid)}"]`);
  const target = qWrap?.querySelector?.(cap.field === 'note' ? '.qform-note' : '.qform-text');
  if (!target || !target.focus) return false;
  try {
    target.focus({ preventScroll: true });
  } catch {
    try {
      target.focus();
    } catch {
      return false;
    }
  }
  if (cap.start != null && cap.end != null && target.setSelectionRange) {
    try {
      target.setSelectionRange(cap.start, cap.end);
    } catch {
      /* ignore */
    }
  }
  return true;
}
