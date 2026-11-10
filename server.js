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
const store = require('./store');
const C = require('./circle');
const agent = require('./agent');

const PORT = process.env.PORT || 3000;
// On Render, RENDER_EXTERNAL_URL is set automatically.
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- http helpers ----------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // Page URLs carry access keys, so never leak them to PayPal or anyone else via Referer.
  'Referrer-Policy': 'no-referrer',
};
const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj));
};
const redirect = (res, location) => {
  res.writeHead(302, { Location: location, ...SECURITY_HEADERS });
  res.end();
};
const readRaw = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
const readBody = async (req) => {
  const raw = await readRaw(req);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    C.fail(400, 'Invalid JSON');
  }
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, SECURITY_HEADERS);
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
  fs.createReadStream(file).pipe(res);
}

// Simple per-IP limit for AI calls, so a public demo can't run up the AI bill.
const aiHits = new Map();
function limitAI(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const hour = 60 * 60 * 1000;
  const hits = (aiHits.get(ip) || []).filter((t) => Date.now() - t < hour);
  if (hits.length >= (Number(process.env.AI_LIMIT_PER_HOUR) || 40)) C.fail(429, 'Too many AI requests from you this hour. Try again later.');
  hits.push(Date.now());
  aiHits.set(ip, hits);
}

const backTo = (s, key, q) => `/?c=${encodeURIComponent(s.id)}&key=${encodeURIComponent(key)}&${q}`;

const viewFor = ({ s, role, member }) => (role === 'organizer' ? C.organizerView(s) : C.memberView(s, member));
const needOrganizer = (a) => a.role === 'organizer' || C.fail(403, 'Only the organizer can do this.');

// ---------- webhooks ----------
const CAPTURE_STATUS = { COMPLETED: 'COMPLETED', PENDING: 'PENDING', DENIED: 'DENIED', REFUNDED: 'REFUNDED', REVERSED: 'REVERSED', DECLINED: 'DENIED' };

