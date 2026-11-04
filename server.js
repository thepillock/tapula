'use strict';
/*
 * Tapula — self-hosted swipeable micro-lessons.
 * Zero dependencies: Node >= 22.13 (built-in node:sqlite).
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 100) * 1024 * 1024;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TRUST_PROXY = process.env.TRUST_PROXY !== 'false';
const SESSION_DAYS = 30;
const TTS_URL = (process.env.TTS_URL || '').replace(/\/+$/, '');   // OpenAI-compatible base, e.g. http://192.168.1.10:8880/v1
const TTS_API_KEY = process.env.TTS_API_KEY || '';
const TTS_MODEL = process.env.TTS_MODEL || 'kokoro';
const TTS_MAX_CHARS = 5000;
const PUB = path.join(__dirname, 'public');
const UPLOADS = path.join(DATA_DIR, 'uploads');

try { fs.mkdirSync(UPLOADS, { recursive: true }); fs.accessSync(DATA_DIR, fs.constants.W_OK); }
catch (e) {
  console.error(`Cannot write to ${DATA_DIR} (${e.code}). The container user (uid ${process.getuid?.()}) needs write access to the data folder.`);
  console.error('Fix: set PUID/PGID to the folder owner, or run: chown -R <uid>:<gid> <host data folder>');
  process.exit(1);
}

const MIME_OK = {
  'image/png': 1, 'image/jpeg': 1, 'image/gif': 1, 'image/webp': 1,
  'video/mp4': 1, 'video/webm': 1, 'video/quicktime': 1,
  'audio/mpeg': 1, 'audio/mp4': 1, 'audio/x-m4a': 1, 'audio/aac': 1, 'audio/wav': 1, 'audio/x-wav': 1, 'audio/ogg': 1, 'audio/webm': 1,
};

// ---------------------------------------------------------------- database
const db = new DatabaseSync(path.join(DATA_DIR, 'tapula.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS views (
    course_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    visits INTEGER NOT NULL DEFAULT 1,
    furthest INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    completed_at INTEGER,
    PRIMARY KEY (course_id, viewer_id)
  );
  CREATE TABLE IF NOT EXISTS answers (
    course_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    choice INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (course_id, viewer_id, block_id)
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'editor',
    pw_hash TEXT NOT NULL,
    must_change INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS views_course ON views(course_id);
  CREATE INDEX IF NOT EXISTS answers_course ON answers(course_id);
  CREATE TABLE IF NOT EXISTS listens (
    course_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    pct INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL,
    PRIMARY KEY (course_id, viewer_id, block_id)
  );
`);

for (const col of ['created_by', 'updated_by']) {
  try { db.exec(`ALTER TABLE courses ADD COLUMN ${col} TEXT`); } catch { /* already there */ }
}

