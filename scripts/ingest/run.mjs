#!/usr/bin/env node
// AdmitIQ ingestion pipeline — pulls official federal data and loads it into Supabase.
//
//   npm run ingest                      # everything below, then load into Supabase
//   npm run ingest -- --dry-run         # fetch + transform + count, write snapshots, load nothing
//   npm run ingest -- --only=directory,stats
//   npm run ingest -- --bls-file=~/Downloads/xml-compilation.xml   # if bls.gov blocks scripted downloads
//   npm run ingest -- --cip-file=CIPCode2020.csv
//
// Steps
//   directory    IPEDS directory → colleges (~6,000 active U.S. institutions) + their official pages as sources
//   stats        IPEDS admissions, test scores, tuition, room & board, retention, ratio, enrollment, graduation, net price
//   bls          BLS Occupational Outlook Handbook → careers (~340 occupation profiles) + one source per profile
//   cip          NCES CIP 2020 → majors (~2,000 six-digit programs)
//   completions  IPEDS completions by program → which colleges award degrees in each major (large; opt-in)
//
// Nothing is invented: missing values stay missing, every row records its dataset and year, and the
// final report prints real counts. Snapshots are written to data/ingest/*.ndjson for auditing.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as T from './transform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const line of (fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const env = process.env;
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : true]; }));
const DRY = !!args['dry-run'];
const ALL = ['directory', 'stats', 'bls', 'cip'];
const ONLY = args.only ? String(args.only).split(',') : ALL;
const URBAN = (env.URBAN_BASE || 'https://educationdata.urban.org/api/v1').replace(/\/$/, '');
const OUT = path.resolve(root, String(args.out || 'data/ingest'));
const UA = `AdmitIQ-ingest/2.0 (${env.ADMITIQ_CONTACT || 'set ADMITIQ_CONTACT in .env'})`;
const expand = (p) => String(p).replace(/^~(?=\/|$)/, os.homedir());

