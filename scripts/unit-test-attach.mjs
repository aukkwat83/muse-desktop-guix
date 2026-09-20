#!/usr/bin/env node
// Attachments (src/server/attachments.js): classification, validation, turn
// input parts (images as parts, files as @mentions — never merged into the
// prompt text), and the on-disk roundtrips for pasted pixels + uploads.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_IMAGES_PER_TURN,
  MAX_MENTIONS_PER_TURN,
  baseName,
  buildMentionText,
  buildTurnInput,
  isImagePath,
  loadImagePart,
  mediaTypeForPath,
  normalizeAttachmentInput,
  resolveAttachments,
  saveImageData,
  saveUpload,
} from '../src/server/attachments.js';

// 1x1 transparent PNG.
const PIXEL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tmpDir(name) {
  const d = path.join(os.tmpdir(), `muse-attach-test-${name}-${process.pid}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test('baseName strips dirs and trailing slashes', () => {
  assert.equal(baseName('/a/b/c.png'), 'c.png');
  assert.equal(baseName('/a/b/dir/'), 'dir');
  assert.equal(baseName('plain'), 'plain');
});

test('media types: raster images only, svg stays a mention', () => {
  assert.equal(mediaTypeForPath('/x/a.png'), 'image/png');
  assert.equal(mediaTypeForPath('/x/a.JPG'), 'image/jpeg');
  assert.equal(mediaTypeForPath('/x/a.jpeg'), 'image/jpeg');
  assert.equal(mediaTypeForPath('/x/a.gif'), 'image/gif');
  assert.equal(mediaTypeForPath('/x/a.webp'), 'image/webp');
  assert.equal(mediaTypeForPath('/x/a.svg'), null);
  assert.equal(mediaTypeForPath('/x/a.pdf'), null);
  assert.equal(mediaTypeForPath('/x/a'), null);
  assert.equal(isImagePath('/x/a.png'), true);
  assert.equal(isImagePath('/x/a.md'), false);
});

test('normalize accepts absolute paths, rejects the rest', () => {
  assert.deepEqual(normalizeAttachmentInput({ path: '/tmp/x.md' }), { kind: 'path', path: '/tmp/x.md' });
  assert.deepEqual(normalizeAttachmentInput({ path: '/t', mediaType: 'image/png', name: 'n' }), {
    kind: 'path',
    path: '/t',
  });
  for (const raw of [null, 'x', {}, { path: 'rel/x' }, { path: '' }, { path: '/a\0b' }]) {
    assert.throws(() => normalizeAttachmentInput(raw), /./, JSON.stringify(raw));
  }
  try {
    normalizeAttachmentInput({ path: 'rel' });
    assert.fail('relative path accepted');
  } catch (err) {
    assert.equal(err.status, 400);
  }
});

test('normalize validates pasted image pixels', () => {
  const a = normalizeAttachmentInput({ name: 's.png', mediaType: 'image/png', base64: PIXEL_PNG_B64 });
  assert.equal(a.kind, 'image-data');
  assert.ok(a.bytes > 0);
  assert.throws(() => normalizeAttachmentInput({ mediaType: 'image/png' }), /base64/);
  assert.throws(() => normalizeAttachmentInput({ mediaType: 'image/svg+xml', base64: PIXEL_PNG_B64 }), /mediaType/);
  assert.throws(() => normalizeAttachmentInput({ mediaType: 'image/png', base64: '' }), /base64 data/);
});

test('mention text is @lines, empty when none', () => {
  assert.equal(buildMentionText(['/a/b.md', '/c']), '@/a/b.md\n@/c');
  assert.equal(buildMentionText([]), '');
  assert.equal(buildMentionText(null), '');
});

test('turn input keeps text first, images middle, mentions last', () => {
  const parts = buildTurnInput({
    text: 'hi',
    images: [{ base64Data: 'xx', mediaType: 'image/png' }],
    mentionText: '@/a',
  });
  assert.deepEqual(parts, [
    { type: 'text', text: 'hi' },
    { type: 'image', base64Data: 'xx', mediaType: 'image/png' },
    { type: 'text', text: '@/a' },
  ]);
  // Text-only turns are exactly the old single-part shape.
  assert.deepEqual(buildTurnInput({ text: 'hi' }), [{ type: 'text', text: 'hi' }]);
  // Attachments-only turns omit the empty text part.
  assert.deepEqual(buildTurnInput({ text: '', mentionText: '@/a' }), [{ type: 'text', text: '@/a' }]);
});

test('loadImagePart reads raster files, rejects the rest', () => {
  const d = tmpDir('load');
  const png = path.join(d, 'a.png');
  fs.writeFileSync(png, Buffer.from(PIXEL_PNG_B64, 'base64'));
  const part = loadImagePart(png);
  assert.equal(part.mediaType, 'image/png');
  assert.equal(part.base64Data, PIXEL_PNG_B64);
  assert.throws(() => loadImagePart(path.join(d, 'nope.png')), /not found/);
  assert.throws(() => loadImagePart(d), /not a sendable image|not a file/);
  const md = path.join(d, 'a.md');
  fs.writeFileSync(md, 'x');
  assert.throws(() => loadImagePart(md), /not a sendable image/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('saveImageData persists under the chat dir with safe names', () => {
  const d = tmpDir('saveimg');
  const saved = saveImageData({
    dir: d,
    chatId: 'c1',
    name: '../../evil.png',
    mediaType: 'image/png',
    base64: PIXEL_PNG_B64,
  });
  assert.ok(saved.path.startsWith(path.join(d, 'chat-c1') + path.sep));
  assert.ok(!saved.path.includes('..'));
  assert.deepEqual(fs.readFileSync(saved.path), Buffer.from(PIXEL_PNG_B64, 'base64'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('saveUpload persists dropped bytes to the inbox', () => {
  const d = tmpDir('upload');
  const saved = saveUpload({ dir: d, name: 'notes.md', base64: Buffer.from('hi').toString('base64') });
  assert.ok(saved.path.includes(`${path.sep}inbox${path.sep}`));
  assert.equal(fs.readFileSync(saved.path, 'utf8'), 'hi');
  assert.throws(() => saveUpload({ dir: d, name: 'x', base64: '' }), /empty/);
  fs.rmSync(d, { recursive: true, force: true });
});

test('resolveAttachments splits images from mentions', () => {
  const d = tmpDir('resolve');
  const png = path.join(d, 'shot.png');
  fs.writeFileSync(png, Buffer.from(PIXEL_PNG_B64, 'base64'));
  const md = path.join(d, 'doc.md');
  fs.writeFileSync(md, 'doc');
  const sub = path.join(d, 'sub');
  fs.mkdirSync(sub);
  const out = resolveAttachments(
    [
      { kind: 'path', path: png },
      { kind: 'path', path: md },
      { kind: 'path', path: `${sub}/` },
      { kind: 'image-data', name: 'paste.png', mediaType: 'image/png', base64: PIXEL_PNG_B64 },
    ],
    { attachDir: d, chatId: 'c9' },
  );
  assert.equal(out.images.length, 2);
  assert.equal(out.images[0].mediaType, 'image/png');
  assert.equal(out.mentionText, `@${md}\n@${sub}/`);
  assert.equal(out.meta.length, 4);
  assert.equal(out.meta[0].mediaType, 'image/png');
  assert.equal(out.meta[1].mediaType, null);
  assert.ok(out.meta[3].path.includes('chat-c9'));
  fs.rmSync(d, { recursive: true, force: true });
});

test('resolveAttachments enforces caps and existence', () => {
  const d = tmpDir('caps');
  const png = path.join(d, 'a.png');
  fs.writeFileSync(png, Buffer.from(PIXEL_PNG_B64, 'base64'));
  const many = Array.from({ length: MAX_IMAGES_PER_TURN + 1 }, () => ({ kind: 'path', path: png }));
  assert.throws(() => resolveAttachments(many, { attachDir: d, chatId: 'c' }), /at most/);
  const md = path.join(d, 'a.md');
  fs.writeFileSync(md, 'x');
  const mentions = Array.from({ length: MAX_MENTIONS_PER_TURN + 1 }, (_, i) => ({
    kind: 'path',
    path: i === 0 ? md : `${md}${i}`,
  }));
  // First path exists so the cap (not existence) trips — pad with the same file.
  const same = Array.from({ length: MAX_MENTIONS_PER_TURN + 1 }, () => ({ kind: 'path', path: md }));
  assert.throws(() => resolveAttachments(same, { attachDir: d, chatId: 'c' }), /at most/);
  assert.throws(
    () => resolveAttachments([{ kind: 'path', path: path.join(d, 'missing.md') }], { attachDir: d, chatId: 'c' }),
    /not readable/,
  );
  assert.ok(mentions.length > 0);
  fs.rmSync(d, { recursive: true, force: true });
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
console.log(`attach: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
