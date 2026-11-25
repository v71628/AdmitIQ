// AdmitIQ AI router — zero dependencies (Node 18+ fetch).
//
// Providers (all optional; the app still works with none):
//   openai     primary student-facing model (chat, analysis, essays, simulations)
//   gemini     research model with Google Search grounding (returns real web citations)
//   anthropic  optional long-document / secondary-review model
//   compat     the original single-provider setup (AI_PROVIDER=groq|ollama|openrouter|…) kept for backwards compatibility
//
// Every model ID comes from environment variables. When one is not set, the router asks the provider's
// /models endpoint which models exist and picks the newest one matching the tier — nothing is pinned
// to a model name that might be retired.
//
// The router handles: task → provider/tier routing, retries with backoff, fallbacks across providers,
// provider health, token + cost accounting, daily per-user usage units, and a global monthly budget.

import { PLAN_UNITS, TASK_UNITS, planAllows } from '../plans.mjs';

export const TASKS = ['chat', 'analysis', 'essay', 'simulation', 'research', 'long_document', 'verify'];

// Default routes: first entry that is configured and healthy wins; the rest are fallbacks.
const DEFAULT_ROUTES = {
  chat: ['openai:fast', 'gemini:fast', 'anthropic:fast', 'compat:main'],
  analysis: ['openai:main', 'anthropic:main', 'gemini:main', 'compat:main'],
  essay: ['openai:main', 'anthropic:main', 'compat:main', 'gemini:main'],
  simulation: ['openai:reasoning', 'openai:main', 'anthropic:main', 'compat:main'],
  research: ['gemini:grounded', 'openai:main', 'anthropic:main', 'compat:main'],
  long_document: ['anthropic:main', 'openai:main', 'gemini:main', 'compat:main'],
  verify: ['anthropic:main', 'gemini:main', 'openai:main', 'compat:main'],
};

// Model choice when the env var for a tier is not set (newest match wins).
const PREFER = {
  openai: {
    fast: [/^gpt-\d+(\.\d+)?-mini$/, /^gpt-\d+(\.\d+)?-nano$/, /^gpt-4o-mini$/],
    main: [/^gpt-\d+(\.\d+)?$/, /^gpt-4o$/],
    reasoning: [/^gpt-\d+(\.\d+)?-pro$/, /^o\d+$/, /^gpt-\d+(\.\d+)?$/],
  },
  anthropic: { fast: [/haiku/], main: [/sonnet/], reasoning: [/opus/, /sonnet/] },
  gemini: {
    fast: [/^gemini-[\d.]+-flash-lite$/, /^gemini-[\d.]+-flash$/],
    main: [/^gemini-[\d.]+-pro$/, /^gemini-[\d.]+-flash$/],
    grounded: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-pro$/],
    reasoning: [/^gemini-[\d.]+-pro$/],
  },
};

// Legacy single-provider table (AI_PROVIDER=…), unchanged from v1.
export const COMPAT = {
  openai: { base: 'https://api.openai.com/v1', kind: 'openai' },
  groq: { base: 'https://api.groq.com/openai/v1', kind: 'openai', prefer: [/gpt-oss-120b/, /llama-3\.3-70b/, /llama-4/, /qwen/, /gpt-oss/, /llama/] },
  openrouter: { base: 'https://openrouter.ai/api/v1', kind: 'openai', prefer: [/:free$/] },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai', prefer: [/^(models\/)?gemini-[\d.]+-flash$/] },
  ollama: { base: 'http://127.0.0.1:11434/v1', kind: 'openai', keyless: true, prefer: [/./] },
  'openai-compatible': { base: '', kind: 'openai', prefer: [/./] },
  anthropic: { base: 'https://api.anthropic.com/v1', kind: 'anthropic', prefer: [/haiku/, /sonnet/] },
};

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export class AIError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

/** Sort model ids so the highest version number comes first ("gpt-5.1" before "gpt-5", "gemini-2.5" before "gemini-2.0"). */
export function byVersionDesc(a, b) {
  const va = (a.match(/\d+(\.\d+)*/g) || []).map((x) => x.split('.').map(Number));
  const vb = (b.match(/\d+(\.\d+)*/g) || []).map((x) => x.split('.').map(Number));
  const fa = va.flat(), fb = vb.flat();
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
    const d = (fb[i] ?? -1) - (fa[i] ?? -1);
    if (d) return d;
  }
  return a.length - b.length || a.localeCompare(b);
}