function handleWebhookEvent(event) {
  const type = String(event.event_type || '');
  const r = event.resource || {};
  if (type.startsWith('PAYMENT.CAPTURE.')) {
    const ref = paypal.parseCustomId(r.custom_id);
    const s = ref && store.get(ref.circleId);
    const status = CAPTURE_STATUS[type.slice('PAYMENT.CAPTURE.'.length)];
    if (!s || !status) return;
    C.recordContribution(s, {
      memberId: ref.memberId,
      round: ref.round,
      orderId: r.supplementary_data?.related_ids?.order_id,
      captureId: r.id,
      status,
      via: 'webhook',
    });
    return;
  }
  if (type.startsWith('PAYMENT.PAYOUTSBATCH.') || type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
    const batchId = r.batch_header?.payout_batch_id || r.payout_batch_id;
    if (!batchId) return;
    for (const s of store.all()) {
      const p = s.payouts.find((x) => x.payoutBatchId === batchId);
      if (!p) continue;
      if (r.batch_header?.batch_status) p.status = r.batch_header.batch_status;
      if (r.transaction_status) p.itemStatus = r.transaction_status;
      C.log(s, 'paypal', `Round ${p.round + 1} payout to ${p.recipient}: ${p.itemStatus || p.status} (PayPal webhook).`);
      store.save();
      return;
    }
  }
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, BASE_URL);
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;

  // App status (no circle needed)
  if (method === 'GET' && url.pathname === '/api/status') {
    return send(res, 200, {
      aiEnabled: ai.enabled(),
      aiProvider: ai.providerName(),
      paypalConfigured: paypal.configured(),
      webhooks: paypal.webhooksConfigured(),
      demoEmails: !!process.env.DEMO_EMAILS,
    });
  }

  if (method === 'POST' && url.pathname === '/api/circles/demo') {
    const s = C.createDemo();
    return send(res, 200, { id: s.id, key: s.adminKey });
  }

  if (method === 'POST' && url.pathname === '/api/circles') {
    const s = C.createCircle(await readBody(req));
    return send(res, 200, { id: s.id, key: s.adminKey });
  }

  // Circle routes: /api/c/:id[/action...] with the access key in the X-Circle-Key header.
  if (parts[0] === 'api' && parts[1] === 'c' && parts[2]) {
    const a = C.access(parts[2], req.headers['x-circle-key']);
    const { s } = a;
    const action = parts.slice(3).join('/');

    if (method === 'GET' && action === '') return send(res, 200, viewFor(a));

    if (method === 'POST' && action === 'pay') {
      const { memberId } = await readBody(req);
      if (a.role === 'member' && memberId !== a.member.id) C.fail(403, 'You can only pay your own contribution.');
      const returnKey = a.role === 'member' ? a.member.token : s.adminKey;
      const approveUrl = await C.startPayment(s, memberId, { baseUrl: BASE_URL, returnKey });
      return send(res, 200, { approveUrl });
    }

    needOrganizer(a);

    if (method === 'POST' && action === 'plan') {
      if (C.moneyMoved(s)) C.fail(400, 'The rotation is locked once money has moved.');
      if (ai.enabled()) limitAI(req);
      const plan = await ai.planRotation(s.members, s.amount, s.currency);
      if (C.moneyMoved(s)) C.fail(400, 'The rotation is locked once money has moved.');
      s.order = plan.order;
      s.rationale = plan.rationale;
      s.risks = plan.risks;
      C.log(s, plan.usedAI ? 'agent' : 'system', plan.usedAI ? 'Planned the payout order and flagged risks.' : 'Kept sign-up order (AI planning unavailable).');
      store.save();
      return send(res, 200, C.organizerView(s));
    }

    if (method === 'POST' && action === 'checkin') {
      const { instruction } = await readBody(req);
      if (ai.enabled()) limitAI(req);
      const result = await agent.runCheckIn(s, instruction);
      return send(res, 200, { ...result, circle: C.organizerView(s) });
    }

    if (method === 'GET' && action === 'progress') {
      // Polled by the UI while a check-in runs, so the organizer can watch the agent work.
      return send(res, 200, { ...agent.getProgress(s.id), circle: C.organizerView(s) });
    }

    if (method === 'POST' && action === 'payout') {
      await C.payout(s, 'organizer');
      return send(res, 200, C.organizerView(s));
    }

    if (method === 'POST' && parts[3] === 'proposals' && parts[4]) {
      const { approve } = await readBody(req);
      await C.decide(s, parts[4], approve === true);
      return send(res, 200, C.organizerView(s));
    }

    if (method === 'POST' && action === 'clock') {
      // Demo helper: move this circle's clock forward to show how lateness changes the coordinator's behavior.
      const { days } = await readBody(req);
      const d = Math.round(Number(days));
      if (!(d >= 1 && d <= 14)) C.fail(400, 'Skip ahead 1 to 14 days.');
      s.clockOffsetDays = (s.clockOffsetDays || 0) + d;
      C.log(s, 'system', `Demo clock moved forward ${d} day${d === 1 ? '' : 's'}.`);
      store.save();
      return send(res, 200, C.organizerView(s));
    }

    if (method === 'POST' && action === 'sync') {
      await C.syncPayments(s);
      await C.refreshPayoutStatus(s).catch(() => null);
      return send(res, 200, C.organizerView(s));
    }

    return send(res, 404, { error: 'Not found' });
  }

  // PayPal sends the member back here after they approve the payment.
  if (method === 'GET' && url.pathname === '/paypal/return') {
    const orderId = url.searchParams.get('token');
    const s = orderId && store.all().find((x) => x.pending[orderId]);
    if (!s) return redirect(res, '/?error=' + encodeURIComponent('Unknown or already processed PayPal order'));
    const { returnKey } = s.pending[orderId];
    try {
      const { member, status } = await C.captureForMember(s, orderId, 'redirect');
      return redirect(res, backTo(s, returnKey, status === 'COMPLETED' ? 'paid=' + encodeURIComponent(member.name) : 'error=' + encodeURIComponent('Payment is pending at PayPal')));
    } catch (e) {
      return redirect(res, backTo(s, returnKey, 'error=' + encodeURIComponent(e.message)));
    }
  }

  if (method === 'GET' && url.pathname === '/paypal/cancel') {
    const c = url.searchParams.get('c');
    const key = url.searchParams.get('key');
    const q = 'error=' + encodeURIComponent('Payment cancelled');
    return redirect(res, c && key ? `/?c=${encodeURIComponent(c)}&key=${encodeURIComponent(key)}&${q}` : `/?${q}`);
  }

  // PayPal webhooks: signed events confirming captures, refunds and payout results.
  if (method === 'POST' && url.pathname === '/api/paypal/webhook') {
    const raw = await readRaw(req);
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: 'Invalid JSON' });
    }
    if (!paypal.webhooksConfigured()) return send(res, 200, { ignored: 'PAYPAL_WEBHOOK_ID is not set' });
    const verified = await paypal.verifyWebhook(req.headers, raw).catch((e) => {
      console.error('Webhook verification error:', e.message);
      return false;
    });
    if (!verified) return send(res, 400, { error: 'Signature verification failed' });
    handleWebhookEvent(event);
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
  send(res, 404, { error: 'Not found' });
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!e.status) console.error(e);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    });
  })
  .listen(PORT, () => {
    console.log(`Circle Keeper running at ${BASE_URL}`);
    console.log(`PayPal: ${paypal.configured() ? 'configured' : 'NOT configured'} | Webhooks: ${paypal.webhooksConfigured() ? 'on' : 'off (set PAYPAL_WEBHOOK_ID)'} | AI: ${ai.enabled() ? 'on (' + ai.providerName() + ')' : 'off'}`);
    if (!process.env.DEMO_EMAILS) console.warn('Warning: DEMO_EMAILS is not set, so demo payouts go to placeholder @example.com addresses.');
    console.log(`Data file: ${store.DATA_FILE}`);
  });
