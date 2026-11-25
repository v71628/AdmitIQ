// End-to-end: boots server/server.mjs against local mock AI + Supabase + Stripe-signed webhooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('server: AI routes, streaming, quotas, health, Stripe webhook', async (t) => {
  const seen = [];
  const mock = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    seen.push({ url: req.url, body: j });
    if (req.url === '/v1/chat/completions' && j.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const w of ['Strong ', 'profile.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      return res.end();
    }
    if (req.url === '/v1/chat/completions') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { content: `ok:${j.model}` } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); }
    if (req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] })); }
    // Supabase mock
    if (req.url.startsWith('/auth/v1/user')) {
      if (req.headers.authorization === 'Bearer good') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'user-1', email: 'admin@example.com' })); }
      res.writeHead(401); return res.end('{}');
    }
    if (req.url.startsWith('/rest/v1/subscriptions?user_id')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify([{ plan: 'pro', status: 'active', current_period_end: new Date(Date.now() + 864e5).toISOString() }])); }
    if (req.url.startsWith('/rest/v1/')) { res.writeHead(201); return res.end(''); }
    res.writeHead(404); res.end('{}');
  });
  const mockPort = await listen(mock);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const whsec = 'whsec_test';
  const child = spawn(process.execPath, ['server/server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`, OPENAI_MODEL: 'gpt-test', SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: whsec, STRIPE_PRICE_PRO_MONTHLY: 'price_pro_m', ADMIN_EMAILS: 'admin@example.com', AI_DAILY_UNITS_JSON: '{"anonymous":3}', RATE_LIMIT_PER_MIN: '1000', AI_PROVIDER: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); mock.close(); });
  await new Promise((resolve, reject) => { child.stdout.on('data', (d) => /running at/.test(d) && resolve()); child.stderr.on('data', (d) => process.stderr.write(d)); child.on('exit', (c) => reject(new Error('server exited ' + c))); });
  const base = `http://127.0.0.1:${port}`;
  const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  const health = await fetch(base + '/api/health').then((r) => r.json());
  assert.deepEqual(health.ai.providers, ['openai']);
  assert.equal(health.billing, true);
  assert.equal(health.research.library, true);

  const r1 = await post('/api/ai', { task: 'chat', messages: [{ role: 'user', content: 'hi' }] }).then((r) => r.json());
  assert.equal(r1.text, 'ok:gpt-test');
  assert.equal(r1.remaining.plan, 'anonymous');

  // Anonymous users cannot run a committee simulation (Pro feature)…
  const r2 = await post('/api/ai', { task: 'simulation', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r2.status, 402);
  // …a signed-in Pro user can.
  const r3 = await post('/api/ai', { task: 'simulation', messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer good' }).then((r) => r.json());
  assert.equal(r3.text, 'ok:gpt-test');
  assert.equal(r3.remaining.plan, 'pro');
  // Expired token → 401
  assert.equal((await post('/api/ai', { messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer bad' })).status, 401);

  // Streaming over SSE
  const txt = await post('/api/ai/stream', { messages: [{ role: 'user', content: 'x' }] }).then((r) => r.text());
  const deltas = [...txt.matchAll(/event: delta\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]).text).join('');
  assert.equal(deltas, 'Strong profile.');
  assert.match(txt, /event: done/);

  // Anonymous daily quota (3 units): 1 used by chat, 1 by stream → 1 left, then 429
  assert.equal((await post('/api/ai', { messages: [{ role: 'user', content: 'x' }] })).status, 200);
  const r4 = await post('/api/ai', { messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r4.status, 429);
  assert.equal((await r4.json()).code, 'quota');

  // Admin endpoint
  assert.equal((await post('/api/admin/status', {})).status, 403);
  const admin = await post('/api/admin/status', {}, { authorization: 'Bearer good' }).then((r) => r.json());
  assert.ok(admin.usage24h.requests >= 4);

  // Stripe webhook: bad signature rejected, good signature upserts the subscription
  const evt = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { user_id: 'user-1' }, items: { data: [{ price: { id: 'price_pro_m' }, current_period_end: Math.floor(Date.now() / 1000) + 86400 }] } } } });
  assert.equal((await post('/api/billing/webhook', evt, { 'stripe-signature': 't=1,v1=deadbeef' })).status, 400);
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', whsec).update(`${ts}.${evt}`).digest('hex');
  const wh = await post('/api/billing/webhook', evt, { 'stripe-signature': `t=${ts},v1=${sig}` }).then((r) => r.json());
  assert.deepEqual(wh, { handled: true, type: 'customer.subscription.updated', userId: 'user-1' });
  const upsert = seen.find((s) => s.url.startsWith('/rest/v1/subscriptions?on_conflict'));
  assert.equal(upsert.body[0].plan, 'pro');
  assert.equal(upsert.body[0].period, 'monthly');
  // Usage rows were written to Supabase
  assert.ok(seen.some((s) => s.url.startsWith('/rest/v1/ai_usage')));
  // Secrets never leak through /api/health
  assert.doesNotMatch(JSON.stringify(health), /sk-test|service|whsec/);
});
