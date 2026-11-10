// Tiny JSON store holding many circles, one per visitor or group.
// Circles live in memory as plain objects and are written to disk after each change.
// Node runs our code on one thread, so changes made between `await`s never interleave:
// route handlers re-check state after every await instead of saving stale copies.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const MAX_CIRCLES = Number(process.env.MAX_CIRCLES) || 500;

let db = { circles: {} };
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (raw && raw.circles) db = raw; // older single-circle files are ignored
} catch {}

const save = () => {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
};

const token = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');

const get = (id) => (typeof id === 'string' && Object.hasOwn(db.circles, id) ? db.circles[id] : null);

function add(circle) {
  const ids = Object.keys(db.circles);
  if (ids.length >= MAX_CIRCLES) {
    // Drop the oldest circles so a public demo can't grow without bound.
    ids
      .sort((a, b) => db.circles[a].createdAt - db.circles[b].createdAt)
      .slice(0, ids.length - MAX_CIRCLES + 1)
      .forEach((id) => delete db.circles[id]);
  }
  db.circles[circle.id] = circle;
  save();
  return circle;
}

const all = () => Object.values(db.circles);

// Constant-time comparison for access keys.
function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { get, add, all, save, token, sameKey, DATA_FILE };
