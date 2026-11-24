#!/usr/bin/env node
// AdmitIQ server — zero dependencies (Node 18+).
//  • Serves the built app from ./dist with security headers
//  • /api/health      capability report (which optional services are configured)
//  • /api/ai          provider-agnostic LLM proxy (keys stay server-side)
//  • /api/scorecard   U.S. Dept. of Education College Scorecard lookup
//  • /api/research    multi-step research: Scorecard + optional search API + robots-aware fetch + cited summary
// Every external service is optional. Without any keys, the app still works fully in local mode.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, COMPAT, AIError } from './ai/router.mjs';
import { createSupabase } from './supabase.mjs';
import { createRAG } from './rag.mjs';
import { createBilling } from './billing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(root, '.env'));
const env = process.env;
const PORT = Number(env.PORT || 8787);
const DIST = path.join(root, 'dist');
const UA = 'AdmitIQ-Research/1.0 (+https://github.com/; contact: set ADMITIQ_CONTACT)';

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------------- AI (multi-provider router) ----------------
// OpenAI (primary) · Gemini with Google Search grounding (research) · Anthropic (optional) · legacy AI_PROVIDER.
// See server/ai/router.mjs and AI_ARCHITECTURE.md.
const supabase = createSupabase(env);
const router = createRouter(env, {
  onUsage: supabase.admin && env.AI_USAGE_LOG !== 'false'
    ? (e) => supabase.insert('ai_usage', [{ user_id: e.userId, task: e.task, provider: e.provider, model: e.model, tier: e.tier, input_tokens: e.input, output_tokens: e.output, cost_usd: e.cost, latency_ms: e.ms, ok: e.ok, status: e.status || null, streamed: !!e.stream }])
    : null,
});
const rag = createRAG(env, supabase, router);
const billing = createBilling(env, supabase);

// Legacy single-provider config — still used for speech-to-text.
function aiConfig() {
  const name = (env.AI_PROVIDER || '').toLowerCase();
  if (env.OPENAI_API_KEY && (!name || name === 'none')) return { name: 'openai', base: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''), key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || '' };
  const p = COMPAT[name];
  if (!p) return null;
  const base = env.AI_BASE_URL || p.base, key = env.AI_API_KEY || '';
  if (!base || (!key && !p.keyless)) return null;
  return { name, base: base.replace(/\/$/, ''), key, model: env.AI_MODEL || '' };
}

// Internal helper used by reviews/research summaries (already rate-limited by their routes).
async function callAI(messages, { json = false, maxTokens = 1400, task = 'chat', user } = {}) {
  const out = await router.run({ task, messages, json, maxTokens, user, skipQuota: !user });
  return out.text;
}
const aiReady = () => router.configured().length > 0;

