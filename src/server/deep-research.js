// Deep Research wire harness (v1.1.39).
//
// Muse has no `/deep-research` skill — that harness is bundled into
// the Muse binary — so the desktop supplies the equivalent
// instructions on the wire itself. The preamble rides `turn/start` only:
// the stored user message stays the user's verbatim topic (same contract
// as the session-recovery preamble in sessions.js), so the transcript,
// search index and queue UI never fill up with harness text.

export const DEEP_RESEARCH_MARKER = '[DEEP RESEARCH — Muse Desktop]';

const HARNESS_LINES = [
  DEEP_RESEARCH_MARKER,
  'The user toggled Deep Research on in Muse Desktop. Do not answer',
  'from memory or from a single search — run a deep, multi-source,',
  'fact-checked research pass, then synthesize a cited report.',
  '',
  '1. Scope: if the question below is underspecified for research',
  '   (missing budget, region, use case, timeframe or similar), ask',
  '   2-3 clarifying questions first and stop. Otherwise proceed.',
  '2. Fan-out inline, in THIS turn: decompose the question into',
  '   sub-questions and research each one yourself with web_search /',
  '   web_fetch (parallel tool calls where independent). Do NOT use',
  '   the Workflow tool and do NOT spawn subagents: over this desktop',
  '   session a launched workflow runs in the background and its',
  '   result never reaches the transcript, stranding the user with',
  '   an empty turn (observed live, v1.1.39 E2E). Prefer primary',
  '   sources and fetch the full pages, not just search snippets.',
  '3. Adversarially verify: for every load-bearing claim, try to',
  '   refute it and cross-check it against at least two independent',
  '   sources. Note where sources disagree instead of silently',
  '   picking one.',
  '4. Report in THIS turn: answer in the language of the question.',
  '   Lead with the conclusion, then findings with a citation (source',
  '   link) on every load-bearing claim, a short disagreements/gaps',
  '   section, and the date each key source was published or accessed.',
  '   Mark anything you could not verify as unverified. This turn must',
  '   end with the full written report as your reply text — never end',
  '   the turn empty, never stop after a tool launch or a promise to',
  '   research later.',
  '',
  '## Research question',
  '',
];

/** Wire text for a deep-research turn; '' when there is no topic. */
export function buildDeepResearchWireText(body) {
  const topic = String(body ?? '').trim();
  if (!topic) return '';
  return `${HARNESS_LINES.join('\n')}${topic}`;
}

/**
 * Compose the harness onto an already-built wire text. The recovery
 * preamble puts its recap first and the topic last, so splicing the
 * harness in front of the trailing topic keeps both preambles readable
 * and the topic verbatim at the end.
 */
export function applyDeepResearchWireText(wireText, body) {
  const wire = String(wireText ?? '');
  const topic = String(body ?? '').trim();
  if (!topic) return wire;
  const deep = buildDeepResearchWireText(topic);
  if (wire === topic || wire.trim() === topic) return deep;
  if (wire.endsWith(topic)) return `${wire.slice(0, -topic.length)}${deep}`;
  return `${wire}\n\n${deep}`;
}

export function isDeepResearchWireText(text) {
  return String(text ?? '').includes(DEEP_RESEARCH_MARKER);
}

export default buildDeepResearchWireText;
