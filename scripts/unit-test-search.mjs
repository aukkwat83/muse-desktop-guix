#!/usr/bin/env node
// Cross-chat full-text search (src/server/search-index.js): query shaping,
// trigram substring recall (Thai mid-token + English), operator filters,
// find-in-chat scoping, rebuild coverage over muse chat shapes, and the
// self-healing open (corrupt db quarantines, FTS never silently disables).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SearchIndex,
  escapeLike,
  kindBoost,
  needsLikeScan,
  parseSearchQuery,
  planEntriesText,
  splitQueryTerms,
  surfaceForKind,
  toAt,
  toFtsQuery,
  turnForMessageIndex,
} from '../src/server/search-index.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpDb(name) {
  const p = path.join(os.tmpdir(), `muse-search-test-${name}-${process.pid}-${Date.now()}.sqlite`);
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${p}${s}`); } catch { /* ignore */ }
  }
  return p;
}

function cleanup(p) {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${p}${s}`); } catch { /* ignore */ }
  }
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(path.basename(p))) fs.unlinkSync(path.join(os.tmpdir(), f));
    }
  } catch { /* ignore */ }
}

// ------------------------------------------------------------ pure query

test('toFtsQuery ANDs quoted substring phrases', () => {
  assert.equal(toFtsQuery('mermaid diagram'), '"mermaid" AND "diagram"');
  assert.equal(toFtsQuery('ค้นหาไฟล์'), '"ค้นหาไฟล์"');
  assert.equal(toFtsQuery('  '), null);
  assert.equal(toFtsQuery('a"b'), '"a" AND "b"');
});

