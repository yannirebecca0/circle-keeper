// Thin wrapper around the PayPal REST APIs (sandbox by default).
// Orders v2 collects each member's contribution; Payouts v1 sends the pot to the round's recipient.

const base = () => process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
let cached = { token: null, exp: 0 };

const configured = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

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
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal auth failed: ${data.error_description || res.status}`);
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}

async function call(path, body) {
  const token = await getToken();
  const res = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.details && data.details[0] ? ` (${data.details[0].issue || data.details[0].description})` : '';
    throw new Error(`PayPal ${path} failed: ${data.message || data.name || res.status}${detail}`);
  }
  return data;
}

const money = (n) => Number(n).toFixed(2);

// Create an order for one member's contribution. Returns where to send them to approve it.
async function createContributionOrder({ amount, currency, memberId, round, circleName, returnUrl, cancelUrl }) {
  const order = await call('/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: `${memberId}-r${round}`,
        custom_id: memberId,
        description: `${circleName} - round ${round + 1} contribution`,
        amount: { currency_code: currency, value: money(amount) },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
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

// Capture the order after the member approves it.
async function captureOrder(orderId) {
  const data = await call(`/v2/checkout/orders/${orderId}/capture`, {});
  const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
  return { status: data.status, captureId: capture ? capture.id : null };
}

// Pay the pot out to the round's recipient (PayPal Payouts).
async function sendPayout({ email, amount, currency, note, batchId, itemId }) {
  const data = await call('/v1/payments/payouts', {
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

module.exports = { configured, createContributionOrder, captureOrder, sendPayout };
