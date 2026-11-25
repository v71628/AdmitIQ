#!/usr/bin/env node
// Link-checks, extracts and embeds source-library records. Polite by design: robots.txt is honored,
// each host gets at most one request per second, and pages behind logins/paywalls are skipped.
//
//   npm run sources:verify                      # link-check up to 2,000 unchecked/stale sources
//   npm run sources:verify -- --limit=10000 --concurrency=12
//   npm run sources:verify -- --extract         # also store page text + chunks for official pages
//   npm run sources:verify -- --embed           # embed chunks that have no embedding yet (needs OPENAI_API_KEY + 0003_pgvector.sql)
//
// Verification states: listed (not yet checked) → link_ok | link_redirected | link_broken; content_extracted after --extract.
// A 401/403/429 is NOT treated as broken (many sites block bots); the record stays "listed" with its HTTP status.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkText } from './transform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const line of (fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const env = process.env;
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const SB = env.SUPABASE_URL?.replace(/\/$/, ''), KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env'); process.exit(1); }
const UA = `AdmitIQ-verify/2.0 (${env.ADMITIQ_CONTACT || 'set ADMITIQ_CONTACT'})`;
const LIMIT = Number(args.limit || 2000), CONC = Number(args.concurrency || 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sb(q, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${SB}/rest/v1/${q}`, { method, headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...(prefer ? { prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); if (!r.ok) throw new Error(`Supabase ${r.status}: ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null;
}

const robots = new Map(), lastHit = new Map();
async function allowed(u) {
  const { origin, pathname } = new URL(u);
  if (!robots.has(origin)) {
    const rules = [];
    try {
      const r = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
      if (r.ok) { let applies = false; for (const raw of (await r.text()).split('\n')) { const line = raw.split('#')[0].trim(); const i = line.indexOf(':'); if (i < 0) continue; const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim(); if (k === 'user-agent') applies = v === '*' || /admitiq/i.test(v); else if (applies && k === 'disallow' && v) rules.push(v); } }
    } catch { /* unreachable robots.txt → allowed */ }
    robots.set(origin, rules);
  }
  return !robots.get(origin).some((p) => pathname.startsWith(p));
}
async function polite(host) { const wait = 1000 - (Date.now() - (lastHit.get(host) || 0)); if (wait > 0) await sleep(wait); lastHit.set(host, Date.now()); }

async function check(s) {
  const u = new URL(s.url);
  if (!(await allowed(s.url))) return { verification: s.verification, http_status: null, note: 'robots' };
  await polite(u.host);
  let r;
  try {
    r = await fetch(s.url, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
    if ([400, 403, 405, 501].includes(r.status)) { await polite(u.host); r = await fetch(s.url, { method: 'GET', redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(25_000) }); }
  } catch (e) { return { verification: 'link_broken', http_status: null, note: e.cause?.code || e.message }; }
  const finalHost = (() => { try { return new URL(r.url).host.replace(/^www\./, ''); } catch { return u.host; } })();
  const lm = r.headers.get('last-modified');
  const base = { http_status: r.status, last_modified: lm && !Number.isNaN(Date.parse(lm)) ? new Date(lm).toISOString() : null };
  if (r.ok) return { ...base, verification: finalHost !== u.host.replace(/^www\./, '') ? 'link_redirected' : 'link_ok', last_verified_at: new Date().toISOString() };
  if ([404, 410].includes(r.status)) return { ...base, verification: 'link_broken' };
  return { ...base, verification: s.verification }; // 401/403/429/5xx: inconclusive
}

async function extract(s) {
  if (!(await allowed(s.url))) return { extraction: 'skipped_robots' };
  await polite(new URL(s.url).host);
  const r = await fetch(s.url, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,text/plain' }, signal: AbortSignal.timeout(25_000) }).catch(() => null);
  if (!r || !r.ok) return { extraction: 'failed' };
  const ct = r.headers.get('content-type') || '';
  if (!/text\/html|text\/plain/.test(ct)) return { extraction: 'skipped_type' };
  const html = (await r.text()).slice(0, 1_500_000);
  if (/paywall|subscribe to (read|continue)|sign in to continue/i.test(html.slice(0, 20000))) return { extraction: 'skipped_type' };
  const title = (html.match(/<title[^>]*>([^<]{3,200})<\/title>/i) || [])[1]?.trim();
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>|<header[\s\S]*?<\/header>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length < 200) return { extraction: 'failed' };
  return { extraction: 'extracted', extracted_text: text.slice(0, 100_000), page_title: title };
}

async function pool(items, n, fn) { let i = 0; const workers = Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }); await Promise.all(workers); }