const SB = env.SUPABASE_URL?.replace(/\/$/, ''), KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!DRY && (!SB || !KEY)) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (or use --dry-run).'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function getJSON(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
      if (r.ok) return await r.json();
      if (![429, 500, 502, 503, 504].includes(r.status) || i >= tries) throw new Error(`HTTP ${r.status} for ${url}`);
    } catch (e) { if (i >= tries) throw e; }
    await sleep(1500 * 2 ** i);
  }
}
/** Fetch every page of an Urban Institute endpoint. */
async function urbanAll(endpoint, params = {}) {
  let url = `${URBAN}/college-university/${endpoint}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
  const rows = []; let pages = 0;
  while (url) { const d = await getJSON(url); rows.push(...(d.results || [])); url = d.next; pages++; if (pages % 5 === 0) log(`  …${endpoint} ${rows.length} rows`); }
  return rows;
}
/** First year in `years` that returns rows. */
async function latest(endpoint, years, params) {
  for (const y of years) {
    const rows = await urbanAll(endpoint.replace('{year}', y), params).catch((e) => { log(`  ${endpoint} ${y}: ${e.message}`); return []; });
    if (rows.length) return { year: Number(y), rows };
  }
  return { year: null, rows: [] };
}

// ---------- Supabase writes ----------
async function sb(pathq, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${SB}/rest/v1/${pathq}`, { method, headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...(prefer ? { prefer } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${pathq.split('?')[0]} → ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : null;
}
async function upsert(table, rows, onConflict, { returning } = {}) {
  if (DRY || !rows.length) return returning ? [] : rows.length;
  const out = [];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await sb(`${table}?on_conflict=${onConflict}${returning ? `&select=${returning}` : ''}`, { method: 'POST', body: chunk, prefer: `resolution=merge-duplicates,return=${returning ? 'representation' : 'minimal'}` });
        if (returning) out.push(...res);
        break;
      } catch (e) { if (attempt >= 3) throw e; await sleep(2000 * attempt); }
    }
    if (rows.length > 2000 && (i / 500) % 10 === 0) log(`  …${table} ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }
  return returning ? out : rows.length;
}
let runId = null;
async function startRun(pipeline, params) { if (DRY) return; runId = (await sb('ingestion_runs?select=id', { method: 'POST', body: [{ pipeline, params }], prefer: 'return=representation' }))[0].id; }
async function finishRun(status, counts, notes) { if (DRY || !runId) return; await sb(`ingestion_runs?id=eq.${runId}`, { method: 'PATCH', body: { status, finished_at: new Date().toISOString(), ...counts, notes }, prefer: 'return=minimal' }); }
async function logError(ref, reason, detail) { if (DRY || !runId) return; await sb('ingestion_errors', { method: 'POST', body: [{ run_id: runId, ref, reason, detail }], prefer: 'return=minimal' }).catch(() => {}); }

function snapshot(name, rows) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// ---------- steps ----------
const report = {};
const DIR_YEARS = String(env.DIRECTORY_YEARS || '2024,2023,2022').split(',').map((y) => y.trim());
const YEARS = String(env.IPEDS_YEARS || '2024,2023,2022').split(',').map((y) => y.trim());
const idMap = new Map(); // unitid → colleges.id
const sourceIdByOrigin = new Map();

async function loadExistingIds() {
  if (DRY) return;
  const rows = await sb('colleges?select=id,unitid,scorecard_id&limit=100000');
  for (const r of rows) { const u = r.unitid || r.scorecard_id; if (u) idMap.set(String(u), r.id); }
}

async function upsertSources(list, label) {
  const { sources, dupes, invalid } = T.dedupeSources(list);
  const stamp = new Date().toISOString();
  const rows = sources.map((s) => ({ ...s, stale_after: s.stale_after || new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10), updated_at: stamp }));
  const saved = await upsert('sources', rows, 'url_normalized', { returning: 'id,url_normalized,origin_ref' });
  for (const s of saved) sourceIdByOrigin.set(s.origin_ref, s.id);
  report[`sources_${label}`] = { unique: rows.length, duplicatesSkipped: dupes, invalidSkipped: invalid };
  return rows;
}

async function stepDirectory() {
  await startRun('ipeds_directory', { years: YEARS });
  // A newly released directory year can be partially loaded upstream (rows without names), so take the
  // newest year whose rows are substantially complete.
  let year = null, rows = [];
  for (const y of DIR_YEARS) {
    const got = await urbanAll(`ipeds/directory/${y}/`).catch((e) => { log(`  directory ${y}: ${e.message}`); return []; });
    const named = got.filter((r) => r.unitid && r.inst_name).length;
    log(`  directory ${y}: ${got.length} rows, ${named} with names`);
    if (got.length && named / got.length >= 0.9) { year = Number(y); rows = got; break; }
  }
  if (!rows.length) throw new Error('No complete IPEDS directory year found');
  log(`IPEDS directory ${year}: ${rows.length} institutions`);
  const keep = rows.filter((r) => r.unitid && r.inst_name);
  const existing = new Set(idMap.values());
  const colleges = keep.map((r) => T.directoryToCollege(r, year, idMap.get(String(r.unitid))));
  for (const c of colleges) idMap.set(c.unitid, c.id);
  snapshot('colleges', colleges);
  // Hand-curated colleges already in the app keep their short name, kind and setting.
  const curated = colleges.filter((c) => existing.has(c.id)).map(({ short_name, kind, setting, ...rest }) => rest);
  await upsert('colleges', colleges.filter((c) => !existing.has(c.id)), 'id');
  await upsert('colleges', curated, 'id');
  const srcs = keep.flatMap((r) => T.directoryToSources(r, year, idMap.get(String(r.unitid))));
  const dataset = T.datasetSource({ key: 'ipeds_directory', title: 'IPEDS Institutional Characteristics: Directory', year, category: 'higher_ed_research', endpoint: 'ipeds/directory/{year}/' });
  const saved = await upsertSources([dataset, ...srcs], 'directory');
  snapshot('sources_directory', saved);
  report.colleges = { total: colleges.length, active: colleges.filter((c) => c.active).length, year };
  await finishRun('succeeded', { fetched: rows.length, inserted: colleges.length });
}

const STAT_SETS = [
  { key: 'admissions', title: 'IPEDS Admissions and Enrollment', endpoint: 'ipeds/admissions-enrollment/{year}/', params: { sex: 99 }, years: YEARS, fn: T.admissionsStats, category: 'admissions_statistics' },
  { key: 'requirements', title: 'IPEDS Admissions Requirements and Test Scores', endpoint: 'ipeds/admissions-requirements/{year}/', years: ['2023', '2022', '2021'], fn: T.requirementsStats, category: 'testing' },
  { key: 'tuition', title: 'IPEDS Academic Year Tuition and Fees', endpoint: 'ipeds/academic-year-tuition/{year}/', params: { level_of_study: 1 }, years: ['2024', '2023', '2022'], fn: T.tuitionStats, category: 'tuition_fees' },
  { key: 'room_board', title: 'IPEDS Room, Board and Other Expenses', endpoint: 'ipeds/academic-year-room-board-other/{year}/', params: { level_of_study: 1 }, years: ['2024', '2023', '2022'], fn: T.roomBoardStats, category: 'housing' },
  { key: 'retention', title: 'IPEDS Fall Retention', endpoint: 'ipeds/fall-retention/{year}/', params: { ftpt: 1 }, years: YEARS, fn: T.retentionStats, category: 'retention' },
  { key: 'ratio', title: 'IPEDS Student-to-Faculty Ratio', endpoint: 'ipeds/student-faculty-ratio/{year}/', years: YEARS, fn: T.ratioStats, category: 'academic_programs' },
  { key: 'enrollment', title: 'IPEDS Fall Enrollment (undergraduate)', endpoint: 'ipeds/fall-enrollment/{year}/undergraduate/race/sex/', params: { race: 99, sex: 99 }, years: YEARS, fn: T.enrollmentStats, category: 'demographics' },
  { key: 'grad_rates', title: 'IPEDS Graduation Rates', endpoint: 'ipeds/grad-rates/{year}/', params: { race: 99, sex: 99, subcohort: 99 }, years: ['2024', '2023', '2022'], fn: T.gradStats, category: 'graduation' },
  { key: 'net_price', title: 'IPEDS Student Financial Aid and Net Price', endpoint: 'ipeds/sfa-grants-and-net-price/{year}/', params: { income_level: 99, type_of_aid: 3 }, years: ['2022', '2021'], fn: T.netPriceStats, category: 'financial_aid' },
];

async function stepStats() {
  await startRun('ipeds_stats', {});
  const idFor = (u) => idMap.get(String(u)) || null;
  let total = 0;
  for (const set of STAT_SETS) {
    try {
      const { year, rows } = await latest(set.endpoint, set.years, set.params);
      if (!rows.length) { await logError(set.key, 'no rows for any year', { years: set.years }); report[`stats_${set.key}`] = 'no data'; continue; }
      const ds = T.datasetSource({ key: set.key, title: set.title, year, category: set.category, endpoint: set.endpoint });
      await upsertSources([ds], `dataset_${set.key}`);
      const srcId = sourceIdByOrigin.get(ds.origin_ref) || null;
      const stats = set.fn(rows, year, idFor).map((s) => ({ ...s, library_source_id: srcId, retrieved_at: new Date().toISOString().slice(0, 10) }));
      snapshot(`stats_${set.key}`, stats);
      await upsert('college_statistics', stats, 'college_id,field,reporting_year,library_source_id');
      report[`stats_${set.key}`] = { year, rows: rows.length, values: stats.length };
      total += stats.length;
      log(`${set.title} ${year}: ${stats.length} values`);
    } catch (e) { await logError(set.key, e.message); report[`stats_${set.key}`] = `failed: ${e.message}`; log(`! ${set.key}: ${e.message}`); }
  }
  await finishRun(total ? 'succeeded' : 'failed', { inserted: total });
}

async function stepBLS() {
  await startRun('bls_ooh', { file: args['bls-file'] || null });
  let xml;
  if (args['bls-file']) xml = fs.readFileSync(expand(args['bls-file']), 'utf8');
  else {
    const r = await fetch('https://www.bls.gov/ooh/xml-compilation.xml', { headers: { 'user-agent': UA, accept: 'application/xml,text/xml' }, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) {
      const msg = `bls.gov answered HTTP ${r.status}. BLS often blocks scripted downloads: open https://www.bls.gov/ooh/xml-compilation.xml in a browser, save it, and re-run with --bls-file=PATH.`;
      await logError('bls_ooh', msg); await finishRun('failed', {}, msg); report.careers = msg; log(`! ${msg}`); return;
    }
    xml = await r.text();
  }
  const { meta, careers } = T.parseOOH(xml);
  log(`BLS OOH (${meta.referencePeriod}, projections ${meta.currentYear}–${meta.projectionYear}): ${careers.length} occupations`);
  const srcRows = careers.map((c) => T.careerSource(c, meta));
  await upsertSources([...srcRows, { url: 'https://www.bls.gov/ooh/', url_normalized: T.normalizeUrl('https://www.bls.gov/ooh/'), title: 'Occupational Outlook Handbook', organization: 'U.S. Bureau of Labor Statistics', category: 'career_development', source_type: 'government_publication', reliability_tier: 1, data_year: meta.currentYear, geographic_scope: 'US', citation: { publisher: 'BLS', url: 'https://www.bls.gov/ooh/' }, origin: 'bls_ooh', origin_ref: 'ooh:index' }], 'bls');
  const rows = careers.map((c) => ({ ...c, source_id: sourceIdByOrigin.get(`code=${c.occupation_code}`) || null, updated_at: new Date().toISOString() }));
  snapshot('careers', rows);
  await upsert('careers', rows, 'occupation_code');
  report.careers = { total: rows.length, referencePeriod: meta.referencePeriod, projections: `${meta.currentYear}–${meta.projectionYear}` };
  await finishRun('succeeded', { fetched: careers.length, inserted: rows.length });
}

