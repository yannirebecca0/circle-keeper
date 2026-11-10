// Circle domain logic: creating circles, recording money, guardrails, and the views each role sees.
// Both the HTTP routes and the AI coordinator's tools go through these functions,
// so the same rules apply no matter who (or what) is acting.

const store = require('./store');
const paypal = require('./paypal');

const DAY = 24 * 60 * 60 * 1000;
const MAX_ACTIVITY = 200;

const fail = (status, message) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};

// ---------- clock ----------
// Each circle has its own clock offset so a demo can "skip ahead" days without waiting.
const now = (s) => Date.now() + (s.clockOffsetDays || 0) * DAY;
const daysIntoRound = (s) => Math.max(0, Math.floor((now(s) - s.roundStartedAt) / DAY));
const daysLate = (s) => Math.max(0, daysIntoRound(s) - s.dueAfterDays);

// ---------- helpers ----------
const isComplete = (s) => s.round >= s.members.length;
const memberById = (s, id) => s.members.find((m) => m.id === id) || null;
const positionOf = (s, id) => s.order.indexOf(id); // 0-based round in which this member receives
const recipient = (s) => (isComplete(s) ? null : memberById(s, s.order[s.round]));
const pot = (s) => Number((s.amount * s.members.length).toFixed(2));
const contribution = (s, id, round = s.round) => (s.contributions[round] || {})[id] || null;
const hasPaid = (s, id, round = s.round) => contribution(s, id, round)?.status === 'COMPLETED';
const allPaid = (s) => s.members.every((m) => hasPaid(s, m.id));
const moneyMoved = (s) => s.round > 0 || Object.values(s.contributions).some((r) => Object.keys(r).length);

function log(s, actor, text) {
  s.activity.push({ at: now(s), actor, text: String(text).slice(0, 600) });
  if (s.activity.length > MAX_ACTIVITY) s.activity.splice(0, s.activity.length - MAX_ACTIVITY);
}

// ---------- creation ----------
function createCircle({ name, amount, currency = 'USD', dueAfterDays = 3, members }) {
  name = String(name || '').trim().slice(0, 60);
  amount = Number(amount);
  if (!name) fail(400, 'Give the circle a name.');
  if (!Number.isFinite(amount) || amount < 1 || amount > 1000) fail(400, 'Contribution must be between 1 and 1000.');
  if (!/^[A-Z]{3}$/.test(currency)) fail(400, 'Invalid currency.');
  if (!Array.isArray(members) || members.length < 3 || members.length > 12) fail(400, 'A circle needs 3 to 12 members.');
  const seen = new Set();
  const clean = members.map((m, i) => {
    const mName = String(m.name || '').trim().slice(0, 40);
    const email = String(m.email || '').trim().slice(0, 120);
    if (!mName) fail(400, `Member ${i + 1} needs a name.`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, `${mName} needs a valid PayPal email.`);
    if (seen.has(email.toLowerCase())) fail(400, `Two members share the email ${email}.`);
    seen.add(email.toLowerCase());
    return { id: `m${i + 1}`, name: mName, email, note: String(m.note || '').trim().slice(0, 300), token: store.token() };
  });
  const t = Date.now();
  const s = {
    id: store.token(9),
    adminKey: store.token(18),
    name,
    amount: Number(amount.toFixed(2)),
    currency,
    createdAt: t,
    dueAfterDays: Math.min(Math.max(Number(dueAfterDays) || 3, 1), 14),
    clockOffsetDays: 0,
    roundStartedAt: t,
    members: clean,
    order: clean.map((m) => m.id),
    round: 0,
    contributions: {}, // contributions[round][memberId] = { orderId, captureId, status, at, confirmedBy }
    pending: {}, // pending[orderId] = { memberId, round, returnKey, at }
    payouts: [],
    risks: {},
    rationale: '',
    reminders: [], // { memberId, round, text, at, daysLate, by }
    proposals: [], // { id, type: 'payout'|'swap', status, reason, a, b, round, at }
    activity: [],
  };
  log(s, 'organizer', `Created ${name}: ${clean.length} members, ${currency} ${s.amount} each per round.`);
  return store.add(s);
}