export function pickModel(ids, patterns) {
  const clean = ids.map((id) => id.replace(/^models\//, '')).filter((id) => !/(preview|exp|audio|realtime|tts|image|embedding|search|transcribe|instruct|codex|live)/i.test(id));
  for (const re of patterns) {
    const hits = clean.filter((id) => re.test(id)).sort(byVersionDesc);
    if (hits.length) return hits[0];
  }
  return null;
}

function parseJSONEnv(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { console.warn('[admitiq] ignoring invalid JSON in env'); return fallback; }
}

export function createRouter(env = process.env, { fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onUsage = null, log = console } = {}) {
  const timeoutMs = Number(env.AI_TIMEOUT_MS || 90_000);
  const maxRetries = Number(env.AI_MAX_RETRIES ?? 2);
  const pricing = parseJSONEnv(env.AI_PRICING_JSON, {}); // { "model-id": { "input": USD per 1M tokens, "output": USD per 1M } }
  const monthlyBudget = env.AI_MONTHLY_BUDGET_USD ? Number(env.AI_MONTHLY_BUDGET_USD) : null;
  const planUnits = { ...PLAN_UNITS, ...parseJSONEnv(env.AI_DAILY_UNITS_JSON, {}) };
  const routes = { ...DEFAULT_ROUTES };
  for (const t of TASKS) { const o = env[`AI_ROUTE_${t.toUpperCase()}`]; if (o) routes[t] = o.split(',').map((s) => s.trim()).filter(Boolean); }

  // ---------- provider configuration ----------
  const providers = {};
  if (env.OPENAI_API_KEY) providers.openai = { name: 'openai', kind: 'openai', base: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), key: env.OPENAI_API_KEY, models: { fast: env.OPENAI_MODEL_FAST, main: env.OPENAI_MODEL, reasoning: env.OPENAI_MODEL_REASONING } };
  if (env.GEMINI_API_KEY) providers.gemini = { name: 'gemini', kind: 'gemini', base: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''), key: env.GEMINI_API_KEY, models: { fast: env.GEMINI_MODEL_FAST, main: env.GEMINI_MODEL, grounded: env.GEMINI_RESEARCH_MODEL || env.GEMINI_MODEL } };
  if (env.ANTHROPIC_API_KEY) providers.anthropic = { name: 'anthropic', kind: 'anthropic', base: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, ''), key: env.ANTHROPIC_API_KEY, models: { fast: env.ANTHROPIC_MODEL_FAST, main: env.ANTHROPIC_MODEL, reasoning: env.ANTHROPIC_MODEL_REASONING || env.ANTHROPIC_MODEL } };
  const legacy = COMPAT[(env.AI_PROVIDER || 'none').toLowerCase()];
  if (legacy) {
    const base = (env.AI_BASE_URL || legacy.base).replace(/\/$/, '');
    if (base && (env.AI_API_KEY || legacy.keyless)) providers.compat = { name: 'compat', label: env.AI_PROVIDER.toLowerCase(), kind: legacy.kind, base, key: env.AI_API_KEY || '', models: { main: env.AI_MODEL }, prefer: legacy.prefer };
  }

  const health = new Map();      // provider → { downUntil, lastError }
  const discovered = new Map();  // provider → Promise<string[]>
  const ledger = [];             // recent usage records (bounded)
  const unitsByUserDay = new Map();
  let monthCost = { month: '', usd: 0 };

  const isUp = (p) => (health.get(p)?.downUntil || 0) <= now();
  const markDown = (p, ms, err) => health.set(p, { downUntil: now() + ms, lastError: String(err).slice(0, 300) });

  async function listModels(p) {
    if (!discovered.has(p.name)) {
      const pr = (async () => {
        let url, headers = {};
        if (p.kind === 'gemini') { url = `${p.base}/models?pageSize=200`; headers['x-goog-api-key'] = p.key; }
        else if (p.kind === 'anthropic') { url = `${p.base}/models?limit=100`; headers = { 'x-api-key': p.key, 'anthropic-version': '2023-06-01' }; }
        else { url = `${p.base}/models`; if (p.key) headers.authorization = `Bearer ${p.key}`; }
        const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new AIError(r.status, `Could not list ${p.name} models: ${d?.error?.message || r.status}`);
        return (d.data || d.models || []).filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m) => String(m.id || m.name || '')).filter(Boolean);
      })();
      discovered.set(p.name, pr);
      pr.catch(() => discovered.delete(p.name));
    }
    return discovered.get(p.name);
  }

  async function resolveModel(p, tier) {
    const explicit = p.models[tier] || (tier !== 'main' && p.models.main);
    if (p.models[tier]) return p.models[tier];
    const prefs = p.name === 'compat' ? (p.prefer || [/./]) : (PREFER[p.name]?.[tier] || PREFER[p.name]?.main || [/./]);
    try {
      const m = pickModel(await listModels(p), prefs);
      if (m) return m;
    } catch (e) { if (explicit) return explicit; throw e; }
    if (explicit) return explicit;
    throw new AIError(503, `No ${tier} model could be found for ${p.name}. Set the model in .env.`);
  }

  // ---------- one HTTP call to one provider ----------
  async function callOnce(p, model, tier, { messages, json, maxTokens, temperature }) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const convo = messages.filter((m) => m.role !== 'system');
    const signal = AbortSignal.timeout(timeoutMs);
    let r, d;
    if (p.kind === 'anthropic') {
      r = await fetchImpl(`${p.base}/messages`, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, ...(temperature != null ? { temperature } : {}), system: system + (json ? '\n\nRespond with a single JSON object only, no markdown.' : ''), messages: convo }) });
      d = await r.json().catch(() => ({}));
      if (!r.ok) return { error: errorFrom(r, d) };
      return { text: (d.content || []).map((c) => c.text || '').join(''), usage: { input: d.usage?.input_tokens || 0, output: d.usage?.output_tokens || 0 }, citations: [] };
    }
    if (p.kind === 'gemini') {
      const grounded = tier === 'grounded';
      const body = {
        contents: convo.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        ...(system || (json && grounded) ? { systemInstruction: { parts: [{ text: system + (json && grounded ? '\n\nRespond with a single JSON object only, no markdown.' : '') }] } } : {}),
        ...(grounded ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: { maxOutputTokens: maxTokens, ...(temperature != null ? { temperature } : {}), ...(json && !grounded ? { responseMimeType: 'application/json' } : {}) },
      };
      r = await fetchImpl(`${p.base}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': p.key }, body: JSON.stringify(body) });
      d = await r.json().catch(() => ({}));
      if (!r.ok) return { error: errorFrom(r, d) };
      const cand = d.candidates?.[0] || {};
      const text = (cand.content?.parts || []).map((x) => x.text || '').join('');
      const gm = cand.groundingMetadata || {};
      const citations = (gm.groundingChunks || []).map((c, i) => c.web ? { index: i + 1, title: c.web.title || '', url: c.web.uri || '' } : null).filter(Boolean);
      return { text, usage: { input: d.usageMetadata?.promptTokenCount || 0, output: (d.usageMetadata?.candidatesTokenCount || 0) + (d.usageMetadata?.thoughtsTokenCount || 0) }, citations, grounded: grounded && citations.length > 0, searchQueries: gm.webSearchQueries || [], supports: (gm.groundingSupports || []).map((s) => ({ text: s.segment?.text || '', chunks: (s.groundingChunkIndices || []).map((i) => i + 1) })) };
    }
    // OpenAI and OpenAI-compatible
    const isOpenAI = p.name === 'openai';
    const send = async (withFormat) => {
      const msgs = json && !withFormat ? [...messages.slice(0, -1), { ...messages[messages.length - 1], content: messages[messages.length - 1].content + '\n\nRespond with a single JSON object only, no markdown.' }] : messages;
      const body = { model, messages: msgs, ...(isOpenAI ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens, temperature: temperature ?? 0.3 }), ...(json && withFormat ? { response_format: { type: 'json_object' } } : {}) };
      const res = await fetchImpl(`${p.base}/chat/completions`, { method: 'POST', signal, headers: { 'content-type': 'application/json', ...(p.key ? { authorization: `Bearer ${p.key}` } : {}) }, body: JSON.stringify(body) });
      return { res, data: await res.json().catch(() => ({})) };
    };
    ({ res: r, data: d } = await send(json));
    if (!r.ok && json && /response_format|json/i.test(JSON.stringify(d?.error || ''))) ({ res: r, data: d } = await send(false));
    if (!r.ok) return { error: errorFrom(r, d) };
    const text = String(d.choices?.[0]?.message?.content || '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
    return { text, usage: { input: d.usage?.prompt_tokens || 0, output: d.usage?.completion_tokens || 0 }, citations: [] };
  }

  function errorFrom(r, d) {
    const msg = String(d?.error?.message || d?.[0]?.error?.message || d?.message || `HTTP ${r.status}`);
    return { status: r.status, message: msg, retryAfter: Number(r.headers?.get?.('retry-after')) || 0 };
  }

  function costOf(model, usage) {
    const p = pricing[model];
    if (!p) return null;
    return +(((usage.input * (p.input || 0)) + (usage.output * (p.output || 0))) / 1e6).toFixed(6);
  }

  function record(entry) {
    ledger.push(entry);
    if (ledger.length > 5000) ledger.splice(0, ledger.length - 5000);
    const month = new Date(entry.at).toISOString().slice(0, 7);
    if (monthCost.month !== month) monthCost = { month, usd: 0 };
    if (entry.cost) monthCost.usd += entry.cost;
    if (onUsage) Promise.resolve(onUsage(entry)).catch((e) => log.warn?.('[admitiq] usage sink failed:', e.message));
  }

  // ---------- quotas ----------
  function quotaKey(user) { return `${user?.id || `ip:${user?.ip || 'local'}`}|${new Date(now()).toISOString().slice(0, 10)}`; }
  function checkQuota(task, user) {
    const plan = user?.plan || (user?.id ? 'free' : 'anonymous');
    if (!planAllows(plan, task)) throw new AIError(402, `This feature needs a higher plan (current: ${plan}).`, { code: 'plan_required', plan, task });
    const limit = planUnits[plan] ?? planUnits.free;
    const used = unitsByUserDay.get(quotaKey(user)) || 0;
    const cost = TASK_UNITS[task] || 1;
    if (used + cost > limit) throw new AIError(429, `Daily AI limit reached for the ${plan} plan (${limit} units). It resets at midnight UTC.`, { code: 'quota', plan, limit, used });
    if (monthlyBudget != null && monthCost.month === new Date(now()).toISOString().slice(0, 7) && monthCost.usd >= monthlyBudget && task !== 'chat')
      throw new AIError(503, 'The monthly AI budget for this server has been reached. Basic chat still works.', { code: 'budget' });
    return { plan, cost };
  }
  function chargeQuota(user, units) { const k = quotaKey(user); unitsByUserDay.set(k, (unitsByUserDay.get(k) || 0) + units); }
  function remaining(user) {
    const plan = user?.plan || (user?.id ? 'free' : 'anonymous');
    const limit = planUnits[plan] ?? planUnits.free;
    return { plan, limit, used: unitsByUserDay.get(quotaKey(user)) || 0 };
  }

  function candidates(task, { avoid } = {}) {
    const list = (routes[task] || routes.chat).map((s) => { const [prov, tier = 'main'] = s.split(':'); return { prov, tier }; });
    return list.filter(({ prov }) => providers[prov] && prov !== avoid);
  }

  /**
   * Run one AI task. Returns { text, provider, model, tier, usage, cost, citations, grounded, attempts }.
   * messages: [{ role: 'system'|'user'|'assistant', content }]
   */
  async function run({ task = 'chat', messages, json = false, maxTokens, temperature, user, avoid, skipQuota = false }) {
    if (!TASKS.includes(task)) throw new AIError(400, `Unknown AI task "${task}"`);
    if (!Array.isArray(messages) || !messages.length) throw new AIError(400, 'messages must be a non-empty array');
    const q = skipQuota ? { cost: 0 } : checkQuota(task, user);
    let list = candidates(task, { avoid });
    if (!list.length) throw new AIError(503, avoid ? 'No second AI provider is configured for verification.' : 'No AI provider is configured on this server.', { code: 'unconfigured' });
    // Long prompts on the cheap tier are escalated to the main tier of the same provider.
    const chars = messages.reduce((n, m) => n + String(m.content).length, 0);
    if (task === 'chat' && chars > Number(env.AI_ESCALATE_CHARS || 16000)) list = list.map((c) => (c.tier === 'fast' ? { ...c, tier: 'main' } : c));
    const tokens = maxTokens || { chat: 1200, analysis: 2500, essay: 3000, simulation: 4000, research: 2000, long_document: 4000, verify: 1500 }[task];
    const attempts = [];
    const ordered = [...list.filter((c) => isUp(c.prov)), ...list.filter((c) => !isUp(c.prov))]; // healthy first, but never zero options
    for (const { prov, tier } of ordered) {
      const p = providers[prov];
      let model;
      try { model = await resolveModel(p, tier); } catch (e) { attempts.push({ provider: prov, tier, error: e.message }); continue; }
      for (let i = 0; i <= maxRetries; i++) {
        const started = now();
        let out;
        try { out = await callOnce(p, model, tier, { messages, json, maxTokens: tokens, temperature }); }
        catch (e) { out = { error: { status: e.name === 'TimeoutError' ? 504 : 502, message: e.message } }; }
        if (!out.error) {
          const cost = costOf(model, out.usage);
          const entry = { at: now(), task, provider: prov === 'compat' ? p.label : prov, model, tier, input: out.usage.input, output: out.usage.output, cost, ms: now() - started, userId: user?.id || null, ok: true };
          record(entry);
          if (!skipQuota) chargeQuota(user, q.cost);
          health.delete(prov);
          return { text: out.text, provider: entry.provider, model, tier, usage: out.usage, cost, citations: out.citations || [], grounded: !!out.grounded, searchQueries: out.searchQueries || [], supports: out.supports || [], attempts };
        }
        const { status, message, retryAfter } = out.error;
        attempts.push({ provider: prov, model, tier, status, error: message.slice(0, 200) });
        record({ at: now(), task, provider: prov, model, tier, input: 0, output: 0, cost: 0, ms: now() - started, userId: user?.id || null, ok: false, status });
        if (status === 401 || status === 403) { markDown(prov, 10 * 60_000, message); break; }
        if (status === 404 || /model/i.test(message) && status === 400) { discovered.delete(prov); break; }
        if (!RETRYABLE.has(status) || i === maxRetries) { if (RETRYABLE.has(status)) markDown(prov, 30_000, message); break; }
        await sleep(Math.min(8000, retryAfter ? retryAfter * 1000 : 500 * 2 ** i));
      }
    }
    throw new AIError(502, `All configured AI providers failed: ${attempts.map((a) => `${a.provider}${a.status ? ` ${a.status}` : ''}: ${a.error}`).join(' | ')}`, { attempts });
  }

  /**
   * Streaming variant. Calls onDelta(textChunk) as tokens arrive. Falls back to the next provider only
   * if nothing has been streamed yet. Resolves with the same shape as run().
   */
  async function stream({ task = 'chat', messages, maxTokens, user }, onDelta) {
    if (!TASKS.includes(task)) throw new AIError(400, `Unknown AI task "${task}"`);
    const q = checkQuota(task, user);
    const list = candidates(task);
    if (!list.length) throw new AIError(503, 'No AI provider is configured on this server.', { code: 'unconfigured' });
    const tokens = maxTokens || 2000;
    const attempts = [];
    for (const { prov, tier } of list) {
      if (tier === 'grounded') continue; // grounded research returns citations as a whole, use run()
      const p = providers[prov];
      let model;
      try { model = await resolveModel(p, tier); } catch (e) { attempts.push({ provider: prov, error: e.message }); continue; }
      const started = now();
      let streamed = '', usage = { input: 0, output: 0 };
      try {
        const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const convo = messages.filter((m) => m.role !== 'system');
        let res;
        if (p.kind === 'anthropic') {
          res = await fetchImpl(`${p.base}/messages`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: tokens, system, messages: convo, stream: true }) });
        } else if (p.kind === 'gemini') {
          res = await fetchImpl(`${p.base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', 'x-goog-api-key': p.key }, body: JSON.stringify({ contents: convo.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })), ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), generationConfig: { maxOutputTokens: tokens } }) });
        } else {
          const isOpenAI = p.name === 'openai';
          res = await fetchImpl(`${p.base}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', ...(p.key ? { authorization: `Bearer ${p.key}` } : {}) }, body: JSON.stringify({ model, messages, stream: true, ...(isOpenAI ? { max_completion_tokens: tokens, stream_options: { include_usage: true } } : { max_tokens: tokens }) }) });
        }
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new AIError(res.status, String(d?.error?.message || res.status)); }
        for await (const evt of sseEvents(res.body)) {
          if (evt === '[DONE]') break;
          let j; try { j = JSON.parse(evt); } catch { continue; }
          let piece = '';
          if (p.kind === 'anthropic') {
            if (j.type === 'content_block_delta') piece = j.delta?.text || '';
            if (j.type === 'message_start') usage.input = j.message?.usage?.input_tokens || 0;
            if (j.type === 'message_delta') usage.output = j.usage?.output_tokens || usage.output;
            if (j.type === 'error') throw new AIError(502, j.error?.message || 'stream error');
          } else if (p.kind === 'gemini') {
            piece = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
            if (j.usageMetadata) usage = { input: j.usageMetadata.promptTokenCount || 0, output: j.usageMetadata.candidatesTokenCount || 0 };
          } else {
            piece = j.choices?.[0]?.delta?.content || '';
            if (j.usage) usage = { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
          }
          if (piece) { streamed += piece; onDelta(piece); }
        }
        const cost = costOf(model, usage);
        record({ at: now(), task, provider: prov === 'compat' ? p.label : prov, model, tier, input: usage.input, output: usage.output, cost, ms: now() - started, userId: user?.id || null, ok: true, stream: true });
        chargeQuota(user, q.cost);
        return { text: streamed, provider: prov === 'compat' ? p.label : prov, model, tier, usage, cost, citations: [], attempts };
      } catch (e) {
        attempts.push({ provider: prov, model, status: e.status, error: e.message });
        record({ at: now(), task, provider: prov, model, tier, input: 0, output: 0, cost: 0, ms: now() - started, userId: user?.id || null, ok: false, status: e.status || 502, stream: true });
        if (streamed) throw new AIError(502, `The AI response was interrupted: ${e.message}`, { partial: streamed, attempts });
        if (e.status === 401 || e.status === 403) markDown(prov, 10 * 60_000, e.message);
      }
    }
    throw new AIError(502, `All configured AI providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join(' | ')}`, { attempts });
  }

  /** Ask a different provider to check an answer against its sources. */
  async function verify({ question, answer, sources = [], usedProvider, user }) {
    const ctx = sources.map((s, i) => `[${i + 1}] ${s.title || ''} ${s.url || ''}\n${(s.text || s.snippet || '').slice(0, 1500)}`).join('\n\n');
    const res = await run({ task: 'verify', avoid: usedProvider, user, json: true, skipQuota: true, messages: [
      { role: 'system', content: 'You are a fact-checker. Compare the ANSWER with the SOURCES. Return JSON {"verdict":"supported"|"partially_supported"|"unsupported","issues":[{"claim":string,"problem":string}],"notes":string}. Only judge claims against the sources given; if the sources do not cover a claim, list it as unsupported. Do not add new facts.' },
      { role: 'user', content: `QUESTION: ${question}\n\nANSWER:\n${answer}\n\nSOURCES:\n${ctx || '(none)'}` },
    ] });
    try { return { ...JSON.parse(res.text.replace(/^```json\s*|```\s*$/g, '')), provider: res.provider, model: res.model }; }
    catch { return { verdict: 'unknown', issues: [], notes: res.text.slice(0, 500), provider: res.provider, model: res.model }; }
  }

  function status() {
    return {
      providers: Object.fromEntries(Object.values(providers).map((p) => [p.name === 'compat' ? `compat:${p.label}` : p.name, { configured: true, models: Object.fromEntries(Object.entries(p.models).filter(([, v]) => v)), healthy: isUp(p.name), lastError: health.get(p.name)?.lastError || null }])),
      routes, pricingConfigured: Object.keys(pricing).length, monthlyBudget, monthCost: monthCost.usd, planUnits,
    };
  }

  function usageSummary({ sinceMs = 24 * 3600_000 } = {}) {
    const since = now() - sinceMs;
    const rows = ledger.filter((e) => e.at >= since);
    const group = (k) => Object.entries(rows.reduce((m, e) => { const key = e[k] ?? 'unknown'; const g = (m[key] ||= { requests: 0, failures: 0, input: 0, output: 0, cost: 0, unpriced: 0 }); g.requests++; if (!e.ok) g.failures++; g.input += e.input; g.output += e.output; if (e.cost == null && e.ok) g.unpriced++; else g.cost += e.cost || 0; return m; }, {})).map(([key, v]) => ({ key, ...v, cost: +v.cost.toFixed(4) }));
    return { since: new Date(since).toISOString(), requests: rows.length, byProvider: group('provider'), byModel: group('model'), byTask: group('task'), recentErrors: rows.filter((e) => !e.ok).slice(-20) };
  }

  return { run, stream, verify, status, usageSummary, remaining, configured: () => Object.keys(providers), hasProvider: (n) => !!providers[n], _providers: providers };
}

/** Parse a fetch() body stream as Server-Sent Events, yielding each `data:` payload. */
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
  const tail = buf.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
  if (tail) yield tail;
}
