#!/usr/bin/env node
// Renderer transcript → Markdown serializer invariants
// (src/renderer/transcript-markdown.js — pure).
//
// The rule these tests protect: the clipboard copy mirrors the transcript —
// user/assistant sections in order, tool rows as fenced blocks (fences that
// survive backticks in the output), notices as quotes — and never throws on
// partial/degenerate message shapes.

import assert from 'node:assert/strict';

import { chatToMarkdown } from '../src/renderer/transcript-markdown.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('header carries the title and a short session id', () => {
  const md = chatToMarkdown({ title: 'ทดสอบ', id: 'abcdef123456', messages: [] });
  assert.match(md, /^# ทดสอบ\n/);
  assert.match(md, /session: `abcdef12`/);
  assert.match(md, /_ไม่มีข้อความ_/);
});

test('user and assistant messages become sections in order', () => {
  const md = chatToMarkdown({
    title: 't',
    messages: [
      { role: 'user', text: 'ถามหน่อย' },
      { role: 'assistant', text: 'ตอบแบบ **มาร์กดาวน์**' },
      { role: 'user', text: 'ถามต่อ' },
    ],
  });
  const q1 = md.indexOf('## คำถาม\nถามหน่อย');
  const a1 = md.indexOf('## คำตอบ\nตอบแบบ **มาร์กดาวน์**');
  const q2 = md.indexOf('## คำถาม\nถามต่อ');
  assert.ok(q1 > -1 && a1 > q1 && q2 > a1, 'sections must keep transcript order');
});

test('tool rows render as labelled fenced blocks with Thai status', () => {
  const md = chatToMarkdown({
    title: 't',
    messages: [
      {
        role: 'assistant',
        text: 'ผลลัพธ์',
        meta: {
          toolCalls: [
            { id: 't1', kind: 'execute', title: 'npm test', status: 'completed', output: 'all green' },
          ],
        },
      },
    ],
  });
  assert.match(md, /\*\*🔧 npm test — เสร็จแล้ว\*\*/);
  assert.match(md, /```\nall green\n```/);
});

test('a tool output containing backticks gets a longer fence', () => {
  const md = chatToMarkdown({
    title: 't',
    messages: [
      {
        role: 'assistant',
        text: '',
        meta: {
          toolCalls: [{ id: 't1', title: 'x', status: 'failed', output: 'has ``` inside' }],
        },
      },
    ],
  });
  assert.match(md, /````\nhas ``` inside\n````/, 'fence must outrun the content');
});

test('copied tool rows name the topic, not the old prefixed title', () => {
  const md = chatToMarkdown({
    title: 't',
    messages: [
      {
        role: 'assistant',
        text: '',
        meta: {
          toolCalls: [
            { id: 't1', title: 'Bash ls /tmp/mock', kind: 'Bash', status: 'completed', output: '' },
            { id: 't2', title: 'ตรวจไฟล์ชั่วคราว', kind: 'Bash', status: 'completed', output: '' },
          ],
        },
      },
    ],
  });
  assert.match(md, /\*\*🔧 ls \/tmp\/mock — เสร็จแล้ว\*\*/);
  assert.match(md, /\*\*🔧 ตรวจไฟล์ชั่วคราว — เสร็จแล้ว\*\*/);
});

test('notices become quotes; unknown roles are skipped', () => {
  const md = chatToMarkdown({
    title: 't',
    messages: [
      { role: 'notice', text: 'เทิร์นจบแบบไม่สำเร็จ' },
      { role: 'mystery', text: 'nope' },
    ],
  });
  assert.match(md, /> เทิร์นจบแบบไม่สำเร็จ/);
  assert.doesNotMatch(md, /nope/);
});

test('degenerate inputs never throw', () => {
  assert.match(chatToMarkdown(null), /^# แชท/);
  assert.match(chatToMarkdown({}), /^# แชท/);
  assert.match(chatToMarkdown({ title: '  ', messages: 'junk' }), /_ไม่มีข้อความ_/);
  // Missing meta / null fields survive.
  const md = chatToMarkdown({
    messages: [{ role: 'assistant' }, { role: 'user', text: null }],
  });
  assert.match(md, /## คำตอบ/);
  assert.match(md, /## คำถาม/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(`transcript-markdown: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