async function stepCIP() {
  await startRun('nces_cip', { file: args['cip-file'] || null });
  let csv;
  const url = 'https://nces.ed.gov/ipeds/cipcode/Files/CIPCode2020.csv';
  if (args['cip-file']) csv = fs.readFileSync(expand(args['cip-file']), 'utf8');
  else {
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) { const msg = `nces.ed.gov answered HTTP ${r.status}. Download ${url} in a browser and re-run with --cip-file=PATH.`; await logError('cip', msg); await finishRun('failed', {}, msg); report.majors = msg; log(`! ${msg}`); return; }
    csv = await r.text();
  }
  const majors = T.cipToMajors(T.parseCSV(csv.replace(/^﻿/, '')));
  await upsertSources([{ url, url_normalized: T.normalizeUrl(url), title: 'Classification of Instructional Programs (CIP) 2020', organization: 'National Center for Education Statistics', category: 'majors', source_type: 'government_dataset', reliability_tier: 1, data_year: '2020', geographic_scope: 'US', citation: { publisher: 'NCES', title: 'CIP 2020', url }, origin: 'nces_cip', origin_ref: 'cip:2020' }], 'cip');
  const srcId = sourceIdByOrigin.get('cip:2020') || null;
  const rows = majors.map((m) => ({ ...m, source_id: srcId }));
  snapshot('majors', rows);
  await upsert('majors', rows, 'cip_code');
  report.majors = { total: rows.length, families: new Set(rows.map((m) => m.family_code)).size };
  await finishRun('succeeded', { inserted: rows.length });
}

