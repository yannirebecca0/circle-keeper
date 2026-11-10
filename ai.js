// AI provider layer for Circle Keeper.
//  - planRotation: decides payout order and flags risk, with a rationale a human can read
//  - runToolLoop:  provider-neutral agent loop (the model calls tools until it is done); used by agent.js
//
// Providers (first one with a key wins):
//   GEMINI_API_KEY    -> Google Gemini (has a free tier via Google AI Studio)
//   ANTHROPIC_API_KEY -> Anthropic Claude
// With no key at all, the app falls back to simple deterministic behavior so it still runs.
// Both providers are called over plain HTTPS with fetch, to keep the project dependency-free.

const GEMINI_MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// If the main model is overloaded or unavailable, try these in order (comma-separated override via GEMINI_FALLBACK_MODELS).
const GEMINI_FALLBACKS = () =>
  (process.env.GEMINI_FALLBACK_MODELS || 'gemini-flash-latest,gemini-flash-lite-latest').split(',').map((m) => m.trim()).filter(Boolean);
const CLAUDE_MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const provider = () => {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
};
const enabled = () => provider() !== null;
const providerName = () => ({ gemini: `Gemini (${GEMINI_MODEL()})`, anthropic: `Claude (${CLAUDE_MODEL()})` }[provider()] || null);

// ---------- Gemini ----------

async function geminiOnce(model, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    signal: AbortSignal.timeout(45000),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error?.message || `Gemini request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  const content = data.candidates?.[0]?.content;
  if (!content || !content.parts?.length) throw new Error('Gemini returned an empty response');
  return content;
}

// Retries temporary errors (overload/rate limit/timeouts) with backoff, then falls back to other models.
// Gives up after `budgetMs` so the UI never hangs for minutes.
async function geminiGenerate(body, models, budgetMs = 45000) {
  const deadline = Date.now() + budgetMs;
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() > deadline) throw lastErr || new Error('Gemini timed out');
      try {
        return { content: await geminiOnce(model, body), model };
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

const geminiModels = () => [GEMINI_MODEL(), ...GEMINI_FALLBACKS()].filter((m, i, a) => a.indexOf(m) === i);
const geminiText = (content) => content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');

// ---------- Claude ----------

async function claudeOnce(body) {
  const send = (b) =>
    fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        // Server-side fallback: if the model declines a request, the API retries it on a fallback model.
        'anthropic-beta': 'server-side-fallback-2026-07-01',
      },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify(b),
    });
  let res = await send({ ...body, fallbacks: 'default' });
  let data = await res.json().catch(() => ({}));
  if (res.status === 400 && /fallback/i.test(data.error?.message || '')) {
    // Account or model without fallback support: send the plain request.
    res = await send(body);
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw new Error(data.error?.message || `Claude request failed (${res.status})`);
  if (data.stop_reason === 'refusal') throw new Error('Claude declined this request');
  return data;
}

const claudeText = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('');

// ---------- single-shot ask (used by planRotation) ----------

async function ask(system, user, { json = false, maxTokens = 4000 } = {}) {
  if (provider() === 'gemini') {
    const { content } = await geminiGenerate(
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        // Headroom: some Gemini models spend output tokens on internal thinking.
        generationConfig: { maxOutputTokens: Math.max(maxTokens, 4096), ...(json ? { responseMimeType: 'application/json' } : {}) },
      },
      geminiModels()
    );
    return geminiText(content);
  }
  const data = await claudeOnce({
    model: CLAUDE_MODEL(),
    max_tokens: Math.max(maxTokens, 8000), // room for adaptive thinking plus the answer
    system,
    messages: [{ role: 'user', content: user }],
  });
  return claudeText(data.content);
}

// ---------- agent loop ----------

// tools: [{ name, description, schema }] where schema is a JSON Schema object.
// execute(name, args) -> result object (or throws; the error is returned to the model).
// onStep({ tool, args, result, error }) is called after each tool call.
// Returns { text, steps }.
async function runToolLoop({ system, user, tools, execute, maxSteps = 12 }) {
  if (!enabled()) throw new Error('AI is off');
  let steps = 0;
  const run = async (name, args) => {
    steps += 1;
    try {
      return { ok: true, result: await execute(name, args || {}) };
    } catch (e) {
      return { ok: false, result: { error: e.message } };
    }
  };

  if (provider() === 'gemini') {
    const declarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      ...(Object.keys(t.schema.properties || {}).length ? { parameters: t.schema } : {}),
    }));
    const contents = [{ role: 'user', parts: [{ text: user }] }];
    let models = geminiModels();
    for (let turn = 0; turn < maxSteps; turn++) {
      const { content, model } = await geminiGenerate(
        {
          systemInstruction: { parts: [{ text: system }] },
          contents,
          tools: [{ functionDeclarations: declarations }],
          generationConfig: { maxOutputTokens: 4096 },
        },
        models
      );
      models = [model]; // stay on one model for the whole run (thought signatures are model-specific)
      contents.push(content); // keep the model's turn verbatim, including thought signatures
      const calls = content.parts.filter((p) => p.functionCall);
      if (!calls.length) return { text: geminiText(content).trim(), steps };
      const responses = [];
      for (const p of calls) {
        const { result } = await run(p.functionCall.name, p.functionCall.args);
        responses.push({
          functionResponse: { name: p.functionCall.name, ...(p.functionCall.id ? { id: p.functionCall.id } : {}), response: { result } },
        });
      }
      contents.push({ role: 'user', parts: responses });
    }
    return { text: 'Stopped after reaching the step limit.', steps };
  }

  // Claude
  const claudeTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  const messages = [{ role: 'user', content: user }];
  for (let turn = 0; turn < maxSteps; turn++) {
    const data = await claudeOnce({
      model: CLAUDE_MODEL(),
      max_tokens: 16000,
      system,
      tools: claudeTools,
      messages,
    });
    messages.push({ role: 'assistant', content: data.content }); // full content, including thinking blocks
    if (data.stop_reason !== 'tool_use') return { text: claudeText(data.content).trim(), steps };
    const results = [];
    for (const block of data.content.filter((b) => b.type === 'tool_use')) {
      const { ok, result } = await run(block.name, block.input);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result), ...(ok ? {} : { is_error: true }) });
    }
    messages.push({ role: 'user', content: results }); // all results in one message
  }
  return { text: 'Stopped after reaching the step limit.', steps };
}

// ---------- rotation planning ----------

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
    const out = extractJson(await ask(system, user, { json: true }));
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
      if (r && ['low', 'medium', 'high'].includes(r.level)) risks[id] = { level: r.level, reason: String(r.reason || '').slice(0, 300) };
    }
    return { order: out.order, rationale: String(out.rationale || '').slice(0, 1200), risks, usedAI: true };
  } catch (e) {
    return { ...fallback, rationale: `AI planning failed (${e.message}), so members keep their sign-up order.` };
  }
}

module.exports = { enabled, providerName, planRotation, runToolLoop };