const q = {
  listCourses: db.prepare('SELECT id, data, published, created_at, updated_at, created_by, updated_by FROM courses ORDER BY updated_at DESC'),
  getCourse: db.prepare('SELECT id, data, published, created_at, updated_at, created_by, updated_by FROM courses WHERE id = ?'),
  insertCourse: db.prepare('INSERT INTO courses (id, data, published, created_at, updated_at, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateCourse: db.prepare('UPDATE courses SET data = ?, updated_at = ?, updated_by = ? WHERE id = ?'),
  publishCourse: db.prepare('UPDATE courses SET published = ?, updated_at = ? WHERE id = ?'),
  deleteCourse: db.prepare('DELETE FROM courses WHERE id = ?'),
  deleteViews: db.prepare('DELETE FROM views WHERE course_id = ?'),
  deleteAnswers: db.prepare('DELETE FROM answers WHERE course_id = ?'),
  deleteListens: db.prepare('DELETE FROM listens WHERE course_id = ?'),
  listen: db.prepare(`INSERT INTO listens (course_id, viewer_id, block_id, pct, at) VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(course_id, viewer_id, block_id) DO UPDATE SET pct = MAX(pct, excluded.pct), at = excluded.at`),
  statListens: db.prepare('SELECT block_id, COUNT(*) AS n, AVG(pct) AS avg, SUM(pct >= 90) AS done FROM listens WHERE course_id = ? GROUP BY block_id'),
  summary: db.prepare(`SELECT course_id, COUNT(*) AS viewers, SUM(completed_at IS NOT NULL) AS completed
                       FROM views GROUP BY course_id`),
  insertMedia: db.prepare('INSERT INTO media (id, mime, size, created_at) VALUES (?, ?, ?, ?)'),
  getMedia: db.prepare('SELECT id, mime, size FROM media WHERE id = ?'),
  allMedia: db.prepare('SELECT id, created_at FROM media'),
  deleteMedia: db.prepare('DELETE FROM media WHERE id = ?'),
  viewStart: db.prepare(`INSERT INTO views (course_id, viewer_id, first_at, last_at, visits, furthest, total)
                         VALUES (?, ?, ?, ?, 1, 0, ?)
                         ON CONFLICT(course_id, viewer_id) DO UPDATE SET visits = visits + 1, last_at = excluded.last_at`),
  viewEnsure: db.prepare(`INSERT INTO views (course_id, viewer_id, first_at, last_at, visits, furthest, total)
                          VALUES (?, ?, ?, ?, 1, 0, ?) ON CONFLICT(course_id, viewer_id) DO NOTHING`),
  viewProgress: db.prepare(`UPDATE views SET furthest = MAX(furthest, ?), total = ?, last_at = ?,
                            completed_at = CASE WHEN ? >= ? AND completed_at IS NULL THEN ? ELSE completed_at END
                            WHERE course_id = ? AND viewer_id = ?`),
  answer: db.prepare('INSERT OR IGNORE INTO answers (course_id, viewer_id, block_id, choice, at) VALUES (?, ?, ?, ?, ?)'),
  answerLatest: db.prepare(`INSERT INTO answers (course_id, viewer_id, block_id, choice, at) VALUES (?, ?, ?, ?, ?)
                            ON CONFLICT(course_id, viewer_id, block_id) DO UPDATE SET choice = excluded.choice, at = excluded.at`),
  statViewers: db.prepare('SELECT viewer_id, first_at, last_at, visits, furthest, total, completed_at FROM views WHERE course_id = ? ORDER BY last_at DESC'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  countAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0"),
  listUsers: db.prepare('SELECT id, username, name, role, must_change, disabled, created_at, last_login FROM users ORDER BY role, username'),
  userNames: db.prepare('SELECT id, username, name FROM users'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  insertUser: db.prepare('INSERT INTO users (id, username, name, role, pw_hash, must_change, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  setPassword: db.prepare('UPDATE users SET pw_hash = ?, must_change = ? WHERE id = ?'),
  setUserName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
  setDisabled: db.prepare('UPDATE users SET disabled = ? WHERE id = ?'),
  touchLogin: db.prepare('UPDATE users SET last_login = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  sessionUser: db.prepare(`SELECT u.id, u.username, u.name, u.role, u.must_change, s.token_hash FROM sessions s
                           JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  statAnswers: db.prepare('SELECT block_id, choice, COUNT(*) AS n FROM answers WHERE course_id = ? GROUP BY block_id, choice'),
};

// ---------------------------------------------------------------- helpers
const rid = (n = 10) => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(n), (b) => abc[b % abc.length]).join('');
};
const ID_RE = /^[a-z0-9]{4,40}$/;
const now = () => Date.now();
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonForHtml = (o) => JSON.stringify(o).replace(/</g, '\\u003c').split('\u2028').join('\\u2028').split('\u2029').join('\\u2029');

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  }
  return req.socket.remoteAddress || '';
}
function isHttps(req) {
  return TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || '').includes('https') : !!req.socket.encrypted;
}
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${PORT}`;
  return `${isHttps(req) ? 'https' : 'http'}://${host}`;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
const fail = (res, status, error) => sendJson(res, status, { error });

async function readJson(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(c);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

// simple per-key rate limiter
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || t - b.start > windowMs) { b = { start: t, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.start > 3600e3) buckets.delete(k); }, 600e3).unref();

