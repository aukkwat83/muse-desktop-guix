// Serialize a chat's persisted messages to a Markdown clipboard copy
// (BUG-054), modelled on grok-desktop's buildSessionMarkdownCopy
// (teams-format.js:546-566). grok's Teams/HTML variant is grok-specific and
// deliberately not ported. Pure — unit-testable in Node.

import { toolStatusLabel, toolTopic } from './turn-view.js?v=0.4.23';

/** A fence that can hold `text` even when it contains backtick runs. */
function fenceFor(text) {
  let max = 0;
  for (const m of String(text).matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return '`'.repeat(Math.max(3, max + 1));
}

/**
 * @param {{ title?: string, id?: string, messages?: Array<object> }} chat
 * @returns {string} Markdown: user/assistant sections, tool rows as fenced
 *   blocks, notices as quotes.
 */
export function chatToMarkdown(chat) {
  const title = String(chat?.title || 'แชท').trim() || 'แชท';
  const bits = [`# ${title}`];
  const id = chat?.id ? String(chat.id).slice(0, 8) : '';
  if (id) bits.push(`session: \`${id}\``, '');

  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  if (!messages.length) {
    bits.push('_ไม่มีข้อความ_');
    return bits.join('\n');
  }

  for (const msg of messages) {
    if (msg?.role === 'user') {
      bits.push('## คำถาม', String(msg.text ?? ''), '');
      continue;
    }
    if (msg?.role === 'notice') {
      bits.push(`> ${String(msg.text ?? '')}`, '');
      continue;
    }
    if (msg?.role !== 'assistant') continue;

    bits.push('## คำตอบ');
    for (const tool of msg.meta?.toolCalls || []) {
      const name = String(toolTopic(tool) || tool.kind || 'tool');
      bits.push(`**🔧 ${name} — ${toolStatusLabel(tool.status)}**`, '');
      const out = String(tool.output ?? '');
      if (out) {
        const fence = fenceFor(out);
        bits.push(fence, out, fence, '');
      }
    }
    const text = String(msg.text ?? '').trim();
    if (text) bits.push(text, '');
  }
  return bits.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export default chatToMarkdown;
