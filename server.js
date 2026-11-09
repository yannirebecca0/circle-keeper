// Circle Keeper server. Zero dependencies: only Node built-ins (Node 18+ for global fetch).

const http = require('http');
const fs = require('fs');
const path = require('path');

// Minimal .env loader
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const paypal = require('./paypal');
const ai = require('./ai');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- tiny JSON store ----------
const load = () => {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return null; }
};
const save = (s) => fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));

const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};

function seedDemo() {
  const emails = (process.env.DEMO_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const people = [
    { name: 'Maria', note: "Organizer. Always pays on the 1st. Needs funds soon for her daughter's tuition deposit." },
    { name: 'Ayesha', note: 'Salaried nurse, very steady. Has never missed a payment in past circles.' },
    { name: 'Dev', note: 'Freelancer with irregular income. Paid late twice last year but always caught up.' },
    { name: 'Luz', note: 'New to the circle, a friend of Maria. No payment history yet. Saving for a down payment.' },
    { name: 'Tomas', note: 'Recently changed jobs and says money is tight this quarter. Maria\'s cousin.' },
  ];
  const members = people.map((p, i) => ({
    id: `m${i + 1}`,
    name: p.name,
    email: emails[i] || `member${i + 1}@example.com`,
    note: p.note,
  }));
  return {
    id: `c${Date.now().toString(36)}`,
    name: 'Tanda de Noviembre',
    amount: 20,
    currency: 'USD',
    members,
    order: members.map((m) => m.id),
    round: 0,
    contributions: {}, // contributions[round][memberId] = { orderId, captureId, status }
    pending: {}, // pending[orderId] = { memberId, round }
    payouts: [],
    risks: {},
    rationale: '',
  };
}

// ---------- view model ----------
function view(s) {
  if (!s) return { circle: null, aiEnabled: ai.enabled(), paypalConfigured: paypal.configured() };
  const n = s.members.length;
  const ordered = s.order.map((id) => s.members.find((m) => m.id === id));
  const contribs = s.contributions[s.round] || {};
  const done = s.round >= n;
  return {
    aiEnabled: ai.enabled(),
    paypalConfigured: paypal.configured(),
    circle: {
      id: s.id,
      name: s.name,
      amount: s.amount,
      currency: s.currency,
      status: done ? 'complete' : 'active',
      round: s.round,
      totalRounds: n,
      pot: Number((s.amount * n).toFixed(2)),
      recipient: done ? null : ordered[s.round],
      members: ordered.map((m, i) => ({
        ...m,
        position: i + 1,
        paid: !!(contribs[m.id] && contribs[m.id].status === 'COMPLETED'),
        risk: s.risks[m.id] || null,
      })),
      payouts: s.payouts,
      rationale: s.rationale,
    },
  };
}

// ---------- http helpers ----------
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveStatic(req, res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, BASE_URL);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/circle') return send(res, 200, view(load()));

  if (route === 'POST /api/demo') {
    save(seedDemo());
    return send(res, 200, view(load()));
  }

  if (route === 'POST /api/circle/plan') {
    const s = load() || fail(404, 'No circle yet. Load the demo circle first.');
    if (s.round > 0 || Object.keys(s.contributions).length) fail(400, 'The rotation is locked once money has moved.');
    const plan = await ai.planRotation(s.members, s.amount, s.currency);
    s.order = plan.order;
    s.rationale = plan.rationale;
    s.risks = plan.risks;
    save(s);
    return send(res, 200, view(s));
  }

  if (route === 'POST /api/circle/pay') {
    const s = load() || fail(404, 'No circle yet.');
    const { memberId } = await readBody(req);
    const member = s.members.find((m) => m.id === memberId) || fail(400, 'Unknown member');
    if (s.round >= s.members.length) fail(400, 'This circle is complete.');
    const existing = (s.contributions[s.round] || {})[memberId];
    if (existing && existing.status === 'COMPLETED') fail(400, `${member.name} already paid this round.`);
    const { orderId, approveUrl } = await paypal.createContributionOrder({
      amount: s.amount,
      currency: s.currency,
      memberId,
      round: s.round,
      circleName: s.name,
      returnUrl: `${BASE_URL}/paypal/return`,
      cancelUrl: `${BASE_URL}/paypal/cancel`,
    });
    s.pending[orderId] = { memberId, round: s.round };
    save(s);
    return send(res, 200, { approveUrl });
  }

  if (route === 'GET /paypal/return') {
    const orderId = url.searchParams.get('token');
    const s = load();
    const back = (q) => { res.writeHead(302, { Location: `/?${q}` }); res.end(); };
    if (!s || !orderId || !s.pending[orderId]) return back('error=' + encodeURIComponent('Unknown PayPal order'));
    try {
      const { memberId, round } = s.pending[orderId];
      const cap = await paypal.captureOrder(orderId);
      if (cap.status !== 'COMPLETED') return back('error=' + encodeURIComponent(`Payment status: ${cap.status}`));
      s.contributions[round] = s.contributions[round] || {};
      s.contributions[round][memberId] = { orderId, captureId: cap.captureId, status: 'COMPLETED', at: new Date().toISOString() };
      delete s.pending[orderId];
      save(s);
      const name = s.members.find((m) => m.id === memberId).name;
      return back('paid=' + encodeURIComponent(name));
    } catch (e) {
      return back('error=' + encodeURIComponent(e.message));
    }
  }

  if (route === 'GET /paypal/cancel') {
    res.writeHead(302, { Location: '/?error=' + encodeURIComponent('Payment cancelled') });
    return res.end();
  }

  if (route === 'POST /api/circle/payout') {
    const s = load() || fail(404, 'No circle yet.');
    if (s.round >= s.members.length) fail(400, 'This circle is complete.');
    const v = view(s).circle;
    if (!v.members.every((m) => m.paid)) fail(400, 'Everyone has to contribute before the payout.');
    const recipient = v.recipient;
    const result = await paypal.sendPayout({
      email: recipient.email,
      amount: v.pot,
      currency: s.currency,
      note: `${s.name}: round ${s.round + 1} payout`,
      batchId: `${s.id}-r${s.round}-${Date.now()}`,
      itemId: `${s.id}-r${s.round}`,
    });
    s.payouts.push({ round: s.round, recipient: recipient.name, amount: v.pot, ...result, at: new Date().toISOString() });
    s.round += 1;
    save(s);
    return send(res, 200, view(s));
  }

  if (route === 'POST /api/circle/nudge') {
    const s = load() || fail(404, 'No circle yet.');
    const { memberId, daysLate } = await readBody(req);
    const member = s.members.find((m) => m.id === memberId) || fail(400, 'Unknown member');
    const text = await ai.draftNudge({
      member,
      daysLate: Number(daysLate) || 3,
      circleName: s.name,
      amount: s.amount,
      currency: s.currency,
    });
    return send(res, 200, { text });
  }

  if (req.method === 'GET') return serveStatic(req, res, url.pathname);
  send(res, 404, { error: 'Not found' });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => send(res, e.status || 500, { error: e.message }));
  })
  .listen(PORT, () => {
    console.log(`Circle Keeper running at ${BASE_URL}`);
    console.log(`PayPal: ${paypal.configured() ? 'configured' : 'NOT configured'} | AI: ${ai.enabled() ? 'on (' + ai.providerName() + ')' : 'off'}`);
  });
