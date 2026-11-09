// The AI coordinator. It does real reasoning over each circle's members:
//  1. planRotation: decides payout order and flags risk, with a rationale a human can read
//  2. draftNudge:   writes a reminder whose tone fits the relationship and how late the payment is
//
// Providers (first one with a key wins):
//   GEMINI_API_KEY    -> Google Gemini (has a free tier via Google AI Studio)
//   ANTHROPIC_API_KEY -> Anthropic Claude
// With no key at all, the app falls back to simple deterministic behavior so it still runs.

const GEMINI_MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// If the main model is overloaded or unavailable, try these in order (comma-separated override via GEMINI_FALLBACK_MODELS).
const GEMINI_FALLBACKS = () =>
  (process.env.GEMINI_FALLBACK_MODELS || 'gemini-flash-latest,gemini-flash-lite-latest').split(',').map((m) => m.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLAUDE_MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';

const provider = () => {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
};
const enabled = () => provider() !== null;
const providerName = () => ({ gemini: `Gemini (${GEMINI_MODEL()})`, anthropic: `Claude (${CLAUDE_MODEL()})` }[provider()] || null);

async function geminiOnce(model, system, user, maxTokens, json) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        // Headroom: some Gemini models spend output tokens on internal thinking.
        maxOutputTokens: Math.max(maxTokens, 2048),
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error?.message || `Gemini request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('');
  if (!text) throw new Error('Gemini returned no text');
  return text;
}

// Retries temporary errors (overload/rate limit/timeouts) with backoff, then falls back to other models.
async function askGemini(system, user, maxTokens, json) {
  const models = [GEMINI_MODEL(), ...GEMINI_FALLBACKS()].filter((m, i, a) => a.indexOf(m) === i);
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await geminiOnce(model, system, user, maxTokens, json);
      } catch (e) {
        lastErr = e;
        const temporary = !e.status || e.status === 429 || e.status >= 500;
        if (!temporary) break; // e.g. model not found / bad key: move on to the next model
        await sleep(800 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

async function askClaude(system, user, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL(),
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Claude request failed (${res.status})`);
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function ask(system, user, maxTokens = 1200, json = false) {
  return provider() === 'gemini' ? askGemini(system, user, maxTokens, json) : askClaude(system, user, maxTokens);
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('AI did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}

async function planRotation(members, amount, currency) {
  const fallback = {
    order: members.map((m) => m.id),
    rationale: 'AI planning is off (no GEMINI_API_KEY or ANTHROPIC_API_KEY), so members keep their sign-up order.',
    risks: {},
    usedAI: false,
  };
  if (!enabled()) return fallback;

  const system = [
    'You coordinate a rotating savings circle where every member contributes each round and one member receives the whole pot.',
    'Plan the payout order. Principles:',
    '- Members who receive early could stop paying afterward, so place members with higher default risk later in the order.',
    '- Members with a stated urgent need should go earlier, as long as they are not high risk.',
    '- Reliable, steady members are good early recipients and good anchors for trust.',
    '- Be fair and kind. Risk is about circumstances, not character. Never be judgmental.',
    'Reply with ONLY a JSON object: {"order":[member ids, each exactly once],"rationale":"2-4 plain sentences",',
    '"risks":{"<id>":{"level":"low|medium|high","reason":"one short sentence"}}}',
  ].join('\n');

  const user = JSON.stringify({
    contribution_per_round: amount,
    currency,
    members: members.map((m) => ({ id: m.id, name: m.name, notes: m.note })),
  });

  try {
    const out = extractJson(await ask(system, user, 1200, true));
    const ids = members.map((m) => m.id);
    const valid =
      Array.isArray(out.order) &&
      out.order.length === ids.length &&
      ids.every((id) => out.order.includes(id)) &&
      new Set(out.order).size === ids.length;
    if (!valid) throw new Error('invalid order');
    const risks = {};
    for (const id of ids) {
      const r = out.risks && out.risks[id];
      if (r && ['low', 'medium', 'high'].includes(r.level)) risks[id] = { level: r.level, reason: String(r.reason || '') };
    }
    return { order: out.order, rationale: String(out.rationale || ''), risks, usedAI: true };
  } catch (e) {
    return { ...fallback, rationale: `AI planning failed (${e.message}), so members keep their sign-up order.` };
  }
}

async function draftNudge({ member, daysLate, circleName, amount, currency }) {
  const fallback = `Hi ${member.name}, a friendly reminder that your ${currency} ${amount} contribution to ${circleName} is still open for this round. Thank you!`;
  if (!enabled()) return fallback;
  const system = [
    'You write short, warm payment reminders for a lending circle between friends and family.',
    'Match the tone to the relationship in the notes AND to how late the payment is. The tone must visibly escalate:',
    '- 1-2 days late: light and casual, assume it was simply forgotten, no pressure.',
    '- 3-6 days late: warm but clear; say the contribution is overdue and ask them to pay this week.',
    '- 7+ days late: direct and serious while still respectful; say the whole circle is waiting on this payment, ask for a payment date or to talk if something is wrong, and do not say "no rush" or "no stress".',
    'Always stay kind.',
    'Never shame, threaten, or mention other members\' private circumstances. 2-4 sentences. Output only the message text.',
  ].join('\n');
  const user = JSON.stringify({
    recipient_name: member.name,
    notes_about_recipient: member.note,
    days_late: daysLate,
    circle: circleName,
    amount,
    currency,
  });
  try {
    return (await ask(system, user, 300)).trim();
  } catch {
    return fallback;
  }
}

module.exports = { enabled, providerName, planRotation, draftNudge };
