// Thin wrapper around the PayPal REST APIs (sandbox by default).
//  - Orders v2:   collect each member's contribution (create, look up, capture)
//  - Payouts v1:  send the pot to the round's recipient, and check its status
//  - Webhooks v1: verify PayPal's signed event notifications

const base = () => process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
let cached = { token: null, exp: 0 };

const configured = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
const webhooksConfigured = () => configured() && !!process.env.PAYPAL_WEBHOOK_ID;

async function getToken() {
  if (cached.token && Date.now() < cached.exp) return cached.token;
  if (!configured()) {
    throw new Error('PayPal is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
  }
  const creds = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${base()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth failed: ${data.error_description || res.status}`);
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}

// method: 'GET' | 'POST'. body may be an object or an already-serialized JSON string.
async function call(method, path, body) {
  const token = await getToken();
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.details && data.details[0] ? ` (${data.details[0].issue || data.details[0].description})` : '';
    const e = new Error(`PayPal ${path} failed: ${data.message || data.name || res.status}${detail}`);
    e.status = res.status;
    e.paypalName = data.name;
    throw e;
  }
  return data;
}

const money = (n) => Number(n).toFixed(2);

// custom_id ties a capture back to its circle, member and round (used by webhooks).
const customId = (circleId, memberId, round) => `${circleId}|${memberId}|${round}`;
function parseCustomId(s) {
  const [circleId, memberId, round] = String(s || '').split('|');
  return circleId && memberId && round !== undefined ? { circleId, memberId, round: Number(round) } : null;
}

// Create an order for one member's contribution. Returns where to send them to approve it.
async function createContributionOrder({ circleId, amount, currency, memberId, round, circleName, returnUrl, cancelUrl }) {
  const order = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: `${memberId}-r${round}`,
        custom_id: customId(circleId, memberId, round),
        description: `${circleName} - round ${round + 1} contribution`.slice(0, 127),
        amount: { currency_code: currency, value: money(amount) },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Circle Keeper',
          return_url: returnUrl,
          cancel_url: cancelUrl,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      },
    },
  });
  const link = (order.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!link) throw new Error('PayPal did not return an approval link');
  return { orderId: order.id, approveUrl: link.href };
}

// Look up an order (used to find payments a member approved but never got redirected back from).
async function getOrder(orderId) {
  const data = await call('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  return { status: data.status, captureId: capture?.id || null, captureStatus: capture?.status || null };
}

// Capture the order after the member approves it.
async function captureOrder(orderId) {
  const data = await call('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {});
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  return { status: data.status, captureId: capture?.id || null, captureStatus: capture?.status || null };
}

// Pay the pot out to the round's recipient (PayPal Payouts).
// batchId must be deterministic per round: PayPal rejects a repeated sender_batch_id, which prevents double payouts.
async function sendPayout({ email, amount, currency, note, batchId, itemId }) {
  const data = await call('POST', '/v1/payments/payouts', {
    sender_batch_header: {
      sender_batch_id: batchId,
      email_subject: 'Your circle payout has arrived',
      email_message: note,
    },
    items: [
      {
        recipient_type: 'EMAIL',
        receiver: email,
        amount: { value: money(amount), currency },
        note,
        sender_item_id: itemId,
      },
    ],
  });
  return { payoutBatchId: data.batch_header?.payout_batch_id, status: data.batch_header?.batch_status };
}

// Current status of a payout batch and its (single) item.
async function getPayoutBatch(payoutBatchId) {
  const data = await call('GET', `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
  return {
    status: data.batch_header?.batch_status || null,
    itemStatus: data.items?.[0]?.transaction_status || null,
  };
}

// Verify a webhook really came from PayPal. The raw body is passed through untouched,
// because re-serializing the event can change it and break the signature check.
async function verifyWebhook(headers, rawBody) {
  if (!webhooksConfigured()) return false;
  const h = (k) => headers[k] || '';
  const body =
    '{' +
    `"auth_algo":${JSON.stringify(h('paypal-auth-algo'))},` +
    `"cert_url":${JSON.stringify(h('paypal-cert-url'))},` +
    `"transmission_id":${JSON.stringify(h('paypal-transmission-id'))},` +
    `"transmission_sig":${JSON.stringify(h('paypal-transmission-sig'))},` +
    `"transmission_time":${JSON.stringify(h('paypal-transmission-time'))},` +
    `"webhook_id":${JSON.stringify(process.env.PAYPAL_WEBHOOK_ID)},` +
    `"webhook_event":${rawBody}` +
    '}';
  const data = await call('POST', '/v1/notifications/verify-webhook-signature', body);
  return data.verification_status === 'SUCCESS';
}

module.exports = {
  configured,
  webhooksConfigured,
  createContributionOrder,
  getOrder,
  captureOrder,
  sendPayout,
  getPayoutBatch,
  verifyWebhook,
  parseCustomId,
};