async function stepCompletions() {
  await startRun('ipeds_completions', {});
  const { year, rows } = await latest('ipeds/completions-cip-6/{year}/', ['2023', '2022'], { race: 99, sex: 99, majornum: 1 });
  const idFor = (u) => idMap.get(String(u)) || null;
  const out = T.completionsToCollegeMajors(rows, year, idFor);
  snapshot('college_majors', out);
  await upsert('college_majors', out, 'college_id,cip_code,award_level,data_year');
  report.college_majors = { year, rows: out.length };
  await finishRun('succeeded', { fetched: rows.length, inserted: out.length });
}

// ---------- main ----------
const started = Date.now();
log(`AdmitIQ ingest ${DRY ? '(dry run — nothing is written to Supabase)' : `→ ${SB}`} · steps: ${ONLY.join(', ')}`);
try {
  await loadExistingIds();
  if (ONLY.includes('directory')) await stepDirectory();
  if (ONLY.includes('stats')) {
    if (!idMap.size) { const { rows } = await latest('ipeds/directory/{year}/', DIR_YEARS); for (const r of rows) idMap.set(String(r.unitid), String(r.unitid)); }
    await stepStats();
  }
  if (ONLY.includes('bls')) await stepBLS();
  if (ONLY.includes('cip')) await stepCIP();
  if (ONLY.includes('completions') || args.completions) await stepCompletions();
} catch (e) {
  console.error('\nIngest failed:', e.message);
  await logError('fatal', e.message).catch(() => {});
  await finishRun('failed', {}, e.message).catch(() => {});
  process.exitCode = 1;
}
const totalSources = Object.entries(report).filter(([k]) => k.startsWith('sources_')).reduce((n, [, v]) => n + (v.unique || 0), 0);
console.log('\n=== Ingest report ===');
console.log(JSON.stringify({ ...report, source_records_this_run: totalSources, seconds: Math.round((Date.now() - started) / 1000), dryRun: DRY }, null, 2));
if (!DRY) {
  const stats = await sb('rpc/source_library_stats', { method: 'POST', body: {} }).catch((e) => ({ error: e.message }));
  console.log('Source library now:', JSON.stringify(stats));
}
console.log(`Snapshots: ${path.relative(root, OUT)}/*.ndjson`);