// ---------------------------------------------------------------- auth
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/i;
const MIN_PASSWORD = 8;
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${h.toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(pw || ''), Buffer.from(salt, 'base64'), want.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(got, want);
}
const DUMMY_HASH_P = hashPassword(crypto.randomBytes(8).toString('hex')); // equalise timing for unknown users
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } }
  }
  return out;
}
function currentUser(req) {
  if (req._user !== undefined) return req._user;
  const tok = parseCookies(req).tapula_session;
  const row = tok && /^[A-Za-z0-9_-]{20,100}$/.test(tok) ? q.sessionUser.get(tokenHash(tok), now()) : null;
  req._user = row ? { id: row.id, username: row.username, name: row.name, role: row.role, mustChange: !!row.must_change, tokenHash: row.token_hash } : null;
  return req._user;
}
function createSession(userId) {
  const tok = crypto.randomBytes(32).toString('base64url');
  q.insertSession.run(tokenHash(tok), userId, now(), now() + SESSION_DAYS * 864e5);
  return tok;
}
function cookie(req, value, maxAge) {
  return `tapula_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name || u.username, role: u.role, mustChange: !!(u.must_change ?? u.mustChange), disabled: !!u.disabled, createdAt: u.created_at, lastLogin: u.last_login });
function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return 'Password is too long.';
  return null;
}
async function bootstrapAdmin() {
  if (q.countUsers.get().n > 0) return;
  if (!ADMIN_PASSWORD) {
    console.error('No accounts exist yet. Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME) to create the admin account, then restart.');
    process.exit(1);
  }
  if (!USERNAME_RE.test(ADMIN_USERNAME)) { console.error('ADMIN_USERNAME may only contain letters, numbers, dot, dash and underscore.'); process.exit(1); }
  q.insertUser.run(rid(12), ADMIN_USERNAME, 'Admin', 'admin', await hashPassword(ADMIN_PASSWORD), 0, now());
  console.log(`Created admin account "${ADMIN_USERNAME}". You can remove ADMIN_PASSWORD from the environment now.`);
}

// ---------------------------------------------------------------- courses
function rowToCourse(row) {
  const data = JSON.parse(row.data);
  return { id: row.id, published: !!row.published, createdAt: row.created_at, updatedAt: row.updated_at, createdBy: row.created_by || null, updatedBy: row.updated_by || null, ...data };
}
function nameMap() {
  return Object.fromEntries(q.userNames.all().map((u) => [u.id, u.name || u.username]));
}
function sanitizeCourse(body) {
  const title = String(body.title ?? '').slice(0, 200);
  const accent = /^#[0-9a-fA-F]{6}$/.test(body.accent || '') ? body.accent : '#ff5a36';
  const cards = Array.isArray(body.cards) ? body.cards.slice(0, 200) : [];
  return { title, accent, cards };
}
function templateCourse() {
  return {
    title: 'Untitled lesson',
    accent: '#ff5a36',
    cards: [
      { id: rid(), bg: '#fff4e6', blocks: [
        { id: rid(), type: 'heading', text: 'Welcome!' },
        { id: rid(), type: 'text', text: 'This is your first card. Add text, images, video or a quick quiz from the panel on the right.' },
      ] },
      { id: rid(), bg: '#17161b', blocks: [
        { id: rid(), type: 'quiz', question: 'Ready to start?', options: ['Yes', 'Absolutely'], correct: -1, explain: '' },
      ] },
    ],
  };
}
function mediaIdsIn(course) {
  const ids = new Set();
  for (const c of course.cards || []) for (const b of c.blocks || []) if (b && b.asset) ids.add(String(b.asset));
  return ids;
}
async function collectGarbageMedia() {
  const used = new Set();
  for (const row of q.listCourses.all()) for (const id of mediaIdsIn(JSON.parse(row.data))) used.add(id);
  const cutoff = now() - 24 * 3600e3; // keep fresh uploads that haven't been saved into a lesson yet
  let removed = 0;
  for (const m of q.allMedia.all()) {
    if (used.has(m.id) || m.created_at > cutoff) continue;
    q.deleteMedia.run(m.id);
    await fsp.rm(path.join(UPLOADS, m.id), { force: true });
    removed++;
  }
  if (removed) console.log(`Removed ${removed} unused media file(s)`);
}

function courseStats(id, course) {
  const viewers = q.statViewers.all(id);
  const cards = course.cards || [];
  const n = cards.length;
  const reach = new Array(n).fill(0);
  let completed = 0, visits = 0, progressSum = 0;
  const day = 864e5;
  const today = Math.floor(now() / day);
  const daily = new Array(30).fill(0);
  for (const v of viewers) {
    visits += v.visits;
    if (v.completed_at) completed++;
    const f = Math.min(v.furthest, n); // index n == finished
    for (let k = 0; k <= Math.min(f, n - 1); k++) reach[k]++;
    progressSum += n ? (v.completed_at ? 1 : Math.min(f + 1, n) / n) : 0;
    const d = today - Math.floor(v.first_at / day);
    if (d >= 0 && d < 30) daily[29 - d]++;
  }
  const answerRows = q.statAnswers.all(id);
  const byBlock = {};
  for (const r of answerRows) (byBlock[r.block_id] ||= {})[r.choice] = r.n;
  const quizzes = [];
  cards.forEach((c, ci) => (c.blocks || []).forEach((b) => {
    if (b.type !== 'quiz') return;
    const counts = (b.options || []).map((_, oi) => (byBlock[b.id] || {})[oi] || 0);
    quizzes.push({ card: ci, question: b.question || '', options: b.options || [], correct: b.correct, counts, total: counts.reduce((a, x) => a + x, 0) });
  }));
  const listenRows = Object.fromEntries(q.statListens.all(id).map((r) => [r.block_id, r]));
  const audio = [];
  cards.forEach((c, ci) => (c.blocks || []).forEach((b) => {
    if (b.type !== 'audio') return;
    const r = listenRows[b.id] || { n: 0, avg: 0, done: 0 };
    const firstLine = String(b.script || '').trim().split(/\n/)[0].slice(0, 90);
    audio.push({ card: ci, label: b.title || firstLine || 'Audio', listeners: r.n, avgPct: r.n ? Math.round(r.avg) : 0, finished: r.done || 0 });
  }));
  return {
    audio,
    cards: n,
    viewers: viewers.length,
    visits,
    completed,
    completionRate: viewers.length ? completed / viewers.length : 0,
    avgProgress: viewers.length ? progressSum / viewers.length : 0,
    reach,
    daily,
    quizzes,
    recent: viewers.slice(0, 25).map((v) => ({
      viewer: v.viewer_id.slice(0, 6), firstAt: v.first_at, lastAt: v.last_at, visits: v.visits,
      furthest: Math.min(v.furthest, n), total: v.total || n, completed: !!v.completed_at,
    })),
  };
}

// ---------------------------------------------------------------- static files
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const fileCache = new Map();
async function readPublic(name) {
  if (process.env.NODE_ENV === 'production' && fileCache.has(name)) return fileCache.get(name);
  const txt = await fsp.readFile(path.join(PUB, name), 'utf8');
  fileCache.set(name, txt);
  return txt;
}
async function serveStatic(req, res, rel) {
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) return fail(res, 404, 'Not found');
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error();
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch { fail(res, 404, 'Not found'); }
}

async function serveMedia(req, res, id) {
  const m = ID_RE.test(id) && q.getMedia.get(id);
  if (!m) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const file = path.join(UPLOADS, m.id);
  let size;
  try { size = (await fsp.stat(file)).size; } catch { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
  const headers = { ...SECURITY_HEADERS, 'Content-Type': m.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (start < 0) start = 0;
    if (end >= size) end = size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function handleUpload(req, res) {
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!MIME_OK[mime]) return fail(res, 415, 'Unsupported file type. Use PNG, JPG, GIF, WebP, MP4, WebM, MOV, MP3, M4A, WAV or OGG.');
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) return fail(res, 413, `File is larger than ${MAX_UPLOAD / 1048576} MB.`);
  const id = rid(16);
  const tmp = path.join(UPLOADS, `${id}.part`);
  let size = 0;
  try {
    await pipeline(req, async function* (src) {
      for await (const chunk of src) {
        size += chunk.length;
        if (size > MAX_UPLOAD) throw Object.assign(new Error('too large'), { status: 413 });
        yield chunk;
      }
    }, fs.createWriteStream(tmp));
    if (!size) throw Object.assign(new Error('empty'), { status: 400 });
    await fsp.rename(tmp, path.join(UPLOADS, id));
    q.insertMedia.run(id, mime, size, now());
    sendJson(res, 201, { id, url: `/media/${id}`, size, mime });
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    if (e.status === 413) return fail(res, 413, `File is larger than ${MAX_UPLOAD / 1048576} MB.`);
    if (e.status === 400) return fail(res, 400, 'Empty upload.');
    throw e;
  }
}

// ---------------------------------------------------------------- text-to-speech (OpenAI-compatible, e.g. Kokoro-FastAPI)
const LANGS = { a: 'English (US)', b: 'English (UK)', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese (BR)', z: 'Chinese' };
let voiceCache = { at: 0, list: null };
function ttsHeaders(json = true) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (TTS_API_KEY) h.Authorization = `Bearer ${TTS_API_KEY}`;
  return h;
}
function describeVoice(id) {
  const m = /^([a-z])([fm])_(.+)$/.exec(id);
  if (!m) return { id, name: id, lang: 'Other', gender: '' };
  const name = m[3].replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { id, name, lang: LANGS[m[1]] || 'Other', gender: m[2] === 'f' ? 'Female' : 'Male' };
}
async function ttsVoices() {
  if (!TTS_URL) return { enabled: false, reason: 'not_configured' };
  if (voiceCache.list && now() - voiceCache.at < 10 * 60e3) return { enabled: true, voices: voiceCache.list };
  try {
    const r = await fetch(`${TTS_URL}/audio/voices`, { headers: ttsHeaders(false), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const raw = Array.isArray(j) ? j : (j.voices || []);
    const ids = raw.map((v) => (typeof v === 'string' ? v : v.id || v.name)).filter((v) => typeof v === 'string' && /^[\w.+()-]{1,60}$/.test(v));
    const list = ids.map(describeVoice);
    voiceCache = { at: now(), list };
    return { enabled: true, voices: list };
  } catch (e) {
    return { enabled: false, reason: 'unreachable', error: `Couldn't reach the text-to-speech server at ${TTS_URL} (${e.message}).` };
  }
}
async function ttsSpeech(text, voice, speed) {
  if (!TTS_URL) throw Object.assign(new Error('Text-to-speech is not set up (TTS_URL).'), { status: 503 });
  const input = String(text || '').trim();
  if (!input) throw Object.assign(new Error('Write a script first.'), { status: 400 });
  if (input.length > TTS_MAX_CHARS) throw Object.assign(new Error(`Scripts are limited to ${TTS_MAX_CHARS} characters.`), { status: 400 });
  if (!/^[\w.+()-]{1,60}$/.test(String(voice || ''))) throw Object.assign(new Error('Pick a voice.'), { status: 400 });
  const sp = Math.max(0.5, Math.min(Number(speed) || 1, 2));
  let r;
  try {
    r = await fetch(`${TTS_URL}/audio/speech`, {
      method: 'POST', headers: ttsHeaders(),
      body: JSON.stringify({ model: TTS_MODEL, input, voice, speed: sp, response_format: 'mp3' }),
      signal: AbortSignal.timeout(180e3),
    });
  } catch (e) { throw Object.assign(new Error(`Couldn't reach the text-to-speech server (${e.message}).`), { status: 502 }); }
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).slice(0, 200);
    throw Object.assign(new Error(`The text-to-speech server returned an error (HTTP ${r.status}). ${detail}`), { status: 502 });
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 100) throw Object.assign(new Error('The text-to-speech server returned no audio.'), { status: 502 });
  return buf;
}

