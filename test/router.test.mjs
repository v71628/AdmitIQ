// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, pickModel, byVersionDesc, sseEvents } from '../server/ai/router.mjs';

const jsonRes = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const sseRes = (events) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

function mockFetch(handlers) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    for (const [re, fn] of handlers) if (re.test(String(url))) return fn(String(url), init.body ? JSON.parse(init.body) : null, calls.length);
    return jsonRes(404, { error: { message: 'no mock for ' + url } });
  };
  f.calls = calls;
  return f;
}
const noSleep = async () => {};
const quiet = { warn() {}, log() {} };

test('version sort and model picking prefer the newest stable model', () => {
  assert.deepEqual(['gpt-4o', 'gpt-5', 'gpt-5.1', 'gpt-4.1'].sort(byVersionDesc), ['gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o']);
  assert.equal(pickModel(['gpt-5-mini', 'gpt-5.1-mini', 'gpt-5.1', 'gpt-5.1-mini-preview'], [/^gpt-\d+(\.\d+)?-mini$/]), 'gpt-5.1-mini');
  assert.equal(pickModel(['models/gemini-2.0-flash', 'models/gemini-2.5-flash', 'models/gemini-2.5-flash-preview-05'], [/^gemini-[\d.]+-flash$/]), 'gemini-2.5-flash');
});

test('no providers → 503 unconfigured', async () => {
  const r = createRouter({}, { fetchImpl: mockFetch([]), log: quiet });
  await assert.rejects(r.run({ task: 'chat', messages: [{ role: 'user', content: 'hi' }] }), (e) => e.status === 503 && e.code === 'unconfigured');
});

