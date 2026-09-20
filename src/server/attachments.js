// File attachments for prompts — grok-desktop's attach UX (picker + pasted
// paths + chips) with one deliberate break: attachments NEVER merge into the
// prompt text. The MSP schema (muse schema, TurnInputPartType, closed)
// allows exactly three part types:
//
//   - images → `{ type: 'image', base64Data, mediaType }` parts
//   - files/folders → `@path` mentions in a SEPARATE text part
//     ("File mentions are text, not a part type")
//
// So the user's own text part stays verbatim; the transcript stores the
// attachments in message meta and paints them as chips under the bubble.
//
// Pure helpers (classify/validate/parts) are unit-tested; the fs helpers
// (loadImagePart/saveImageData/saveUpload) take explicit dirs so tests can
// point them at tmp.

import fs from 'node:fs';
import path from 'node:path';

/** Raster images the model can see → image parts. SVG stays a mention. */
export const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGES_PER_TURN = 10;
export const MAX_MENTIONS_PER_TURN = 32;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export function baseName(p) {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Media type for an image path, or null when it is not a sendable image. */
export function mediaTypeForPath(p) {
  const ext = path.extname(String(p || '')).toLowerCase();
  return IMAGE_MEDIA_TYPES[ext] || null;
}

export function isImagePath(p) {
  return mediaTypeForPath(p) !== null;
}

function bad(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Normalize one raw attachment from POST /prompt into a validated
 * descriptor. Accepts:
 *   { path }                       — absolute file/folder path
 *   { name, mediaType, base64 }      — pasted/dropped image pixels
 *   { path, mediaType, name }        — already-normalized (retry path)
 */
export function normalizeAttachmentInput(raw) {
  if (!raw || typeof raw !== 'object') throw bad(400, 'attachment must be an object');
  if (typeof raw.path === 'string' && raw.path.trim()) {
    const p = raw.path.trim();
    if (!path.isAbsolute(p)) throw bad(400, `attachment path must be absolute: ${p.slice(0, 120)}`);
    if (p.includes('\0')) throw bad(400, 'attachment path contains NUL');
    return { kind: 'path', path: p };
  }
  const { name, mediaType, base64 } = raw;
  if (typeof base64 !== 'string' || !base64) throw bad(400, 'image attachment needs base64 data');
  if (!/^image\/(png|jpe?g|gif|webp)$/i.test(String(mediaType || ''))) {
    throw bad(400, `unsupported image mediaType: ${String(mediaType).slice(0, 60)}`);
  }
  let bytes;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    throw bad(400, 'image attachment is not valid base64');
  }
  if (!bytes.length) throw bad(400, 'image attachment is empty');
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw bad(413, `image exceeds ${MAX_IMAGE_BYTES} bytes`);
  }
  return {
    kind: 'image-data',
    name: String(name || 'pasted-image').slice(0, 120) || 'pasted-image',
    mediaType: String(mediaType).toLowerCase(),
    base64,
    bytes: bytes.length,
  };
}

/**
 * @param {string} filePath absolute path to a raster image
 * @returns {{ base64Data: string, mediaType: string, bytes: number }}
 */
export function loadImagePart(filePath) {
  const mediaType = mediaTypeForPath(filePath);
  if (!mediaType) throw bad(400, `not a sendable image: ${baseName(filePath)}`);
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    throw bad(400, `attachment not found: ${filePath.slice(0, 160)}`);
  }
  if (!st.isFile()) throw bad(400, `attachment is not a file: ${filePath.slice(0, 160)}`);
  if (st.size > MAX_IMAGE_BYTES) throw bad(413, `image exceeds ${MAX_IMAGE_BYTES} bytes`);
  if (st.size === 0) throw bad(400, `attachment is empty: ${filePath.slice(0, 160)}`);
  return { base64Data: fs.readFileSync(filePath).toString('base64'), mediaType, bytes: st.size };
}

export function assertReadablePath(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    throw bad(400, `attachment not readable: ${String(filePath).slice(0, 160)}`);
  }
}