// ---------------------------------------------------------------- pages
async function renderPlayer(req, res, row, preview) {
  const course = rowToCourse(row);
  const tpl = await readPublic('player.html');
  const firstImg = (course.cards || []).flatMap((c) => c.blocks || []).find((b) => b.type === 'image' && b.asset);
  const firstText = (course.cards || []).flatMap((c) => c.blocks || []).find((b) => b.type === 'text' && b.text);
  const desc = firstText ? String(firstText.text).replace(/\*\*/g, '').slice(0, 180) : `${(course.cards || []).length} cards · swipe to learn`;
  const base = baseUrl(req);
  const meta = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escHtml(course.title || 'Lesson')}">`,
    `<meta property="og:description" content="${escHtml(desc)}">`,
    `<meta name="description" content="${escHtml(desc)}">`,
    `<meta property="og:url" content="${escHtml(`${base}/l/${course.id}`)}">`,
    firstImg ? `<meta property="og:image" content="${escHtml(`${base}/media/${firstImg.asset}`)}">` : '',
    preview ? '<meta name="robots" content="noindex">' : '',
  ].join('\n');
  const publicCourse = { id: course.id, title: course.title, accent: course.accent, cards: course.cards };
  const html = tpl
    .replace('{{TITLE}}', escHtml(course.title || 'Lesson'))
    .replace('{{META}}', meta)
    .replace('{{DATA}}', jsonForHtml({ course: publicCourse, preview: !!preview }));
  send(res, 200, html, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'",
  });
}
async function sendPage(res, name, status = 200) {
  send(res, status, await readPublic(name), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}
async function notFoundPage(res) {
  const tpl = await readPublic('message.html');
  send(res, 404, tpl.replace('{{TITLE}}', 'Lesson not found').replace('{{BODY}}', 'This link may be wrong, or the lesson is no longer available.'), { 'Content-Type': 'text/html; charset=utf-8' });
}

// ---------------------------------------------------------------- router
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;

  // --- public
  if (p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
  if (p === '/' ) return send(res, 302, '', { Location: '/admin' });
  if (p.startsWith('/static/') && (m === 'GET' || m === 'HEAD')) return serveStatic(req, res, p.slice(8));
  if (p.startsWith('/media/') && (m === 'GET' || m === 'HEAD')) return serveMedia(req, res, p.slice(7));
  let mm;
  if ((mm = /^\/l\/([a-z0-9]+)\/?$/.exec(p)) && m === 'GET') {
    const row = q.getCourse.get(mm[1]);
    const preview = url.searchParams.has('preview') && !!currentUser(req);
    if (!row || (!row.published && !preview)) return notFoundPage(res);
    return renderPlayer(req, res, row, preview);
  }
  if (p === '/api/track' && m === 'POST') {
    if (limited('t:' + clientIp(req), 240, 60e3)) return send(res, 429, '');
    const b = await readJson(req, 4096);
    const cid = String(b.c || ''), vid = String(b.v || '');
    if (!ID_RE.test(cid) || !/^[a-z0-9]{8,40}$/.test(vid)) return send(res, 204, '');
    const row = q.getCourse.get(cid);
    if (!row || !row.published) return send(res, 204, '');
    const t = now();
    const cards = JSON.parse(row.data).cards || [];
    const n = cards.length;
    if (b.e === 'view') q.viewStart.run(cid, vid, t, t, n);
    else if (b.e === 'progress') {
      const i = Math.max(0, Math.min(Number(b.i) | 0, n));
      q.viewEnsure.run(cid, vid, t, t, n); // in case 'view' was lost
      q.viewProgress.run(i, n, t, i, n, t, cid, vid);
    } else if (b.e === 'listen' && /^[a-z0-9]{4,40}$/.test(String(b.b || ''))) {
      q.listen.run(cid, vid, String(b.b), Math.max(0, Math.min(Number(b.p) | 0, 100)), t);
    } else if (b.e === 'answer' && /^[a-z0-9]{4,40}$/.test(String(b.b || ''))) {
      const blk = cards.flatMap((c) => c.blocks || []).find((x) => x && x.id === String(b.b) && x.type === 'quiz');
      if (blk) (blk.allowChange ? q.answerLatest : q.answer).run(cid, vid, blk.id, Math.max(0, Math.min(Number(b.a) | 0, (blk.options || []).length - 1)), t);
    }
    return send(res, 204, '');
  }

  // --- auth
  if (p === '/login' && m === 'GET') return currentUser(req) ? send(res, 302, '', { Location: '/admin' }) : sendPage(res, 'login.html');
  if (p === '/api/login' && m === 'POST') {
    const b = await readJson(req, 4096);
    const uname = String(b.username || '').trim().toLowerCase();
    if (limited('l:' + clientIp(req), 10, 15 * 60e3) || limited('lu:' + uname, 10, 15 * 60e3)) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
    const u = USERNAME_RE.test(uname) ? q.getUserByName.get(uname) : null;
    const ok = u ? await verifyPassword(b.password, u.pw_hash) : (await verifyPassword(b.password, await DUMMY_HASH_P), false);
    if (!ok || u.disabled) { await new Promise((r) => setTimeout(r, 300)); return fail(res, 401, u && ok && u.disabled ? 'This account is disabled.' : 'Wrong username or password.'); }
    q.touchLogin.run(now(), u.id);
    return send(res, 200, JSON.stringify({ mustChange: !!u.must_change }), { 'Content-Type': 'application/json', 'Set-Cookie': cookie(req, createSession(u.id), SESSION_DAYS * 86400) });
  }
  if (p === '/api/logout' && m === 'POST') {
    const u = currentUser(req);
    if (u) q.deleteSession.run(u.tokenHash);
    return send(res, 204, '', { 'Set-Cookie': cookie(req, '', 0) });
  }

  // --- admin pages
  if (p === '/admin' || p.startsWith('/admin/')) {
    if (!currentUser(req)) return send(res, 302, '', { Location: '/login' });
    return sendPage(res, 'admin.html');
  }

  // --- admin API (session + CSRF header)
  if (p.startsWith('/api/')) {
    const me = currentUser(req);
    if (!me) return fail(res, 401, 'Not signed in.');
    if (m !== 'GET' && m !== 'HEAD' && req.headers['x-tapula'] !== '1') return fail(res, 403, 'Missing request header.');

    if (p === '/api/config' && m === 'GET') return sendJson(res, 200, { baseUrl: baseUrl(req), maxUploadMb: MAX_UPLOAD / 1048576, me: publicUser(me), minPassword: MIN_PASSWORD });

    // --- own account (allowed even when a password change is pending)
    if (p === '/api/me/password' && m === 'POST') {
      const b = await readJson(req, 4096);
      const u = q.getUserById.get(me.id);
      if (!(await verifyPassword(b.current, u.pw_hash))) return fail(res, 400, 'Your current password is wrong.');
      const bad = checkNewPassword(b.next); if (bad) return fail(res, 400, bad);
      if (b.next === b.current) return fail(res, 400, 'Choose a password different from the current one.');
      q.setPassword.run(await hashPassword(b.next), 0, me.id);
      q.deleteOtherSessions.run(me.id, me.tokenHash);
      return send(res, 204, '');
    }
    if (p === '/api/me' && m === 'PATCH') {
      const b = await readJson(req, 4096);
      q.setUserName.run(String(b.name || '').trim().slice(0, 60), me.id);
      return send(res, 204, '');
    }
    if (me.mustChange) return sendJson(res, 403, { error: 'Please change your password first.', code: 'must_change' });

    // --- user management (admin only)
    if (p === '/api/users' || p.startsWith('/api/users/')) {
      if (me.role !== 'admin') return fail(res, 403, 'Only the admin can manage accounts.');
      if (p === '/api/users' && m === 'GET') return sendJson(res, 200, q.listUsers.all().map(publicUser));
      if (p === '/api/users' && m === 'POST') {
        const b = await readJson(req, 4096);
        const username = String(b.username || '').trim().toLowerCase();
        if (!USERNAME_RE.test(username)) return fail(res, 400, 'Usernames are 2–32 characters: letters, numbers, dot, dash or underscore.');
        if (q.getUserByName.get(username)) return fail(res, 409, 'That username is already taken.');
        const bad = checkNewPassword(b.password); if (bad) return fail(res, 400, bad);
        const id = rid(12);
        q.insertUser.run(id, username, String(b.name || '').trim().slice(0, 60), 'editor', await hashPassword(b.password), 1, now());
        return sendJson(res, 201, publicUser(q.getUserById.get(id)));
      }
      const um = /^\/api\/users\/([a-z0-9]+)(\/password)?$/.exec(p);
      const target = um && q.getUserById.get(um[1]);
      if (!target) return fail(res, 404, 'Account not found.');
      if (um[2] && m === 'POST') {
        const b = await readJson(req, 4096);
        const bad = checkNewPassword(b.password); if (bad) return fail(res, 400, bad);
        q.setPassword.run(await hashPassword(b.password), target.id === me.id ? 0 : 1, target.id);
        if (target.id !== me.id) q.deleteUserSessions.run(target.id); else q.deleteOtherSessions.run(me.id, me.tokenHash);
        return send(res, 204, '');
      }
      if (!um[2] && m === 'PATCH') {
        const b = await readJson(req, 4096);
        if (typeof b.name === 'string') q.setUserName.run(b.name.trim().slice(0, 60), target.id);
        if (typeof b.disabled === 'boolean') {
          if (target.id === me.id) return fail(res, 400, 'You can\'t disable your own account.');
          q.setDisabled.run(b.disabled ? 1 : 0, target.id);
          if (b.disabled) q.deleteUserSessions.run(target.id);
        }
        return sendJson(res, 200, publicUser(q.getUserById.get(target.id)));
      }
      if (!um[2] && m === 'DELETE') {
        if (target.id === me.id) return fail(res, 400, 'You can\'t delete your own account.');
        q.deleteUserSessions.run(target.id); q.deleteUser.run(target.id);
        return send(res, 204, '');
      }
      return fail(res, 404, 'Not found.');
    }
    if (p === '/api/media' && m === 'POST') return handleUpload(req, res);
    if (p === '/api/tts/voices' && m === 'GET') {
      if (url.searchParams.has('refresh')) voiceCache = { at: 0, list: null };
      return sendJson(res, 200, await ttsVoices());
    }
    if ((p === '/api/tts/sample' || p === '/api/tts/generate') && m === 'POST') {
      if (limited('tts:' + me.id, 60, 10 * 60e3)) return fail(res, 429, 'Too many requests. Wait a few minutes.');
      const b = await readJson(req, 64 * 1024);
      const sample = p.endsWith('sample');
      const text = sample ? (String(b.text || '').trim().slice(0, 200) || 'Hello! This is how I sound.') : b.text;
      const audio = await ttsSpeech(text, b.voice, b.speed);
      if (sample) return send(res, 200, audio, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      const id = rid(16);
      await fsp.writeFile(path.join(UPLOADS, id), audio);
      q.insertMedia.run(id, 'audio/mpeg', audio.length, now());
      return sendJson(res, 201, { id, url: `/media/${id}`, size: audio.length });
    }

    if (p === '/api/courses' && m === 'GET') {
      const names = nameMap();
      const sums = Object.fromEntries(q.summary.all().map((r) => [r.course_id, r]));
      return sendJson(res, 200, q.listCourses.all().map((r) => {
        const c = rowToCourse(r);
        const s = sums[c.id] || { viewers: 0, completed: 0 };
        return { id: c.id, title: c.title, accent: c.accent, published: c.published, updatedAt: c.updatedAt, cardCount: (c.cards || []).length, firstCard: (c.cards || [])[0] || null, viewers: s.viewers, completed: s.completed || 0, createdBy: names[c.createdBy] || null, updatedBy: names[c.updatedBy] || null };
      }));
    }
    if (p === '/api/courses' && m === 'POST') {
      const id = rid(); const t = now();
      q.insertCourse.run(id, JSON.stringify(templateCourse()), 0, t, t, me.id, me.id);
      return sendJson(res, 201, { id });
    }
    if ((mm = /^\/api\/courses\/([a-z0-9]+)(?:\/(publish|duplicate|stats|stats\/reset))?$/.exec(p))) {
      const id = mm[1], sub = mm[2];
      const row = q.getCourse.get(id);
      if (!row) return fail(res, 404, 'Lesson not found.');
      if (!sub && m === 'GET') {
        const c = rowToCourse(row); const names = nameMap();
        return sendJson(res, 200, { ...c, createdByName: names[c.createdBy] || null, updatedByName: names[c.updatedBy] || null });
      }
      if (!sub && m === 'PUT') {
        const clean = sanitizeCourse(await readJson(req));
        const t = now();
        q.updateCourse.run(JSON.stringify(clean), t, me.id, id);
        return sendJson(res, 200, { updatedAt: t });
      }
      if (!sub && m === 'DELETE') {
        q.deleteCourse.run(id); q.deleteViews.run(id); q.deleteAnswers.run(id); q.deleteListens.run(id);
        collectGarbageMedia().catch((e) => console.error(e));
        return send(res, 204, '');
      }
      if (sub === 'publish' && m === 'POST') {
        const b = await readJson(req, 1024);
        q.publishCourse.run(b.published ? 1 : 0, now(), id);
        return sendJson(res, 200, { published: !!b.published });
      }
      if (sub === 'duplicate' && m === 'POST') {
        const data = JSON.parse(row.data);
        data.title = `${data.title || 'Untitled'} (copy)`;
        const nid = rid(); const t = now();
        q.insertCourse.run(nid, JSON.stringify(data), 0, t, t, me.id, me.id);
        return sendJson(res, 201, { id: nid });
      }
      if (sub === 'stats' && m === 'GET') return sendJson(res, 200, courseStats(id, JSON.parse(row.data)));
      if (sub === 'stats/reset' && m === 'POST') { q.deleteViews.run(id); q.deleteAnswers.run(id); q.deleteListens.run(id); return send(res, 204, ''); }
    }
    return fail(res, 404, 'Not found.');
  }
  return notFoundPage(res);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e && e.status) return fail(res, e.status, e.message);
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'Server error.');
    else res.destroy();
  });
});
server.requestTimeout = 0; // allow long video uploads on slow links
server.headersTimeout = 60e3;
async function cli(args) {
  // node server.js reset-password <username> <new-password>
  if (args[0] === 'reset-password') {
    const u = args[1] && q.getUserByName.get(String(args[1]).toLowerCase());
    if (!u) { console.error('Usage: node server.js reset-password <username> <new-password>  (user not found)'); process.exit(1); }
    const bad = checkNewPassword(args[2]); if (bad) { console.error(bad); process.exit(1); }
    q.setPassword.run(await hashPassword(args[2]), 0, u.id);
    q.setDisabled.run(0, u.id);
    q.deleteUserSessions.run(u.id);
    console.log(`Password for "${u.username}" has been reset.`);
    process.exit(0);
  }
  console.error(`Unknown command: ${args[0]}`); process.exit(1);
}

(async () => {
  if (process.argv.length > 2) return cli(process.argv.slice(2));
  await bootstrapAdmin();
  q.purgeSessions.run(now());
  setInterval(() => q.purgeSessions.run(now()), 6 * 3600e3).unref();
  server.listen(PORT, () => {
    console.log(`Tapula listening on :${PORT}  (data: ${DATA_DIR})`);
    collectGarbageMedia().catch((e) => console.error(e));
  });
})();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