test('chat routes to the OpenAI fast tier and records usage and cost', async () => {
  const f = mockFetch([[/openai\.test\/v1\/chat\/completions/, (u, b) => jsonRes(200, { choices: [{ message: { content: `hello from ${b.model}` } }], usage: { prompt_tokens: 100, completion_tokens: 50 } })]]);
  const r = createRouter({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://openai.test/v1', OPENAI_MODEL: 'main-x', OPENAI_MODEL_FAST: 'fast-x', AI_PRICING_JSON: '{"fast-x":{"input":1,"output":2}}' }, { fetchImpl: f, sleep: noSleep, log: quiet });
  const out = await r.run({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], user: { id: 'u1', plan: 'free' } });
  assert.equal(out.text, 'hello from fast-x');
  assert.equal(out.provider, 'openai');
  assert.equal(out.cost, 0.0002); // (100*1 + 50*2)/1e6
  assert.equal(f.calls[0].body.max_completion_tokens > 0, true);
  assert.equal('temperature' in f.calls[0].body, false, 'OpenAI calls omit temperature (reasoning models reject it)');
  const s = r.usageSummary();
  assert.equal(s.requests, 1);
  assert.equal(s.byModel[0].key, 'fast-x');
  assert.equal(r.remaining({ id: 'u1', plan: 'free' }).used, 1);
});

test('research uses Gemini with Google Search grounding and returns citations', async () => {
  const f = mockFetch([[/gemini\.test\/v1beta\/models\/g-flash:generateContent/, (u, b) => {
    assert.deepEqual(b.tools, [{ google_search: {} }]);
    return jsonRes(200, { candidates: [{ content: { parts: [{ text: 'MIT is test-required.' }] }, groundingMetadata: { webSearchQueries: ['mit sat policy'], groundingChunks: [{ web: { uri: 'https://mitadmissions.org/x', title: 'mitadmissions.org' } }], groundingSupports: [{ segment: { text: 'MIT is test-required.' }, groundingChunkIndices: [0] }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 } });
  }]]);
  const r = createRouter({ GEMINI_API_KEY: 'g', GEMINI_BASE_URL: 'https://gemini.test/v1beta', GEMINI_MODEL: 'g-flash', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm' }, { fetchImpl: f, sleep: noSleep, log: quiet });
  const out = await r.run({ task: 'research', messages: [{ role: 'user', content: 'Does MIT require the SAT?' }], user: { id: 'u', plan: 'free' } });
  assert.equal(out.provider, 'gemini');
  assert.equal(out.grounded, true);
  assert.equal(out.citations[0].url, 'https://mitadmissions.org/x');
  assert.deepEqual(out.supports[0].chunks, [1]);
  assert.equal(f.calls[0].headers['x-goog-api-key'], 'g');
});

test('retries a 429 then falls back to the next provider on repeated 5xx', async () => {
  let n = 0;
  const f = mockFetch([
    [/openai\.test/, () => { n++; return n === 1 ? jsonRes(429, { error: { message: 'rate' } }) : jsonRes(503, { error: { message: 'overloaded' } }); }],
    [/anthropic\.test\/v1\/messages/, () => jsonRes(200, { content: [{ type: 'text', text: 'claude answer' }], usage: { input_tokens: 5, output_tokens: 7 } })],
  ]);
  const r = createRouter({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://openai.test/v1', OPENAI_MODEL: 'm', ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'https://anthropic.test/v1', ANTHROPIC_MODEL: 'c', AI_MAX_RETRIES: '2' }, { fetchImpl: f, sleep: noSleep, log: quiet });
  const out = await r.run({ task: 'essay', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'review' }], user: { id: 'u', plan: 'plus' } });
  assert.equal(out.text, 'claude answer');
  assert.equal(out.attempts.length, 3);
  const anthropicCall = f.calls.find((c) => /anthropic/.test(c.url));
  assert.equal(anthropicCall.body.system, 'sys');
  assert.equal(anthropicCall.body.messages.length, 1);
  assert.equal(r.status().providers.openai.healthy, false);
});

test('401 marks a provider down without retrying', async () => {
  const f = mockFetch([[/openai\.test/, () => jsonRes(401, { error: { message: 'bad key' } })]]);
  const r = createRouter({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://openai.test/v1', OPENAI_MODEL: 'm' }, { fetchImpl: f, sleep: noSleep, log: quiet });
  await assert.rejects(r.run({ task: 'chat', messages: [{ role: 'user', content: 'x' }] }), (e) => e.status === 502);
  assert.equal(f.calls.filter((c) => /chat\/completions/.test(c.url)).length, 1);
});

test('plan gating and daily quotas', async () => {
  const f = mockFetch([[/openai\.test/, () => jsonRes(200, { choices: [{ message: { content: 'ok' } }], usage: {} })]]);
  const r = createRouter({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://openai.test/v1', OPENAI_MODEL: 'm', AI_DAILY_UNITS_JSON: '{"anonymous":2}' }, { fetchImpl: f, sleep: noSleep, log: quiet });
  await assert.rejects(r.run({ task: 'simulation', messages: [{ role: 'user', content: 'x' }], user: { id: 'u', plan: 'free' } }), (e) => e.status === 402 && e.code === 'plan_required');
  const anon = { ip: '1.2.3.4' };
  await r.run({ task: 'chat', messages: [{ role: 'user', content: 'x' }], user: anon });
  await r.run({ task: 'chat', messages: [{ role: 'user', content: 'x' }], user: anon });
  await assert.rejects(r.run({ task: 'chat', messages: [{ role: 'user', content: 'x' }], user: anon }), (e) => e.status === 429 && e.code === 'quota');
});

test('model discovery when no model env var is set', async () => {
  const f = mockFetch([
    [/openai\.test\/v1\/models/, () => jsonRes(200, { data: [{ id: 'gpt-4o-mini' }, { id: 'gpt-5-mini' }, { id: 'gpt-5.1-mini' }, { id: 'gpt-5.1' }] })],
    [/openai\.test\/v1\/chat/, (u, b) => jsonRes(200, { choices: [{ message: { content: b.model } }], usage: {} })],
  ]);
  const r = createRouter({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://openai.test/v1' }, { fetchImpl: f, sleep: noSleep, log: quiet });
  assert.equal((await r.run({ task: 'chat', messages: [{ role: 'user', content: 'x' }] })).text, 'gpt-5.1-mini');
  assert.equal((await r.run({ task: 'analysis', messages: [{ role: 'user', content: 'x' }], user: { id: 'u' } })).text, 'gpt-5.1');
});

test('legacy AI_PROVIDER configuration still works', async () => {
  const f = mockFetch([[/groq\.test\/chat/, (u, b) => jsonRes(200, { choices: [{ message: { content: '<think>hmm</think>answer' } }], usage: {} })]]);
  const r = createRouter({ AI_PROVIDER: 'groq', AI_API_KEY: 'x', AI_BASE_URL: 'https://groq.test', AI_MODEL: 'llama' }, { fetchImpl: f, sleep: noSleep, log: quiet });
  const out = await r.run({ task: 'chat', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(out.text, 'answer');
  assert.equal(out.provider, 'groq');
});

test('streaming from OpenAI-compatible and Anthropic SSE', async () => {
  const f = mockFetch([
    [/openai\.test/, () => sseRes([{ choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] }, { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }, '[DONE]'])],
    [/anthropic\.test/, () => sseRes([{ type: 'message_start', message: { usage: { input_tokens: 4 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }, { type: 'message_delta', usage: { output_tokens: 1 } }, { type: 'message_stop' }])],
  ]);
  const r1 = createRouter({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://openai.test/v1', OPENAI_MODEL: 'm' }, { fetchImpl: f, log: quiet });
  let got = '';
  const o1 = await r1.stream({ task: 'chat', messages: [{ role: 'user', content: 'x' }] }, (d) => { got += d; });
  assert.equal(got, 'Hello');
  assert.deepEqual(o1.usage, { input: 3, output: 2 });
  const r2 = createRouter({ ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'https://anthropic.test/v1', ANTHROPIC_MODEL: 'c' }, { fetchImpl: f, log: quiet });
  let got2 = '';
  const o2 = await r2.stream({ task: 'chat', messages: [{ role: 'user', content: 'x' }] }, (d) => { got2 += d; });
  assert.equal(got2, 'Hi');
  assert.deepEqual(o2.usage, { input: 4, output: 1 });
});

test('verification uses a different provider than the answer', async () => {
  const f = mockFetch([
    [/anthropic\.test/, () => jsonRes(200, { content: [{ text: '{"verdict":"supported","issues":[],"notes":"ok"}' }], usage: { input_tokens: 1, output_tokens: 1 } })],
    [/openai\.test/, () => jsonRes(500, { error: { message: 'should not be called' } })],
  ]);
  const r = createRouter({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://openai.test/v1', OPENAI_MODEL: 'm', ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'https://anthropic.test/v1', ANTHROPIC_MODEL: 'c' }, { fetchImpl: f, sleep: noSleep, log: quiet });
  const v = await r.verify({ question: 'q', answer: 'a', sources: [{ title: 't', url: 'https://x.edu', text: 'a' }], usedProvider: 'openai' });
  assert.equal(v.verdict, 'supported');
  assert.equal(v.provider, 'anthropic');
  assert.ok(f.calls.every((c) => !/openai/.test(c.url)));
});

test('sseEvents handles split chunks and CRLF', async () => {
  const enc = new TextEncoder();
  const body = new ReadableStream({ start(c) { c.enqueue(enc.encode('data: {"a":')); c.enqueue(enc.encode('1}\r\n\r\ndata: [DONE]\r\n\r\n')); c.close(); } });
  const out = [];
  for await (const e of sseEvents(body)) out.push(e);
  assert.deepEqual(out, ['{"a":1}', '[DONE]']);
});