function createDemo() {
  const emails = (process.env.DEMO_EMAILS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const people = [
    { name: 'Maria', note: "Organizer. Always pays on the 1st. Needs funds soon for her daughter's tuition deposit." },
    { name: 'Ayesha', note: 'Salaried nurse, very steady. Has never missed a payment in past circles.' },
    { name: 'Dev', note: 'Freelancer with irregular income. Paid late twice last year but always caught up.' },
    { name: 'Luz', note: 'New to the circle, a friend of Maria. No payment history yet. Saving for a down payment.' },
    { name: 'Tomas', note: "Recently changed jobs and says money is tight this quarter. Maria's cousin." },
  ];
  return createCircle({
    name: 'Tanda de Noviembre',
    amount: 20,
    members: people.map((p, i) => ({ ...p, email: emails[i] || `member${i + 1}@example.com` })),
  });
}

// ---------- access ----------
// Returns { s, role: 'organizer' } or { s, role: 'member', member }.
function access(id, key) {
  const s = store.get(id);
  if (!s) fail(404, 'Circle not found. It may have expired from the demo server.');
  if (store.sameKey(key, s.adminKey)) return { s, role: 'organizer' };
  const member = s.members.find((m) => store.sameKey(key, m.token));
  if (member) return { s, role: 'member', member };
  fail(403, 'This link is not valid for this circle.');
}

// ---------- money: contributions ----------
async function startPayment(s, memberId, { baseUrl, returnKey }) {
  const member = memberById(s, memberId) || fail(400, 'Unknown member');
  if (isComplete(s)) fail(400, 'This circle is complete.');
  if (hasPaid(s, memberId)) fail(400, `${member.name} already paid this round.`);
  const round = s.round;
  const { orderId, approveUrl } = await paypal.createContributionOrder({
    circleId: s.id,
    amount: s.amount,
    currency: s.currency,
    memberId,
    round,
    circleName: s.name,
    returnUrl: `${baseUrl}/paypal/return`,
    cancelUrl: `${baseUrl}/paypal/cancel?c=${encodeURIComponent(s.id)}&key=${encodeURIComponent(returnKey)}`,
  });
  s.pending[orderId] = { memberId, round, returnKey, at: Date.now() };
  store.save();
  return approveUrl;
}

// Records a capture. Idempotent: PayPal's redirect, the agent's sync, and webhooks may all report the same payment.
function recordContribution(s, { memberId, round, orderId, captureId, status, via }) {
  const member = memberById(s, memberId);
  if (!member) return false;
  s.contributions[round] = s.contributions[round] || {};
  const prev = s.contributions[round][memberId];
  const was = prev?.status;
  s.contributions[round][memberId] = {
    ...prev,
    orderId: orderId || prev?.orderId,
    captureId: captureId || prev?.captureId,
    status,
    at: prev?.at || now(s),
    confirmedBy: [...new Set([...(prev?.confirmedBy || []), via])],
  };
  if (orderId) delete s.pending[orderId];
  if (was !== status) {
    const label = { COMPLETED: 'paid', PENDING: 'payment is pending at PayPal', REFUNDED: 'payment was refunded', DENIED: 'payment was denied', REVERSED: 'payment was reversed' }[status] || `payment status: ${status}`;
    log(s, via === 'webhook' ? 'paypal' : 'system', `${member.name}'s round ${round + 1} ${label}${via === 'webhook' ? ' (PayPal webhook)' : via === 'sync' ? ' (found by the coordinator)' : ''}.`);
  }
  store.save();
  return was !== status;
}

// Capture an approved order, refusing to take a second payment for the same member and round.
async function captureForMember(s, orderId, via) {
  const p = s.pending[orderId];
  if (!p) fail(400, 'Unknown PayPal order');
  const member = memberById(s, p.memberId);
  if (p.round !== s.round || hasPaid(s, p.memberId, p.round)) {
    delete s.pending[orderId];
    store.save();
    fail(409, `${member.name} already paid this round, so this payment was not taken.`);
  }
  const cap = await paypal.captureOrder(orderId);
  if (cap.status !== 'COMPLETED' && cap.captureStatus !== 'PENDING') fail(400, `Payment status: ${cap.status}`);
  recordContribution(s, { memberId: p.memberId, round: p.round, orderId, captureId: cap.captureId, status: cap.captureStatus || 'COMPLETED', via });
  return { member, status: cap.captureStatus || 'COMPLETED' };
}

// Look at every open order for this round: capture ones the member approved but never returned from.
async function syncPayments(s) {
  const changes = [];
  for (const [orderId, p] of Object.entries(s.pending)) {
    const member = memberById(s, p.memberId);
    if (p.round !== s.round || hasPaid(s, p.memberId, p.round)) {
      delete s.pending[orderId];
      continue;
    }
    try {
      const o = await paypal.getOrder(orderId);
      if (o.status === 'APPROVED') {
        const r = await captureForMember(s, orderId, 'sync');
        changes.push(`${member.name}: approved payment captured (${r.status})`);
      } else if (o.status === 'COMPLETED') {
        recordContribution(s, { memberId: p.memberId, round: p.round, orderId, captureId: o.captureId, status: o.captureStatus || 'COMPLETED', via: 'sync' });
        changes.push(`${member.name}: payment already completed`);
      } else if (Date.now() - p.at > 3 * 60 * 60 * 1000) {
        delete s.pending[orderId]; // PayPal orders expire if not approved
      }
    } catch (e) {
      if (e.status === 404) delete s.pending[orderId];
      else changes.push(`${member.name}: could not check order (${e.message})`);
    }
  }
  store.save();
  return changes;
}

// ---------- money: payouts ----------
const inFlight = new Set(); // circle ids with a payout request in progress

async function payout(s, approvedBy) {
  if (isComplete(s)) fail(400, 'This circle is complete.');
  if (!allPaid(s)) fail(400, 'Everyone has to contribute before the payout.');
  if (inFlight.has(s.id)) fail(409, 'A payout is already being sent.');
  inFlight.add(s.id);
  const round = s.round;
  const to = recipient(s);
  const amount = pot(s);
  try {
    const result = await paypal.sendPayout({
      email: to.email,
      amount,
      currency: s.currency,
      note: `${s.name}: round ${round + 1} payout`,
      // Deterministic per round: PayPal rejects a repeated sender_batch_id, so this can't pay twice.
      batchId: `${s.id}-r${round}`,
      itemId: `${s.id}-r${round}`,
    });
    if (s.round !== round) return; // state moved on while we waited (should not happen with the in-flight guard)
    s.payouts.push({ round, recipientId: to.id, recipient: to.name, amount, ...result, itemStatus: null, at: now(s) });
    s.proposals.forEach((p) => {
      if (p.status === 'pending' && p.type === 'payout' && p.round === round) p.status = 'approved';
    });
    log(s, approvedBy, `Approved the round ${round + 1} payout: ${s.currency} ${amount} sent to ${to.name} with PayPal Payouts (${result.status || 'submitted'}).`);
    s.round += 1;
    s.roundStartedAt = now(s);
    if (isComplete(s)) log(s, 'system', 'Every member has received the pot. The circle is complete.');
    else log(s, 'system', `Round ${s.round + 1} started. ${recipient(s).name} receives next.`);
    store.save();
  } catch (e) {
    if (/DUPLICATE|already exists/i.test(`${e.paypalName} ${e.message}`)) {
      fail(409, 'PayPal already has a payout for this round. Check the sandbox dashboard before trying again.');
    }
    throw e;
  } finally {
    inFlight.delete(s.id);
  }
}

async function refreshPayoutStatus(s) {
  const last = [...s.payouts].reverse().find((p) => p.payoutBatchId);
  if (!last) return null;
  const st = await paypal.getPayoutBatch(last.payoutBatchId);
  const changed = st.status !== last.status || st.itemStatus !== last.itemStatus;
  Object.assign(last, st);
  if (changed) log(s, 'paypal', `Round ${last.round + 1} payout to ${last.recipient}: ${st.itemStatus || st.status}.`);
  store.save();
  return { round: last.round + 1, recipient: last.recipient, batch_status: st.status, item_status: st.itemStatus };
}

// ---------- coordination ----------
function addReminder(s, memberId, text, by) {
  const member = memberById(s, memberId) || fail(400, 'Unknown member');
  if (isComplete(s)) fail(400, 'The circle is complete.');
  if (hasPaid(s, memberId)) fail(400, `${member.name} has already paid this round.`);
  const last = [...s.reminders].reverse().find((r) => r.memberId === memberId && r.round === s.round);
  if (last && now(s) - last.at < DAY) fail(429, `${member.name} was already reminded in the last day. Wait before reminding again.`);
  text = String(text || '').trim();
  if (text.length < 10) fail(400, 'Reminder is too short.');
  if (text.length > 700) fail(400, 'Keep reminders under 700 characters.');
  s.reminders.push({ memberId, round: s.round, text, at: now(s), daysLate: daysLate(s), by });
  log(s, by === 'organizer' ? 'organizer' : 'agent', `Reminded ${member.name} (${daysLate(s)} days late).`);
  store.save();
}

function proposeSwap(s, a, b, reason) {
  const A = memberById(s, a) || fail(400, `Unknown member ${a}`);
  const B = memberById(s, b) || fail(400, `Unknown member ${b}`);
  if (a === b) fail(400, 'Pick two different members.');
  if (positionOf(s, a) <= s.round || positionOf(s, b) <= s.round) {
    fail(400, 'Only members who have not received yet, and are not receiving this round, can swap positions.');
  }
  if (s.proposals.some((p) => p.status === 'pending' && p.type === 'swap')) fail(409, 'A swap is already waiting for approval.');
  const p = { id: store.token(6), type: 'swap', status: 'pending', a, b, reason: String(reason || '').slice(0, 400), round: s.round, at: now(s) };
  s.proposals.push(p);
  log(s, 'agent', `Proposed swapping ${A.name} (round ${positionOf(s, a) + 1}) and ${B.name} (round ${positionOf(s, b) + 1}). Waiting for organizer approval.`);
  store.save();
  return p;
}

function proposePayout(s, reason) {
  if (isComplete(s)) fail(400, 'The circle is complete.');
  if (!allPaid(s)) fail(400, 'Not everyone has paid yet.');
  if (s.proposals.some((p) => p.status === 'pending' && p.type === 'payout' && p.round === s.round)) {
    fail(409, 'A payout request is already waiting for approval.');
  }
  const p = { id: store.token(6), type: 'payout', status: 'pending', round: s.round, reason: String(reason || '').slice(0, 400), at: now(s) };
  s.proposals.push(p);
  log(s, 'agent', `Everyone has paid. Asked the organizer to approve sending ${s.currency} ${pot(s)} to ${recipient(s).name}.`);
  store.save();
  return p;
}

async function decide(s, proposalId, approve) {
  const p = s.proposals.find((x) => x.id === proposalId) || fail(404, 'Unknown request');
  if (p.status !== 'pending') fail(400, 'This request was already handled.');
  if (!approve) {
    p.status = 'declined';
    log(s, 'organizer', `Declined the coordinator's ${p.type === 'swap' ? 'swap' : 'payout'} request.`);
    store.save();
    return;
  }
  if (p.type === 'payout') {
    if (p.round !== s.round) fail(400, 'This payout request is out of date.');
    return payout(s, 'organizer'); // marks the proposal approved
  }
  // swap: re-check that both members still have future positions
  const ia = positionOf(s, p.a);
  const ib = positionOf(s, p.b);
  if (ia <= s.round || ib <= s.round) {
    p.status = 'declined';
    store.save();
    fail(400, 'This swap is no longer possible because one of the members has already received.');
  }
  [s.order[ia], s.order[ib]] = [s.order[ib], s.order[ia]];
  p.status = 'approved';
  log(s, 'organizer', `Approved swap: ${memberById(s, p.a).name} now receives in round ${ib + 1}, ${memberById(s, p.b).name} in round ${ia + 1}.`);
  store.save();
}

// ---------- views ----------
function organizerView(s) {
  const r = recipient(s);
  return {
    role: 'organizer',
    id: s.id,
    name: s.name,
    amount: s.amount,
    currency: s.currency,
    status: isComplete(s) ? 'complete' : 'active',
    round: s.round,
    totalRounds: s.members.length,
    pot: pot(s),
    recipient: r ? { id: r.id, name: r.name } : null,
    dueAfterDays: s.dueAfterDays,
    daysIntoRound: daysIntoRound(s),
    daysLate: daysLate(s),
    today: now(s),
    canPlan: !moneyMoved(s),
    rationale: s.rationale,
    members: s.order.map((id, i) => {
      const m = memberById(s, id);
      const c = contribution(s, id);
      return {
        id: m.id,
        name: m.name,
        email: m.email,
        note: m.note,
        token: m.token,
        position: i + 1,
        received: i < s.round,
        paid: c?.status === 'COMPLETED',
        paymentStatus: c?.status || null,
        confirmedBy: c?.confirmedBy || [],
        risk: s.risks[id] || null,
        remindersThisRound: s.reminders.filter((x) => x.memberId === id && x.round === s.round).length,
      };
    }),
    payouts: s.payouts,
    proposals: s.proposals
      .filter((p) => p.status === 'pending')
      .map((p) => ({
        ...p,
        summary:
          p.type === 'payout'
            ? `Send ${s.currency} ${pot(s)} to ${r ? r.name : '?'} with PayPal Payouts`
            : `Swap ${memberById(s, p.a).name} (round ${positionOf(s, p.a) + 1}) and ${memberById(s, p.b).name} (round ${positionOf(s, p.b) + 1})`,
      })),
    reminders: s.reminders.slice(-20).reverse().map((x) => ({ ...x, name: memberById(s, x.memberId)?.name })),
    activity: s.activity.slice(-60).reverse(),
  };
}

// Members see their own situation and the schedule, never other members' notes, risks or emails.
function memberView(s, me) {
  const r = recipient(s);
  const myPos = positionOf(s, me.id);
  return {
    role: 'member',
    id: s.id,
    name: s.name,
    amount: s.amount,
    currency: s.currency,
    status: isComplete(s) ? 'complete' : 'active',
    round: s.round,
    totalRounds: s.members.length,
    pot: pot(s),
    recipientName: r ? r.name : null,
    dueAfterDays: s.dueAfterDays,
    daysIntoRound: daysIntoRound(s),
    paidCount: s.members.filter((m) => hasPaid(s, m.id)).length,
    me: {
      id: me.id,
      name: me.name,
      position: myPos + 1,
      paid: hasPaid(s, me.id),
      paymentStatus: contribution(s, me.id)?.status || null,
      received: myPos < s.round,
      isRecipient: r && r.id === me.id,
    },
    schedule: s.order.map((id, i) => ({ position: i + 1, name: memberById(s, id).name, received: i < s.round, current: i === s.round })),
    reminders: s.reminders.filter((x) => x.memberId === me.id).slice(-10).reverse(),
  };
}

module.exports = {
  DAY,
  fail,
  now,
  daysIntoRound,
  daysLate,
  isComplete,
  memberById,
  positionOf,
  recipient,
  pot,
  hasPaid,
  allPaid,
  moneyMoved,
  log,
  createCircle,
  createDemo,
  access,
  startPayment,
  recordContribution,
  captureForMember,
  syncPayments,
  payout,
  refreshPayoutStatus,
  addReminder,
  proposeSwap,
  proposePayout,
  decide,
  organizerView,
  memberView,
};