const counts = { checked: 0, link_ok: 0, link_redirected: 0, link_broken: 0, inconclusive: 0, extracted: 0, chunks: 0, embedded: 0 };
const cutoff = new Date(Date.now() - 180 * 864e5).toISOString();
const todo = await sb(`sources?select=id,url,verification,category,reliability_tier&or=(verification.eq.listed,verification.eq.stale,last_verified_at.lt.${cutoff})&order=reliability_tier.asc,created_at.asc&limit=${LIMIT}`);
console.log(`Checking ${todo.length} source links (concurrency ${CONC}, 1 req/s per host)…`);
await pool(todo, CONC, async (s) => {
  const res = await check(s).catch((e) => ({ verification: s.verification, note: e.message }));
  counts.checked++;
  if (res.verification === s.verification) counts.inconclusive++; else counts[res.verification] = (counts[res.verification] || 0) + 1;
  const patch = { http_status: res.http_status ?? null, updated_at: new Date().toISOString(), verification: res.verification };
  if (res.last_verified_at) { patch.last_verified_at = res.last_verified_at; patch.stale_after = new Date(Date.now() + (/admissions|financial|affordability|tuition/.test(s.category) ? 180 : 365) * 864e5).toISOString().slice(0, 10); }
  if (res.last_modified) patch.last_modified = res.last_modified;
  await sb(`sources?id=eq.${s.id}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' }).catch((e) => console.warn('patch failed', e.message));
  if (counts.checked % 250 === 0) console.log(`  …${counts.checked}/${todo.length}`, JSON.stringify(counts));
});

if (args.extract) {
  const rows = await sb(`sources?select=id,url,category&reliability_tier=eq.1&verification=in.(link_ok,link_redirected)&extraction=eq.not_started&source_type=eq.official_institution_page&limit=${LIMIT}`);
  console.log(`Extracting text from ${rows.length} official pages…`);
  await pool(rows, CONC, async (s) => {
    const ex = await extract(s).catch(() => ({ extraction: 'failed' }));
    const patch = { extraction: ex.extraction, updated_at: new Date().toISOString() };
    if (ex.extracted_text) { patch.extracted_text = ex.extracted_text; patch.verification = 'content_extracted'; patch.last_verified_at = new Date().toISOString(); counts.extracted++; }
    await sb(`sources?id=eq.${s.id}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' }).catch(() => {});
    if (ex.extracted_text) {
      const chunks = chunkText(ex.extracted_text).slice(0, 40).map((content, i) => ({ source_id: s.id, chunk_index: i, content, token_estimate: Math.ceil(content.length / 4) }));
      await sb('source_chunks?on_conflict=source_id,chunk_index', { method: 'POST', body: chunks, prefer: 'resolution=merge-duplicates,return=minimal' }).catch(() => {});
      counts.chunks += chunks.length;
    }
  });
}

if (args.embed) {
  if (!env.OPENAI_API_KEY) { console.error('--embed needs OPENAI_API_KEY'); process.exit(1); }
  const model = env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
  for (;;) {
    const rows = await sb('source_chunks?select=id,content&embedding=is.null&limit=96');
    if (!rows.length) break;
    const r = await fetch(`${(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/embeddings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: JSON.stringify({ model, input: rows.map((x) => x.content) }) });
    const d = await r.json();
    if (!r.ok) { console.error('Embedding error:', d?.error?.message || r.status); break; }
    for (let i = 0; i < rows.length; i++) await sb(`source_chunks?id=eq.${rows[i].id}`, { method: 'PATCH', body: { embedding: JSON.stringify(d.data[i].embedding), embedding_model: model }, prefer: 'return=minimal' });
    counts.embedded += rows.length;
    console.log(`  …embedded ${counts.embedded}`);
  }
}

console.log('\n=== Verification report ===\n' + JSON.stringify(counts, null, 2));
console.log('Library:', JSON.stringify(await sb('rpc/source_library_stats', { method: 'POST', body: {} })));