function safeFileName(name, fallback) {
  const s = String(name || '')
    .split('/')
    .pop()
    .replace(/[^a-zA-Z0-9\u0E00-\u0E7F._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return s || fallback;
}

/**
 * Persist pasted/dropped image bytes under the chat's attach dir so history
 * chips survive restarts and retries re-read from disk. Returns the saved
 * absolute path.
 */
export function saveImageData({ dir, chatId, name, mediaType, base64 }) {
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  if (!bytes.length) throw bad(400, 'image attachment is empty');
  if (bytes.length > MAX_IMAGE_BYTES) throw bad(413, `image exceeds ${MAX_IMAGE_BYTES} bytes`);
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[
    String(mediaType).toLowerCase()
  ];
  if (!ext) throw bad(400, `unsupported image mediaType: ${String(mediaType).slice(0, 60)}`);
  const target = path.join(String(dir), `chat-${chatId}`);
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, `${Date.now()}-${safeFileName(name, 'image')}${ext}`);
  fs.writeFileSync(file, bytes);
  return { path: file, bytes: bytes.length, mediaType: String(mediaType).toLowerCase() };
}

/**
 * Persist an uploaded (dropped) non-image file under the shared inbox.
 * Returns the saved absolute path.
 */
export function saveUpload({ dir, name, base64 }) {
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  if (!bytes.length) throw bad(400, 'upload is empty');
  if (bytes.length > MAX_UPLOAD_BYTES) throw bad(413, `upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
  const target = path.join(String(dir), 'inbox');
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, `${Date.now()}-${safeFileName(name, 'upload.bin')}`);
  fs.writeFileSync(file, bytes);
  return { path: file, bytes: bytes.length };
}

/** `@path` mention lines for one text part (schema: mentions are text). */
export function buildMentionText(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return '';
  return list.map((p) => `@${p}`).join('\n');
}

/**
 * Assemble turn/start input parts. User text first (verbatim, omitted when
 * empty), then image parts, then the mention text part last — the mock agent
 * reads input[0].text, so text-first keeps the e2e contract.
 */
export function buildTurnInput({ text, images = [], mentionText = '' }) {
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const img of images) {
    parts.push({ type: 'image', base64Data: img.base64Data, mediaType: img.mediaType });
  }
  if (mentionText) parts.push({ type: 'text', text: mentionText });
  return parts;
}

/**
 * Resolve validated attachments into wire parts + transcript meta.
 * Image paths and pasted pixels become image parts; every other path
 * (docs, code, folders, svg…) becomes an `@path` mention line.
 *
 * @param {Array} normalized from normalizeAttachmentInput
 * @param {{ attachDir: string, chatId: string }} opts
 * @returns {{ images: Array, mentionText: string, meta: Array<{path,mediaType,name}> }}
 */
export function resolveAttachments(normalized, { attachDir, chatId }) {
  const images = [];
  const mentionPaths = [];
  const meta = [];
  for (const a of normalized || []) {
    if (a.kind === 'image-data') {
      if (images.length >= MAX_IMAGES_PER_TURN) throw bad(400, `at most ${MAX_IMAGES_PER_TURN} images per turn`);
      const saved = saveImageData({ dir: attachDir, chatId, name: a.name, mediaType: a.mediaType, base64: a.base64 });
      const bytes = Buffer.from(a.base64, 'base64');
      images.push({ base64Data: bytes.toString('base64'), mediaType: a.mediaType });
      meta.push({ path: saved.path, mediaType: saved.mediaType, name: baseName(saved.path) });
      continue;
    }
    // kind === 'path'
    assertReadablePath(a.path);
    const mediaType = mediaTypeForPath(a.path);
    let isDir = false;
    try {
      isDir = fs.statSync(a.path).isDirectory();
    } catch {
      throw bad(400, `attachment not readable: ${a.path.slice(0, 160)}`);
    }
    if (mediaType && !isDir) {
      if (images.length >= MAX_IMAGES_PER_TURN) throw bad(400, `at most ${MAX_IMAGES_PER_TURN} images per turn`);
      const part = loadImagePart(a.path);
      images.push({ base64Data: part.base64Data, mediaType: part.mediaType });
      meta.push({ path: a.path, mediaType, name: baseName(a.path) });
    } else {
      if (mentionPaths.length >= MAX_MENTIONS_PER_TURN) {
        throw bad(400, `at most ${MAX_MENTIONS_PER_TURN} file mentions per turn`);
      }
      mentionPaths.push(a.path);
      meta.push({ path: a.path, mediaType: null, name: baseName(a.path) });
    }
  }
  return { images, mentionText: buildMentionText(mentionPaths), meta };
}