test('splitQueryTerms strips FTS metacharacters', () => {
  assert.deepEqual(splitQueryTerms('a*b (c) "d"'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitQueryTerms(''), []);
});

test('needsLikeScan flags sub-trigram terms', () => {
  assert.equal(needsLikeScan('หา'), true);
  assert.equal(needsLikeScan('ab'), true);
  assert.equal(needsLikeScan('abc'), false);
  assert.equal(needsLikeScan('ค้นหา'), false);
  assert.equal(needsLikeScan('ok ค้นหา'), true);
});

test('escapeLike neutralizes wildcards', () => {
  assert.equal(escapeLike('100%_\\'), '100\\%\\_\\\\');
});

test('parseSearchQuery peels operators', () => {
  const { free, filters } = parseSearchQuery('group:งาน kind:tool ค้นหา');
  assert.equal(free, 'ค้นหา');
  assert.equal(filters.group, 'งาน');
  assert.equal(filters.kind, 'tool');
  assert.equal(filters.isRunning, false);
  const r2 = parseSearchQuery('is:running foo');
  assert.equal(r2.filters.isRunning, true);
  assert.equal(r2.free, 'foo');
});

test('toAt normalizes epoch to ISO', () => {
  assert.equal(toAt(1726000000000), '2024-09-10T20:26:40.000Z');
  assert.equal(toAt('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(toAt(null), null);
  assert.equal(toAt('x', 'fb'), 'x');
});

test('turnForMessageIndex counts user messages', () => {
  const msgs = [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }];
  assert.equal(turnForMessageIndex(msgs, 0), 1);
  assert.equal(turnForMessageIndex(msgs, 1), 1);
  assert.equal(turnForMessageIndex(msgs, 2), 2);
  assert.equal(turnForMessageIndex([], 0), null);
});

test('surface and boost follow grok policy', () => {
  assert.equal(surfaceForKind('assistant'), 'result');
  assert.equal(surfaceForKind('tool'), 'activity');
  assert.equal(surfaceForKind('tool_out'), 'console');
  assert.equal(surfaceForKind('title'), 'session');
  assert.equal(surfaceForKind('plan'), 'meta');
  assert.ok(kindBoost('title') > kindBoost('assistant'));
  assert.ok(kindBoost('user') > kindBoost('tool_out'));
});

test('planEntriesText flattens agent shapes', () => {
  assert.equal(planEntriesText(null), '');
  assert.equal(planEntriesText([{ content: 'a' }, { title: 'b' }]), 'a\nb');
  assert.equal(planEntriesText(['x', 'y']), 'x\ny');
  assert.equal(planEntriesText('raw'), 'raw');
  assert.equal(planEntriesText([]), '');
});

// ------------------------------------------------------------ live index

function seedTwoSessions(idx) {
  const now = new Date().toISOString();
  idx.indexGroup({ id: 'g1', name: 'งานไทย', updatedAt: now }, {});
  idx.indexSessionShell(
    { id: 's1', groupId: 'g1', title: 'ระบบค้นหาไฟล์', mspSessionId: 'msp-aaa', cwd: '/tmp', model: 'm', effort: 'ultra', updatedAt: now },
    { groupName: 'งานไทย' },
  );
  idx.indexMessage('s1', 0, 'user', 'สวัสดี ระบบค้นหาไฟล์แนบ', now, 1, { groupId: 'g1' });
  idx.indexMessage('s1', 1, 'assistant', 'diagram mermaid render triforce', now, 1, { groupId: 'g1' });
  idx.indexToolItem('s1', 1, { id: 't1', kind: 'mcp__github.search', title: 'search repos', status: 'completed', output: 'found aukkwat83/muse-desktop' }, now, { groupId: 'g1', msgIndex: 1 });
  idx.indexSessionShell(
    { id: 's2', groupId: 'g1', title: 'another chat', mspSessionId: 'msp-bbb', updatedAt: now },
    { groupName: 'งานไทย' },
  );
  idx.indexMessage('s2', 0, 'user', 'another session about ระบบค้นหา', now, 1, { groupId: 'g1' });
  idx.flushNow();
}

test('substring recall: Thai mid-token across sessions', () => {
  const p = tmpDb('recall');
  const idx = new SearchIndex({ dbPath: p });
  try {
    seedTwoSessions(idx);
    const r = idx.search('ค้นหาไฟล์', {});
    assert.equal(r.ok, true);
    assert.equal(r.total, 1);
    assert.equal(r.hits[0].sessionId, 's1');
    const r2 = idx.search('ค้นหา', {});
    assert.equal(r2.total, 2);
  } finally {
    idx.close();
    cleanup(p);
  }
});

test('substring recall: English fragment + short LIKE path', () => {
  const p = tmpDb('en');
  const idx = new SearchIndex({ dbPath: p });
  try {
    seedTwoSessions(idx);
    assert.equal(idx.search('erma', {}).total, 1); // mid-token 'mermaid'
    assert.equal(idx.search('muse-desktop', {}).total, 1); // tool output
    const short = idx.search('หา', {});
    assert.equal(short.ok, true);
    assert.equal(short.total, 2); // LIKE fallback, Thai 2-char
    assert.equal(idx.search('zzz-no-such-string', {}).total, 0);
  } finally {
    idx.close();
    cleanup(p);
  }
});

test('operator filters narrow the result set', () => {
  const p = tmpDb('ops');
  const idx = new SearchIndex({ dbPath: p });
  try {
    seedTwoSessions(idx);
    assert.equal(idx.search('in:console muse-desktop', {}).total, 1);
    assert.equal(idx.search('kind:tool search', {}).total, 1);
    assert.equal(idx.search('kind:user triforce', {}).total, 0);
    assert.equal(idx.search('group:งานไทย ค้นหา', {}).total, 2);
    assert.equal(idx.search('group:nope ค้นหา', {}).total, 0);
  } finally {
    idx.close();
    cleanup(p);
  }
});

test('searchInSession is generated-only and chronological', () => {
  const p = tmpDb('find');
  const idx = new SearchIndex({ dbPath: p });
  try {
    const now = new Date().toISOString();
    idx.indexMessage('s1', 0, 'user', 'prompt about alpha token', now, 1, {});
    idx.indexMessage('s1', 1, 'assistant', 'first alpha answer', now, 1, {});
    idx.indexMessage('s1', 2, 'user', 'more alpha prompt', now, 2, {});
    idx.indexMessage('s1', 3, 'assistant', 'second alpha answer', now, 2, {});
    idx.flushNow();
    const gen = idx.searchInSession('s1', 'alpha', {});
    assert.equal(gen.ok, true);
    assert.equal(gen.generatedOnly, true);
    assert.deepEqual(gen.hits.map((h) => h.msgIndex), [1, 3]);
    const all = idx.searchInSession('s1', 'alpha', { generatedOnly: false });
    assert.deepEqual(all.hits.map((h) => h.msgIndex), [0, 1, 2, 3]);
    assert.equal(idx.searchInSession('s9', 'alpha', {}).total, 0);
  } finally {
    idx.close();
    cleanup(p);
  }
});

test('stats reports an enabled index with counts', () => {
  const p = tmpDb('stats');
  const idx = new SearchIndex({ dbPath: p });
  try {
    seedTwoSessions(idx);
    const s = idx.stats();
    assert.equal(s.enabled, true);
    assert.ok(s.chunks >= 8);
    assert.equal(s.sessions, 2);
    assert.equal(s.groups, 1);
    assert.ok(Array.isArray(s.byKind) && s.byKind.length > 0);
  } finally {
    idx.close();
    cleanup(p);
  }
});

test('rebuildAll covers muse chat shapes (tools + plan + epoch ts)', () => {
  const p = tmpDb('rebuild');
  const idx = new SearchIndex({ dbPath: p });
  try {
    const ts = Date.now();
    const chats = [
      {
        id: 'c1',
        groupId: 'g1',
        title: 'rebuild me',
        mspSessionId: 'msp-x',
        cwd: '/tmp',
        model: 'm',
        effort: 'ultra',
        createdAt: ts,
        updatedAt: ts,
        messages: [
          { id: 'm0', role: 'user', text: 'ขอ deploy ระบบใหม่', ts },
          {
            id: 'm1',
            role: 'assistant',
            text: 'deploy เสร็จแล้ว',
            ts,
            meta: {
              turnId: 't',
              toolCalls: [{ id: 'tc1', kind: 'mcp__fish.deploy', title: 'deploy prod', status: 'completed', output: 'ok replica สามตัว' }],
              plan: [{ content: 'ขั้นตอนตรวจสอบ replica' }],
            },
          },
        ],
      },
    ];
    const groups = [{ id: 'g1', name: 'Deploy Group' }];
    const r = idx.rebuildAll(chats, groups);
    assert.equal(r.ok, true);
    assert.equal(r.sessions, 1);
    // 'deploy' hits the session (message + tool) AND the group pseudo-hit.
    const dep = idx.search('deploy', {});
    assert.equal(dep.total, 2);
    assert.deepEqual(dep.hits.map((h) => h.hitType).sort(), ['group', 'session']);
    assert.equal(idx.search('replica', {}).total, 1); // tool output + plan
    assert.equal(idx.search('ขั้นตอนตรวจสอบ', {}).total, 1); // plan text
    const dim = idx.db.prepare('SELECT msp_id AS m FROM sessions_dim WHERE session_id = ?').get('c1');
    assert.equal(dim.m, 'msp-x');
  } finally {
    idx.close();
    cleanup(p);
  }
});

test('reindexSession re-sources one chat after positional drift', () => {
  const p = tmpDb('reindex');
  const idx = new SearchIndex({ dbPath: p });
  try {
    const ts = Date.now();
    const chat = {
      id: 'c1',
      groupId: 'g1',
      title: 't',
      createdAt: ts,
      updatedAt: ts,
      messages: [
        { id: 'm0', role: 'user', text: 'ข้อความเก่าที่จะโดนตัด', ts },
        { id: 'm1', role: 'assistant', text: 'คำตอบที่เหลืออยู่', ts },
      ],
    };
    idx.reindexSession(chat, {});
    assert.equal(idx.search('ข้อความเก่า', {}).total, 1);
    chat.messages.splice(0, 1); // simulate trimMessages
    idx.reindexSession(chat, {});
    assert.equal(idx.search('ข้อความเก่า', {}).total, 0);
    const r = idx.search('คำตอบที่เหลือ', {});
    assert.equal(r.total, 1);
    assert.equal(r.hits[0].matches[0].msgIndex, 0); // re-based to 0
  } finally {
    idx.close();
    cleanup(p);
  }
});

test('corrupt db self-heals: quarantine + fresh enabled index', () => {
  const p = tmpDb('corrupt');
  fs.writeFileSync(p, 'this is not a sqlite database');
  const idx = new SearchIndex({ dbPath: p });
  try {
    assert.equal(idx.enabled, true);
    const st = idx.stats();
    assert.equal(st.enabled, true);
    assert.equal(st.chunks, 0);
    const dir = fs.readdirSync(os.tmpdir());
    assert.ok(dir.some((f) => f.startsWith(path.basename(p)) && f.includes('.corrupt-')));
    // And the fresh db actually indexes.
    idx.indexMessage('s1', 0, 'user', 'หลังกู้คืนยังค้นเจอ', new Date().toISOString(), 1, {});
    idx.flushNow();
    assert.equal(idx.search('กู้คืน', {}).total, 1);
  } finally {
    idx.close();
    cleanup(p);
  }
});

test('removeSession and removeGroup drop their chunks', () => {
  const p = tmpDb('remove');
  const idx = new SearchIndex({ dbPath: p });
  try {
    seedTwoSessions(idx);
    assert.equal(idx.search('ค้นหา', {}).total, 2);
    idx.removeSession('s1');
    idx.flushNow();
    assert.equal(idx.search('ค้นหา', {}).total, 1);
    idx.removeGroup('g1');
    idx.flushNow();
    // The group pseudo-hit is gone; remaining session shells still carry the
    // group name in their indexed text (correct — it describes the session).
    const g = idx.search('งานไทย', {});
    assert.ok(g.hits.every((h) => h.hitType === 'session'));
  } finally {
    idx.close();
    cleanup(p);
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}
console.log(`search: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