// ---------------- Speech-to-text (Whisper via the configured provider) ----------------
// Used by browsers without built-in speech recognition. Groq and OpenAI expose /audio/transcriptions.
const TRANSCRIBE = { groq: 'whisper-large-v3-turbo', openai: 'gpt-4o-mini-transcribe', 'openai-compatible': 'whisper-1' };
function transcribeConfig() {
  const cfg = aiConfig();
  if (!cfg || !(cfg.name in TRANSCRIBE)) return null;
  return { ...cfg, model: env.AI_TRANSCRIBE_MODEL || TRANSCRIBE[cfg.name] };
}
async function readRaw(req, limit) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, 'Recording too long (max ~10 MB). Keep answers under a few minutes.'); chunks.push(c); }
  return Buffer.concat(chunks);
}
async function transcribeAudio(buf, mime) {
  const cfg = transcribeConfig();
  if (!cfg) throw httpError(503, 'Server-side transcription needs AI_PROVIDER=groq or openai.');
  const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'webm';
  const send = async (model) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: mime }), `speech.${ext}`);
    fd.append('model', model); fd.append('response_format', 'json');
    const r = await fetch(`${cfg.base}/audio/transcriptions`, { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${cfg.key}` }, body: fd });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, d, msg: String(d?.error?.message || r.status) };
  };
  let res = await send(cfg.model);
  if (!res.ok && !env.AI_TRANSCRIBE_MODEL && (res.status === 404 || /model/i.test(res.msg))) {
    const ids = await fetch(`${cfg.base}/models`, { headers: { authorization: `Bearer ${cfg.key}` } }).then((r) => r.json()).then((d) => (d.data || []).map((m) => m.id)).catch(() => []);
    const alt = ids.filter((id) => /whisper|transcribe/i.test(id)).sort().reverse()[0];
    if (alt) res = await send(alt);
  }
  if (!res.ok) throw httpError(502, `Transcription error: ${res.msg}`);
  return String(res.d.text || '');
}

// ---------------- College Scorecard ----------------
const SC_FIELDS = {
  id: 'id', name: 'school.name', city: 'school.city', state: 'school.state', url: 'school.school_url', npc: 'school.price_calculator_url',
  admit: 'latest.admissions.admission_rate.overall',
  satRW25: 'latest.admissions.sat_scores.25th_percentile.critical_reading', satRW75: 'latest.admissions.sat_scores.75th_percentile.critical_reading',
  satM25: 'latest.admissions.sat_scores.25th_percentile.math', satM75: 'latest.admissions.sat_scores.75th_percentile.math',
  act25: 'latest.admissions.act_scores.25th_percentile.cumulative', act75: 'latest.admissions.act_scores.75th_percentile.cumulative',
  tuitionIn: 'latest.cost.tuition.in_state', tuitionOut: 'latest.cost.tuition.out_of_state', coa: 'latest.cost.attendance.academic_year',
  netPrice: 'latest.cost.avg_net_price.overall',
  grad: 'latest.completion.completion_rate_4yr_150nt', retention: 'latest.student.retention_rate.four_year.full_time',
  earnings: 'latest.earnings.10_yrs_after_entry.median', debt: 'latest.aid.median_debt.completers.overall', size: 'latest.student.size',
};
async function scorecard(params) {
  if (!env.SCORECARD_API_KEY) throw httpError(503, 'College Scorecard is not configured (set SCORECARD_API_KEY — free at api.data.gov/signup).');
  const q = new URLSearchParams({ api_key: env.SCORECARD_API_KEY, fields: Object.values(SC_FIELDS).join(','), per_page: '5', ...params });
  const url = `${env.SCORECARD_BASE || 'https://api.data.gov/ed/collegescorecard/v1/schools'}?${q}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': UA } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw httpError(502, `College Scorecard error ${r.status}: ${d?.error?.message || ''}`);
  const results = (d.results || []).map((row) => Object.fromEntries(Object.entries(SC_FIELDS).map(([k, f]) => [k, row[f] ?? null])));
  return { results, retrieved: new Date().toISOString().slice(0, 10), url: url.replace(env.SCORECARD_API_KEY, 'API_KEY') };
}

// ---------------- National directories (Urban Institute Education Data Portal, free, no key) ----------------
// Data: NCES IPEDS (colleges) and Common Core of Data (public schools), ODC-By licensed via educationdata.urban.org.
const URBAN = env.URBAN_BASE || 'https://educationdata.urban.org/api/v1';
const YEARS = (env.DIRECTORY_YEARS || '2024,2023,2022').split(',').map((y) => y.trim());
const FIPS = { AL: 1, AK: 2, AZ: 4, AR: 5, CA: 6, CO: 8, CT: 9, DE: 10, DC: 11, FL: 12, GA: 13, HI: 15, ID: 16, IL: 17, IN: 18, IA: 19, KS: 20, KY: 21, LA: 22, ME: 23, MD: 24, MA: 25, MI: 26, MN: 27, MS: 28, MO: 29, MT: 30, NE: 31, NV: 32, NH: 33, NJ: 34, NM: 35, NY: 36, NC: 37, ND: 38, OH: 39, OK: 40, OR: 41, PA: 42, RI: 44, SC: 45, SD: 46, TN: 47, TX: 48, UT: 49, VT: 50, VA: 51, WA: 53, WV: 54, WI: 55, WY: 56, PR: 72 };
const dirCache = new Map();
async function urbanAll(pathTpl, maxPages = 12) {
  let lastErr = '';
  for (const year of YEARS) {
    let url = `${URBAN}/${pathTpl.replace('{year}', year)}`, rows = [], pages = 0;
    try {
      while (url && pages < maxPages) {
        const r = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': UA, accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        rows = rows.concat(d.results || []); url = d.next; pages++;
      }
      if (rows.length) return { rows, year };
    } catch (e) { lastErr = e.message; }
  }
  throw httpError(502, `National directory unavailable (${lastErr || 'no data'}). Try again later.`);
}
const CONTROL = { 1: 'Public', 2: 'Private nonprofit', 3: 'Private for-profit' };
async function collegeDirectory() {
  if (dirCache.has('colleges')) return dirCache.get('colleges');
  const p = urbanAll('college-university/ipeds/directory/{year}/', 20).then(({ rows, year }) => ({ year, rows: rows
    .filter((r) => r.unitid && r.inst_name && (r.degree_granting === undefined || r.degree_granting === 1))
    .map((r) => ({ unitid: String(r.unitid), name: r.inst_name, city: r.city || '', state: r.state_abbr || '', control: CONTROL[r.inst_control] || 'Unknown',
      web: r.url_school ? (/^https?:/.test(r.url_school) ? r.url_school : `https://${r.url_school}`) : '', lat: r.latitude ?? null, lon: r.longitude ?? null,
      level: r.inst_level === 1 ? 'Four-year' : r.inst_level === 2 ? 'Two-year' : r.inst_level === 3 ? 'Less than two-year' : '' })) }));
  dirCache.set('colleges', p);
  p.catch(() => dirCache.delete('colleges'));
  return p;
}
async function highSchools(state) {
  const fips = FIPS[state]; if (!fips) throw httpError(400, 'Unknown state');
  const key = `hs-${state}`;
  if (dirCache.has(key)) return dirCache.get(key);
  const p = urbanAll(`schools/ccd/directory/{year}/?fips=${fips}&school_level=3`, 10).then(({ rows, year }) => ({ year, rows: rows
    .filter((r) => r.school_name)
    .map((r) => ({ id: String(r.ncessch || ''), name: r.school_name, city: r.city_location || r.city_mailing || '', state, charter: r.charter === 1, enrollment: r.enrollment ?? null })) }));
  dirCache.set(key, p);
  p.catch(() => dirCache.delete(key));
  return p;
}
const norm = (x) => String(x || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function rank(items, q, field = 'name') {
  const n = norm(q); if (!n) return items;
  const words = n.split(' ');
  return items.map((it) => { const h = norm(it[field]); const all = words.every((w) => h.includes(w)); const score = h === n ? 0 : h.startsWith(n) ? 1 : h.includes(n) ? 2 : all ? 3 : 9; return { it, score }; })
    .filter((x) => x.score < 9).sort((a, b) => a.score - b.score || a.it[field].length - b.it[field].length).map((x) => x.it);
}

// College details: College Scorecard (official, needs free key) for statistics; directory-only otherwise.
async function collegeDetail(unitid) {
  const dir = await collegeDirectory().catch(() => null);
  const base = dir?.rows.find((r) => r.unitid === unitid) || null;
  if (!env.SCORECARD_API_KEY) return { directory: base, stats: null, note: 'Add a free SCORECARD_API_KEY to load official admissions, cost and outcome statistics.' };
  const sc = await scorecard({ id: unitid });
  return { directory: base, stats: sc.results[0] || null, retrieved: sc.retrieved, url: `https://collegescorecard.ed.gov/school/?${unitid}` };
}

// ---------------- Student reviews from the web (search API + cited summary; no scraping) ----------------
const reviewCache = new Map();
async function webReviews(name) {
  if (!env.SEARCH_API_KEY) throw httpError(503, 'Review summaries need a search API key (SEARCH_PROVIDER=tavily or brave).');
  const key = norm(name);
  const hit = reviewCache.get(key); if (hit && Date.now() - hit.at < 7 * 864e5) return hit.data;
  const queries = [`${name} student reviews campus life`, `${name} reddit what is it like to attend`, `${name} students say academics workload social life`];
  const seen = new Set(); const sources = [];
  for (const q of queries) {
    const res = await webSearch(q).catch(() => []);
    for (const r of res || []) { if (seen.has(r.url) || /\.pdf$/i.test(r.url)) continue; seen.add(r.url); sources.push({ title: r.title, url: r.url, domain: new URL(r.url).host.replace(/^www\./, ''), snippet: (r.snippet || '').slice(0, 600) }); }
  }
  if (!sources.length) return { themes: [], sources: [], summary: null, note: 'No public reviews were found.' };
  let themes = [], summary = null;
  if (aiReady()) {
    const ctx = sources.slice(0, 14).map((s, i) => `[${i + 1}] ${s.domain} — ${s.title}\n${s.snippet}`).join('\n\n');
    const raw = await callAI([
      { role: 'system', content: 'You summarize what students say about a college, using ONLY the numbered search snippets. These are anecdotes, not facts. Return JSON: {"summary": string (2 sentences, hedged: "Reviewers often say…"), "themes": [{"label": string, "tone": "positive"|"mixed"|"negative", "summary": string (1 sentence), "sources": [numbers]}]}. 4–7 themes covering academics, social life, housing/food, career, cost, campus culture where present. Cite every theme. Never invent details, names or statistics.' },
      { role: 'user', content: `College: ${name}\n\nSnippets:\n${ctx}` },
    ], { json: true, maxTokens: 900 }).catch(() => '');
    try { const j = JSON.parse(raw.replace(/^```json\s*|```$/g, '')); themes = (j.themes || []).filter((t) => Array.isArray(t.sources) && t.sources.length); summary = j.summary || null; } catch { /* fall back to raw sources */ }
  }
  const data = { themes, summary, sources: sources.slice(0, 14), retrieved: new Date().toISOString().slice(0, 10), note: 'Anecdotal opinions from public web pages — not verified facts. Read the sources.' };
  reviewCache.set(key, { at: Date.now(), data });
  return data;
}

// ---------------- Web search (optional, bring your own key) ----------------
const OFFICIAL = /\.(edu|gov)(\/|$)|collegescorecard\.ed\.gov|nces\.ed\.gov|studentaid\.gov/i;
async function webSearch(query) {
  const provider = (env.SEARCH_PROVIDER || '').toLowerCase();
  if (provider === 'tavily' && env.SEARCH_API_KEY) {
    const r = await fetch(`${env.TAVILY_BASE || 'https://api.tavily.com'}/search`, { method: 'POST', signal: AbortSignal.timeout(20_000), headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SEARCH_API_KEY}` }, body: JSON.stringify({ query, max_results: 6, search_depth: 'basic' }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(502, `Search error ${r.status}`);
    return (d.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '' }));
  }
  if (provider === 'brave' && env.SEARCH_API_KEY) {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: '6' })}`, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json', 'x-subscription-token': env.SEARCH_API_KEY } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(502, `Search error ${r.status}`);
    return (d.web?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: (x.description || '').replace(/<[^>]+>/g, '') }));
  }
  return null;
}

// robots.txt-aware page fetch with a per-host rate limit
const robotsCache = new Map(); const hostLast = new Map();
async function allowedByRobots(u) {
  const { origin, pathname } = new URL(u);
  if (!robotsCache.has(origin)) {
    let rules = [];
    try {
      const r = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': UA } });
      if (r.ok) {
        let applies = false;
        for (const raw of (await r.text()).split('\n')) {
          const line = raw.split('#')[0].trim(); const [k, ...v] = line.split(':'); const val = v.join(':').trim();
          if (/^user-agent$/i.test(k)) applies = val === '*' || /admitiq/i.test(val);
          else if (applies && /^disallow$/i.test(k) && val) rules.push(val);
        }
      }
    } catch { /* no robots.txt reachable: treat as allowed */ }
    robotsCache.set(origin, rules);
  }
  return !robotsCache.get(origin).some((p) => pathname.startsWith(p));
}
async function politeFetchText(u) {
  if (!(await allowedByRobots(u))) return { skipped: 'Disallowed by robots.txt' };
  const host = new URL(u).host; const wait = 1500 - (Date.now() - (hostLast.get(host) || 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  hostLast.set(host, Date.now());
  const r = await fetch(u, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': UA, accept: 'text/html,text/plain' }, redirect: 'follow' });
  if (!r.ok) return { skipped: `HTTP ${r.status}` };
  const ct = r.headers.get('content-type') || '';
  if (!/text\/html|text\/plain/.test(ct)) return { skipped: `Unsupported content type (${ct.split(';')[0]})` };
  const html = (await r.text()).slice(0, 600_000);
  if (/paywall|subscribe to (read|continue)|sign in to continue/i.test(html.slice(0, 20000))) return { skipped: 'Looks paywalled or login-restricted — skipped' };
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { text: text.slice(0, 6000) };
}

async function doResearch({ question, collegeIds = [], verify = false }, bundled, user) {
  const steps = []; const findings = []; const conflicts = []; const uncertainty = [];
  const today = new Date().toISOString().slice(0, 10);
  const push = (label, status, detail) => steps.push({ label, status, detail });
  if (!question || typeof question !== 'string' || question.length > 500) throw httpError(400, 'Ask a question under 500 characters.');
  const colleges = collegeIds.map((id) => bundled.find((c) => c.id === id)).filter(Boolean).slice(0, 4);
  push('Identifying the question', 'done', colleges.length ? `Colleges: ${colleges.map((c) => c.short).join(', ')}` : 'No specific college — general question');

  // 1) Official federal data
  if (env.SCORECARD_API_KEY && colleges.length) {
    for (const c of colleges) {
      try {
        const r = await scorecard(c.scorecardId ? { id: c.scorecardId } : { 'school.name': c.name });
        const row = r.results[0];
        if (!row) { push(`College Scorecard: ${c.short}`, 'error', 'No match'); continue; }
        const src = { source: 'College Scorecard (U.S. Dept. of Education)', url: `https://collegescorecard.ed.gov/school/?${row.id}`, retrieved: r.retrieved, reportingYear: 'latest release', confidence: 'High', official: true };
        const add = (claim, v, fmt) => { if (v !== null && v !== undefined) findings.push({ claim: `${c.short}: ${claim}`, value: fmt(v), ...src }); };
        const p = (v) => `${(v * 100).toFixed(1)}%`, $ = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
        add('Admission rate', row.admit, p); add('6-year completion rate', row.grad, p); add('Full-time retention', row.retention, p);
        add('In-state tuition & fees', row.tuitionIn, $); add('Out-of-state tuition & fees', row.tuitionOut, $); add('Cost of attendance', row.coa, $);
        add('Average net price', row.netPrice, $); add('Median earnings 10 yrs after entry', row.earnings, $); add('Median debt (completers)', row.debt, $);
        if (row.satRW25 && row.satM25) add('SAT middle 50% (sum of section 25th/75th — approximate)', [row.satRW25 + row.satM25, row.satRW75 + row.satM75], (v) => `${v[0]}–${v[1]}`);
        if (row.npc) findings.push({ claim: `${c.short}: Official net price calculator`, value: row.npc, ...src });
        // Cross-check against bundled (unverified) values
        if (row.admit !== null && c.admit !== null && Math.abs(row.admit - c.admit) > 0.02) conflicts.push(`${c.short} admit rate: Scorecard ${p(row.admit)} vs bundled estimate ${p(c.admit)}. Official value preferred; bundled data may be from a different year.`);
        if (row.grad !== null && c.grad !== null && Math.abs(row.grad - c.grad) > 0.02) conflicts.push(`${c.short} graduation rate: Scorecard ${p(row.grad)} vs bundled ${p(c.grad)}.`);
        push(`College Scorecard: ${c.short}`, 'done', `Retrieved ${r.retrieved}`);
      } catch (e) { push(`College Scorecard: ${c.short}`, 'error', e.message); }
    }
  } else push('College Scorecard', 'skipped', env.SCORECARD_API_KEY ? 'No college specified' : 'Not configured');

  // 2) Web search, official domains first
  let results = null;
  try { results = await webSearch(`${question} ${colleges.map((c) => c.name).join(' ')}`.trim()); } catch (e) { push('Web search', 'error', e.message); }
  if (results) {
    results.sort((a, b) => Number(OFFICIAL.test(b.url)) - Number(OFFICIAL.test(a.url)));
    push('Web search', 'done', `${results.length} results (${results.filter((r) => OFFICIAL.test(r.url)).length} official)`);
    const pages = [];
    for (const r of results.filter((x) => OFFICIAL.test(x.url)).slice(0, 2)) {
      const got = await politeFetchText(r.url).catch((e) => ({ skipped: e.message }));
      if (got.text) pages.push({ ...r, text: got.text }); else uncertainty.push(`Skipped ${new URL(r.url).host}: ${got.skipped}.`);
    }
    push('Retrieving official pages (robots.txt respected)', 'done', `${pages.length} page(s) read`);
    for (const r of results) findings.push({ claim: r.title, value: r.snippet.slice(0, 160), source: new URL(r.url).host, url: r.url, retrieved: today, confidence: OFFICIAL.test(r.url) ? 'Medium' : 'Low', official: OFFICIAL.test(r.url) });
    results._pages = pages;
  } else if (!steps.some((s) => s.label === 'Web search')) push('Web search', 'skipped', 'No search API configured');

  // 2b) The platform's own source library (hybrid pgvector + full-text retrieval)
  if (supabase.admin) {
    try {
      const lib = await rag.search(`${question} ${colleges.map((c) => c.name).join(' ')}`.trim(), { limit: 6 });
      for (const s of lib.results) findings.push({ claim: s.title, value: (s.summary || s.excerpt || '').slice(0, 200), source: s.organization || new URL(s.url).host, url: s.url, sourceId: s.id, retrieved: s.last_verified_at?.slice(0, 10) || 'not yet verified', reportingYear: s.data_year || undefined, confidence: s.reliability_tier === 1 ? 'High' : s.reliability_tier === 2 ? 'Medium' : 'Low', official: s.reliability_tier === 1 });
      push('Searching the AdmitIQ source library', 'done', `${lib.results.length} record(s) · ${lib.mode}`);
    } catch (e) { push('Searching the AdmitIQ source library', 'error', e.message); }
  }

  // 2c) Gemini with Google Search grounding (current information with real citations)
  let groundedAnswer = null;
  if (router.hasProvider('gemini')) {
    try {
      const g = await router.run({ task: 'research', user, messages: [
        { role: 'system', content: `Today is ${today}. Research the question using Google Search. Prefer official university (.edu), government (.gov) and Common Data Set sources. State the academic year each fact applies to. If official sources disagree or you cannot find an official source, say so. Be concise.` },
        { role: 'user', content: `${question}${colleges.length ? `\nColleges: ${colleges.map((c) => c.name).join(', ')}` : ''}` },
      ] });
      if (g.provider === 'gemini' && g.citations.length) {
        groundedAnswer = { text: g.text, citations: g.citations, queries: g.searchQueries, model: g.model };
        for (const c of g.citations) {
          let host = ''; try { host = new URL(c.url).host; } catch { /* grounding redirect */ }
          findings.push({ claim: c.title || host, value: 'Cited by Google Search grounding', source: c.title || host, url: c.url, retrieved: today, confidence: OFFICIAL.test(c.title || '') ? 'Medium' : 'Low', official: OFFICIAL.test(c.title || '') });
        }
        push('Google Search grounding (Gemini)', 'done', `${g.citations.length} cited web source(s)`);
      } else push('Google Search grounding (Gemini)', 'skipped', 'No grounded citations were returned');
    } catch (e) { push('Google Search grounding (Gemini)', 'error', e.message); }
  } else push('Google Search grounding (Gemini)', 'skipped', 'GEMINI_API_KEY not set');

  // 3) Optional cited summary
  let summary = null;
  if (aiReady() && findings.length) {
    try {
      const ctx = findings.map((f, i) => `[${i + 1}] ${f.claim}: ${f.value || ''} (${f.source}, ${f.url}, retrieved ${f.retrieved})`).join('\n') + (results?._pages?.length ? '\n\nPAGE EXCERPTS:\n' + results._pages.map((p) => `${p.url}\n${p.text.slice(0, 2500)}`).join('\n\n') : '');
      summary = await callAI([{ role: 'system', content: 'Summarize ONLY what the numbered sources say, citing them like [1]. Prefer official sources. If sources conflict or do not answer the question, say so explicitly. Never add facts not present in the sources.' }, { role: 'user', content: `Question: ${question}\n\nSources:\n${ctx}${groundedAnswer ? `\n\nGROUNDED WEB ANSWER (cite the matching sources above):\n${groundedAnswer.text}` : ''}` }], { maxTokens: 900, task: 'analysis', user });
      push('Summarizing with citations', 'done', 'AI summary of the sources above');
    } catch (e) { push('Summarizing with citations', 'error', e.message); }
  }
  if (!findings.length) uncertainty.push('No sources were retrieved, so no answer is given. AdmitIQ does not fill gaps with guesses.');
  if (findings.some((f) => !f.official)) uncertainty.push('Non-official results are shown for context only and were not used to override official figures.');
  let verification = null;
  if (verify && summary && router.configured().length > 1) {
    try { verification = await router.verify({ question, answer: summary, sources: findings.map((f) => ({ title: f.claim, url: f.url, text: f.value })), user }); push('Independent verification', 'done', `${verification.verdict} (${verification.provider})`); }
    catch (e) { push('Independent verification', 'error', e.message); }
  }
  return { question, steps, findings, summary, grounded: groundedAnswer, verification, conflicts, uncertainty };
}

// ---------------- HTTP plumbing ----------------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const buckets = new Map();
function rateLimit(ip, cost = 1, perMin = Number(env.RATE_LIMIT_PER_MIN || 20)) {
  const now = Date.now(); const b = buckets.get(ip) || { t: now, tokens: perMin };
  b.tokens = Math.min(perMin, b.tokens + ((now - b.t) / 60000) * perMin); b.t = now;
  if (b.tokens < cost) throw httpError(429, 'Too many requests — please wait a minute.');
  b.tokens -= cost; buckets.set(ip, b);
}
async function readJSON(req, limit = 200_000) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw httpError(413, 'Request too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw httpError(400, 'Invalid JSON'); }
}
// Who is calling? Verifies the Supabase access token (if any) and looks up the plan.
// REQUIRE_AUTH=true rejects anonymous calls to AI/research. Without Supabase (single-user local install)
// the caller gets AI_LOCAL_PLAN (default "ultimate") so a self-hosted copy isn't throttled.
const planCache = new Map();
async function identify(req, ip) {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const u = token ? await supabase.getUser(token) : null;
  if (token && !u && supabase.enabled) throw httpError(401, 'Your session has expired. Sign in again.');
  if (!u) {
    if (env.REQUIRE_AUTH === 'true') throw httpError(401, 'Sign in to use AI and research features.');
    return { id: null, ip, plan: supabase.enabled ? 'anonymous' : (env.AI_LOCAL_PLAN || 'ultimate') };
  }
  const hit = planCache.get(u.id);
  let plan = hit && Date.now() - hit.at < 60_000 ? hit.plan : null;
  if (!plan) { plan = await supabase.planFor(u.id); planCache.set(u.id, { plan, at: Date.now() }); }
  const admins = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  return { ...u, ip, plan, admin: !!u.email && admins.includes(u.email.toLowerCase()) };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "img-src 'self' data: blob:", `connect-src 'self' ${env.SUPABASE_URL || ''} https://checkout.stripe.com`.trim(), "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join('; '),
};
function send(res, status, body, headers = {}) { res.writeHead(status, { ...SECURITY_HEADERS, ...headers }); res.end(body); }
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json', 'cache-control': 'no-store' });

export { server, router, billing };
let bundledColleges = [];
try { bundledColleges = JSON.parse(fs.readFileSync(path.join(DIST, 'colleges.json'), 'utf8')); } catch { /* built by build script */ }

const server = http.createServer(async (req, res) => {
  const ip = (env.TRUST_PROXY === 'true' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'local';
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/health') {
      const ai = router.status();
      return json(res, 200, { directory: env.DISABLE_DIRECTORY === 'true' ? null : { colleges: true, highSchools: true, stats: !!env.SCORECARD_API_KEY }, reviews: !!(env.SEARCH_PROVIDER && env.SEARCH_API_KEY),
        ai: router.configured().length ? { providers: Object.keys(ai.providers), provider: Object.keys(ai.providers).join(' + '), model: Object.values(ai.providers)[0]?.models?.fast || Object.values(ai.providers)[0]?.models?.main || 'auto-selected', grounding: router.hasProvider('gemini'), transcribe: !!transcribeConfig(), streaming: true } : null,
        research: { search: env.SEARCH_PROVIDER && env.SEARCH_API_KEY ? env.SEARCH_PROVIDER : null, scorecard: !!env.SCORECARD_API_KEY, grounding: router.hasProvider('gemini'), library: supabase.admin, embeddings: rag.canEmbed },
        billing: billing.enabled, supabase: supabase.enabled ? { url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY } : null });
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST') throw httpError(405, 'Use POST');
      // Stripe webhook needs the raw body for signature verification, and no user token.
      if (url.pathname === '/api/billing/webhook') {
        const raw = (await readRaw(req, 1_000_000)).toString('utf8');
        return json(res, 200, await billing.handleWebhook(raw, req.headers['stripe-signature']));
      }
      if (url.pathname === '/api/transcribe') {
        await identify(req, ip);
        rateLimit(ip, 2);
        const mime = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
        if (!/^audio\//.test(mime)) throw httpError(415, 'Send audio (audio/webm, audio/mp4, audio/ogg or audio/wav).');
        const buf = await readRaw(req, 10_000_000);
        return json(res, 200, { text: await transcribeAudio(buf, mime) });
      }
      const body = await readJSON(req);
      const user = await identify(req, ip);
      const cleanMessages = (m) => {
        if (!Array.isArray(m) || !m.length || m.length > 40) throw httpError(400, 'messages must be a non-empty array (max 40)');
        return m.map((x) => ({ role: ['system', 'user', 'assistant'].includes(x.role) ? x.role : 'user', content: String(x.content || '').slice(0, 60000) }));
      };
      if (url.pathname === '/api/ai') {
        rateLimit(ip);
        const out = await router.run({ task: String(body.task || 'chat'), messages: cleanMessages(body.messages), json: !!body.json, user });
        return json(res, 200, { text: out.text, provider: out.provider, model: out.model, citations: out.citations, grounded: out.grounded, usage: out.usage, remaining: router.remaining(user) });
      }
      if (url.pathname === '/api/ai/stream') {
        rateLimit(ip);
        const msgs = cleanMessages(body.messages);
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        try {
          const out = await router.stream({ task: String(body.task || 'chat'), messages: msgs, user }, (delta) => sse('delta', { text: delta }));
          sse('done', { provider: out.provider, model: out.model, usage: out.usage, remaining: router.remaining(user) });
        } catch (e) { sse('error', { error: e.message, status: e.status || 500, partial: e.partial || null }); }
        return res.end();
      }
      if (url.pathname === '/api/ai/verify') {
        rateLimit(ip, 2);
        if (!body.question || !body.answer) throw httpError(400, 'question and answer are required');
        return json(res, 200, await router.verify({ question: String(body.question).slice(0, 2000), answer: String(body.answer).slice(0, 20000), sources: Array.isArray(body.sources) ? body.sources.slice(0, 20) : [], usedProvider: body.usedProvider, user }));
      }
      if (url.pathname === '/api/me/usage') return json(res, 200, { ...router.remaining(user), signedIn: !!user.id });
      if (url.pathname === '/api/library/search') {
        rateLimit(ip, 0.5);
        if (!body.q || String(body.q).length > 300) throw httpError(400, 'q is required (max 300 characters)');
        return json(res, 200, await rag.search(String(body.q), { limit: Number(body.limit) || 10, category: body.category, collegeId: body.collegeId }));
      }
      if (url.pathname === '/api/library/answer') {
        rateLimit(ip, 3);
        if (!body.q || String(body.q).length > 500) throw httpError(400, 'q is required (max 500 characters)');
        return json(res, 200, await rag.answer(String(body.q), { user, collegeId: body.collegeId, category: body.category }));
      }
      if (url.pathname === '/api/library/stats') {
        rateLimit(ip, 0.5);
        if (!supabase.admin) return json(res, 200, { configured: false });
        const [stats] = await supabase.rpc('source_library_stats', {}).then((r) => (Array.isArray(r) ? r : [r]));
        return json(res, 200, { configured: true, ...stats });
      }
      if (url.pathname.startsWith('/api/billing/')) {
        if (!user.id) throw httpError(401, 'Sign in to manage billing.');
        if (url.pathname === '/api/billing/checkout') return json(res, 200, await billing.checkout(user, body));
        if (url.pathname === '/api/billing/portal') return json(res, 200, await billing.portal(user));
        if (url.pathname === '/api/billing/invoices') return json(res, 200, { invoices: await billing.invoices(user) });
      }
      if (url.pathname === '/api/admin/status') {
        if (!user.admin) throw httpError(403, 'Admins only (set ADMIN_EMAILS on the server).');
        const db = supabase.admin ? await supabase.rpc('admin_dashboard_stats', {}).then((r) => (Array.isArray(r) ? r[0] : r)).catch((e) => ({ error: e.message })) : null;
        return json(res, 200, { ai: router.status(), usage24h: router.usageSummary(), usage30d: router.usageSummary({ sinceMs: 30 * 864e5 }), database: db, billing: billing.enabled, uptimeSec: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1e6) });
      }
      if (url.pathname === '/api/colleges/search') {
        rateLimit(ip, 0.5);
        const d = await collegeDirectory();
        let rows = d.rows;
        if (body.state) rows = rows.filter((r) => r.state === String(body.state).toUpperCase());
        if (body.level) rows = rows.filter((r) => r.level === body.level);
        const results = rank(rows, String(body.q || '').slice(0, 80)).slice(0, 25);
        return json(res, 200, { results, total: d.rows.length, year: d.year, source: 'NCES IPEDS via Urban Institute Education Data Portal' });
      }
      if (url.pathname === '/api/colleges/detail') {
        rateLimit(ip);
        if (!/^\d{6}$/.test(String(body.unitid || ''))) throw httpError(400, 'unitid must be a 6-digit IPEDS id');
        return json(res, 200, await collegeDetail(String(body.unitid)));
      }
      if (url.pathname === '/api/highschools') {
        rateLimit(ip, 0.5);
        const d = await highSchools(String(body.state || '').toUpperCase());
        return json(res, 200, { results: rank(d.rows, String(body.q || '').slice(0, 80)).slice(0, 15), total: d.rows.length, year: d.year, source: 'NCES Common Core of Data via Urban Institute Education Data Portal' });
      }
      if (url.pathname === '/api/reviews') {
        rateLimit(ip, 4);
        if (!body.name || String(body.name).length > 140) throw httpError(400, 'name is required');
        return json(res, 200, await webReviews(String(body.name)));
      }
      if (url.pathname === '/api/scorecard') {
        rateLimit(ip);
        if (!body.name || String(body.name).length > 120) throw httpError(400, 'name is required');
        return json(res, 200, await scorecard({ 'school.name': String(body.name) }));
      }
      if (url.pathname === '/api/research') {
        rateLimit(ip, 3);
        return json(res, 200, await doResearch(body, bundledColleges, user));
      }
      throw httpError(404, 'Unknown API route');
    }
    // Static files
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST)) throw httpError(403, 'Forbidden');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', { 'content-type': 'text/plain' });
    const ext = path.extname(file);
    let data = fs.readFileSync(file);
    if (ext === '.html') data = Buffer.from(data.toString('utf8').replace('<head>', '<head>\n  <meta name="admitiq-server" content="1" />'));
    return send(res, 200, data, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  } catch (e) {
    const status = e.status || (e.name === 'TimeoutError' ? 504 : 500);
    if (status >= 500) console.error('[admitiq]', e.message);
    if (res.headersSent) return res.end();
    return json(res, status, { error: status === 500 ? 'Unexpected server error' : e.message, ...(e.code ? { code: e.code } : {}) });
  }
});

if (env.ADMITIQ_NO_LISTEN !== 'true') server.listen(PORT, () => {
  console.log(`AdmitIQ running at http://localhost:${PORT}`);
  console.log(`  AI: ${router.configured().join(', ') || 'off'} · Scorecard: ${env.SCORECARD_API_KEY ? 'on' : 'off'} · Search: ${env.SEARCH_PROVIDER && env.SEARCH_API_KEY ? env.SEARCH_PROVIDER : 'off'} · Supabase: ${env.SUPABASE_URL ? 'on' : 'off'}`);
});
