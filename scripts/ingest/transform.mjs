// Pure transforms from official datasets → AdmitIQ rows. No I/O here, so it is unit-tested
// with fixtures (test/ingest.test.mjs) and the exact same code runs in the pipeline.
//
// Rules enforced here:
//  * Only values present in the source are emitted. IPEDS/Urban missing-data codes (-1, -2, -3) become "absent", never 0.
//  * Every record carries its origin (dataset + year + record key), so it can be traced back.
//  * Source URLs are validated and de-duplicated by a normalized key.

export const URBAN_DOCS = 'https://educationdata.urban.org/documentation/colleges.html';
export const missing = (v) => v === null || v === undefined || v === '' || v === ' ' || (typeof v === 'number' && v < 0) || v === '-1' || v === '-2' || v === '-3';
const num = (v) => (missing(v) || Number.isNaN(Number(v)) ? null : Number(v));

/** Normalize a URL for de-duplication: https, lower-case host without "www.", no fragment, no default port, no trailing slash. */
export function normalizeUrl(raw) {
  if (missing(raw) || typeof raw !== 'string') return null;
  let u = raw.trim().replace(/\s+/g, '');
  if (!u || /^(n\/?a|none|-+)$/i.test(u)) return null;
  if (!/^https?:\/\//i.test(u)) u = `https://${u.replace(/^\/+/, '')}`;
  let x;
  try { x = new URL(u); } catch { return null; }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(x.hostname)) return null;
  x.hash = '';
  x.protocol = 'https:';
  x.hostname = x.hostname.toLowerCase().replace(/^www\./, '');
  if (x.port === '443' || x.port === '80') x.port = '';
  let s = x.toString();
  if (s.endsWith('/') && !x.search) s = s.slice(0, -1);
  return s;
}
/** The URL as it should be linked (https, original casing/path, www kept). */
export function displayUrl(raw) {
  let u = String(raw).trim().replace(/\s+/g, '');
  if (!/^https?:\/\//i.test(u)) u = `https://${u.replace(/^\/+/, '')}`;
  return u;
}

const CONTROL = { 1: 'Public', 2: 'Private nonprofit', 3: 'Private for-profit' };
const LEVEL = { 1: 'Four-year', 2: 'Two-year', 3: 'Less than two-year', 4: 'Four-year' }; // Urban institution_level: 4 = four-year or above

/** One IPEDS directory row → a colleges row. `existingId` keeps ids of colleges already in the app. */
export function directoryToCollege(r, year, existingId) {
  const control = CONTROL[r.inst_control] || null;
  const level = LEVEL[r.institution_level] || null;
  const twoYear = level === 'Two-year' || level === 'Less than two-year';
  const kind = control === 'Public' ? (twoYear ? 'Community college' : 'Public') : control === 'Private for-profit' ? 'Private for-profit' : control === 'Private nonprofit' ? 'Private nonprofit' : 'Specialized';
  const web = normalizeUrl(r.url_school) ? displayUrl(r.url_school) : null;
  return {
    id: existingId || String(r.unitid),
    unitid: String(r.unitid),
    scorecard_id: String(r.unitid),
    name: String(r.inst_name).trim(),
    short_name: String(r.inst_name).trim().slice(0, 60),
    alias: missing(r.inst_alias) ? null : String(r.inst_alias).trim().slice(0, 400) || null,
    city: r.city || null, state: r.state_abbr || null, zip: r.zip || null, county: missing(r.county_name) ? null : r.county_name,
    country: 'USA',
    kind, control, level,
    sector: num(r.sector), degree_granting: r.degree_granting === 1, highest_degree: num(r.offering_highest_degree),
    carnegie_basic: num(r.cc_basic_2021), locale: num(r.urban_centric_locale), region: num(r.region),
    lat: num(r.latitude), lon: num(r.longitude),
    website: web,
    admissions_url: normalizeUrl(r.url_application) ? displayUrl(r.url_application) : null,
    financial_aid_url: normalizeUrl(r.url_fin_aid) ? displayUrl(r.url_fin_aid) : null,
    net_price_calculator_url: normalizeUrl(r.url_netprice) ? displayUrl(r.url_netprice) : null,
    hbcu: r.hbcu === 1, tribal_college: r.tribal_college === 1, land_grant: r.land_grant === 1, medical_degree: r.medical_degree === 1,
    inst_size_category: num(r.inst_size),
    setting: localeToSetting(r.urban_centric_locale),
    active: r.currently_active_ipeds === 1,
    data_year: year,
    data_source: 'NCES IPEDS Institutional Characteristics (via Urban Institute Education Data Portal)',
    updated_at: new Date().toISOString(),
  };
}

/** NCES urban-centric locale (11–43) → the app's four settings. */
export function localeToSetting(code) {
  const c = Number(code);
  if (c >= 11 && c <= 13) return 'Urban';
  if (c >= 21 && c <= 23) return 'Suburban';
  if (c >= 31 && c <= 33) return 'Small city';
  if (c >= 41 && c <= 43) return 'Rural';
  return null;
}

// Each IPEDS URL field is a distinct official page published by the institution and reported to NCES.
export const URL_FIELDS = {
  url_school: { category: 'institution_home', label: 'Official website' },
  url_application: { category: 'college_admissions', label: 'Admissions application' },
  url_fin_aid: { category: 'financial_aid', label: 'Financial aid' },
  url_netprice: { category: 'affordability', label: 'Net price calculator' },
  url_veterans: { category: 'veterans', label: 'Veteran and military student benefits' },
  url_athletes: { category: 'athletics', label: 'Student-athlete graduation rates' },
  url_disability_services: { category: 'accessibility', label: 'Disability services' },
};

/** One IPEDS directory row → source-library records (official institution pages + federal profile pages). */
export function directoryToSources(r, year, collegeId) {
  const out = [];
  const name = String(r.inst_name).trim();
  const base = { organization: name, college_id: collegeId || String(r.unitid), geographic_scope: `US-${r.state_abbr || ''}`.replace(/-$/, ''), reliability_tier: 1, data_year: String(year) };
  for (const [field, meta] of Object.entries(URL_FIELDS)) {
    const key = normalizeUrl(r[field]);
    if (!key) continue;
    out.push({ ...base, url: displayUrl(r[field]), url_normalized: key, title: `${name} — ${meta.label}`, category: meta.category, source_type: 'official_institution_page',
      citation: { publisher: name, title: `${name}: ${meta.label}`, url: displayUrl(r[field]), via: `NCES IPEDS ${year} (${field})` },
      origin: `ipeds_directory:${year}`, origin_ref: `unitid=${r.unitid};field=${field}` });
  }
  if (r.currently_active_ipeds === 1) {
    const nav = `https://nces.ed.gov/collegenavigator/?id=${r.unitid}`;
    out.push({ ...base, organization: 'National Center for Education Statistics', url: nav, url_normalized: normalizeUrl(nav), title: `College Navigator — ${name}`, category: 'admissions_statistics', source_type: 'government_publication',
      citation: { publisher: 'U.S. Department of Education, NCES', title: `College Navigator: ${name}`, url: nav }, origin: `ipeds_directory:${year}`, origin_ref: `unitid=${r.unitid};page=college_navigator` });
  }
  if (r.currently_active_ipeds === 1 && r.title_iv_indicator === 1) {
    const sc = `https://collegescorecard.ed.gov/school/?${r.unitid}`;
    out.push({ ...base, organization: 'U.S. Department of Education', url: sc, url_normalized: normalizeUrl(sc), title: `College Scorecard — ${name}`, category: 'affordability', source_type: 'government_publication',
      citation: { publisher: 'U.S. Department of Education', title: `College Scorecard: ${name}`, url: sc }, origin: `ipeds_directory:${year}`, origin_ref: `unitid=${r.unitid};page=college_scorecard` });
  }
  return out;
}

/** Dataset-level source records (one per dataset/year actually used). */
export function datasetSource({ key, title, year, category, endpoint }) {
  const url = `https://educationdata.urban.org/api/v1/college-university/${endpoint.replace('{year}', year)}`;
  return { url, url_normalized: normalizeUrl(url), title: `${title} (${year})`, organization: 'NCES IPEDS via Urban Institute Education Data Portal', category, source_type: 'government_dataset', reliability_tier: 1, data_year: String(year), geographic_scope: 'US',
    citation: { publisher: 'U.S. Department of Education, National Center for Education Statistics (IPEDS); distributed by the Urban Institute Education Data Portal', title, year, url, documentation: URBAN_DOCS, license: 'ODC-By' }, origin: `dataset:${key}`, origin_ref: `${key}:${year}` };
}

// ---------- statistics ----------
const stat = (college_id, field, value, reporting_year, extra = {}) => (value === null || value === undefined || Number.isNaN(value) ? null : { college_id, field, value_num: value, reporting_year: String(reporting_year), verification: 'verified', confidence: 'high', ...extra });

/** Admissions-enrollment rows (sex=99 is the total) → applicants, admits, admit_rate, yield. */
export function admissionsStats(rows, year, idFor) {
  const out = [];
  for (const r of rows) {
    if (r.sex !== 99) continue;
    const id = idFor(r.unitid); if (!id) continue;
    const applied = num(r.number_applied), admitted = num(r.number_admitted), enrolled = num(r.number_enrolled_total);
    out.push(stat(id, 'applicants', applied, year), stat(id, 'admits', admitted, year), stat(id, 'enrolled_first_year', enrolled, year));
    if (applied && admitted !== null && applied > 0 && admitted <= applied) out.push(stat(id, 'admit_rate', +(admitted / applied).toFixed(4), year, { value_text: 'admitted / applied (all first-time applicants)' }));
    if (admitted && enrolled !== null && admitted > 0 && enrolled <= admitted) out.push(stat(id, 'yield_rate', +(enrolled / admitted).toFixed(4), year));
  }
  return out.filter(Boolean);
}

/** Admissions-requirements rows → test score percentiles, submission rates and test policy. */
export const TEST_POLICY = { 1: 'Required', 2: 'Recommended', 3: 'Neither required nor recommended', 4: 'Do not know', 5: 'Considered but not required' };
export function requirementsStats(rows, year, idFor) {
  const out = [];
  const F = { sat_rw_25: 'sat_crit_read_25_pctl', sat_rw_50: 'sat_crit_read_50_pctl', sat_rw_75: 'sat_crit_read_75_pctl', sat_math_25: 'sat_math_25_pctl', sat_math_50: 'sat_math_50_pctl', sat_math_75: 'sat_math_75_pctl', act_25: 'act_composite_25_pctl', act_50: 'act_composite_50_pctl', act_75: 'act_composite_75_pctl', sat_submit_pct: 'sat_percent_submitting', act_submit_pct: 'act_percent_submitting' };
  for (const r of rows) {
    const id = idFor(r.unitid); if (!id) continue;
    for (const [field, src] of Object.entries(F)) out.push(stat(id, field, num(r[src]), year));
    const sum = (a, b) => (num(r[a]) !== null && num(r[b]) !== null ? num(r[a]) + num(r[b]) : null);
    out.push(stat(id, 'sat_total_25_approx', sum('sat_crit_read_25_pctl', 'sat_math_25_pctl'), year, { value_text: 'Sum of section 25th percentiles — approximates, but is not, the composite 25th percentile', confidence: 'medium' }));
    out.push(stat(id, 'sat_total_75_approx', sum('sat_crit_read_75_pctl', 'sat_math_75_pctl'), year, { value_text: 'Sum of section 75th percentiles — approximation', confidence: 'medium' }));
    if (!missing(r.reqt_test_scores) && TEST_POLICY[r.reqt_test_scores]) out.push({ college_id: id, field: 'test_policy_ipeds', value_text: TEST_POLICY[r.reqt_test_scores], reporting_year: String(year), verification: 'verified', confidence: 'high' });
    if (r.open_admissions_policy === 1) out.push({ college_id: id, field: 'open_admission', value_text: 'Open admission', reporting_year: String(year), verification: 'verified', confidence: 'high' });
  }
  return out.filter(Boolean);
}

/** Undergraduate tuition & required fees (full-time): tuition_type 2 = in-district, 3 = in-state, 4 = out-of-state. */
export function tuitionStats(rows, year, idFor) {
  const out = [];
  for (const r of rows) {
    if (r.level_of_study !== 1) continue;
    const id = idFor(r.unitid); if (!id) continue;
    const v = num(r.tuition_fees_ft);
    if (r.tuition_type === 3) out.push(stat(id, 'tuition_in_state', v, year));
    else if (r.tuition_type === 4) out.push(stat(id, 'tuition_out_of_state', v, year));
    else if (r.tuition_type === 2) out.push(stat(id, 'tuition_in_district', v, year));
  }
  return out.filter(Boolean);
}
/** On-campus room & board (living_arrangement 1) and books. */
export function roomBoardStats(rows, year, idFor) {
  const out = [];
  for (const r of rows) {
    if (r.level_of_study !== 1) continue;
    const id = idFor(r.unitid); if (!id) continue;
    if (r.living_arrangement === 1) out.push(stat(id, 'room_board_on_campus', num(r.room_board), year), stat(id, 'other_expenses_on_campus', num(r.exp_other), year));
    if (r.living_arrangement === 1) out.push(stat(id, 'books_supplies', num(r.books_supplies), year));
  }
  return out.filter(Boolean);
}
export function retentionStats(rows, year, idFor) {
  return rows.filter((r) => r.ftpt === 1).map((r) => { const id = idFor(r.unitid); return id && stat(id, 'retention_full_time', num(r.retention_rate), year); }).filter(Boolean);
}
export function ratioStats(rows, year, idFor) {
  return rows.map((r) => { const id = idFor(r.unitid); return id && stat(id, 'student_faculty_ratio', num(r.student_faculty_ratio), year); }).filter(Boolean);
}
/** Fall undergraduate enrollment: race=99, sex=99, degree_seeking=99, class_level=99; ftpt 99 = total, 1 = full-time. */
export function enrollmentStats(rows, year, idFor) {
  const out = [];
  for (const r of rows) {
    if (r.race !== 99 || r.sex !== 99 || r.degree_seeking !== 99 || r.class_level !== 99) continue;
    const id = idFor(r.unitid); if (!id) continue;
    if (r.ftpt === 99) out.push(stat(id, 'undergrad_enrollment_fall', num(r.enrollment_fall), year));
    if (r.ftpt === 1) out.push(stat(id, 'undergrad_enrollment_fall_ft', num(r.enrollment_fall), year));
  }
  return out.filter(Boolean);
}
/** Graduation within 150% of normal time, total cohort (race=99, sex=99, subcohort=99). */
export function gradStats(rows, year, idFor) {
  return rows.filter((r) => r.race === 99 && r.sex === 99 && r.subcohort === 99).map((r) => { const id = idFor(r.unitid); return id && stat(id, 'grad_rate_150', num(r.completion_rate_150pct), year, { value_text: `Cohort entering ${r.cohort_year}; completion within 150% of normal time` }); }).filter(Boolean);
}
/** Average net price for full-time first-time students receiving grant aid (type_of_aid 3, all incomes). */
export function netPriceStats(rows, year, idFor) {
  const seen = new Set(); const out = [];
  for (const r of rows) {
    if (r.type_of_aid !== 3 || r.income_level !== 99 || r.level_of_study !== 1) continue;
    const id = idFor(r.unitid); if (!id || seen.has(id)) continue;
    const v = num(r.net_price); if (v === null) continue;
    seen.add(id);
    out.push(stat(id, 'avg_net_price', v, year, { value_text: 'Average net price, full-time first-time undergraduates awarded grant aid' }));
  }
  return out;
}

/** Find disagreements between two sources for the same field (> tolerance). Returns data_conflicts rows. */
export function findConflicts(a, b, { tolerance = 0.02 } = {}) {
  const idx = new Map(b.map((s) => [`${s.college_id}|${s.field}`, s]));
  const out = [];
  for (const s of a) {
    const t = idx.get(`${s.college_id}|${s.field}`);
    if (!t || s.value_num == null || t.value_num == null) continue;
    const rel = Math.abs(s.value_num - t.value_num) / Math.max(Math.abs(s.value_num), Math.abs(t.value_num), 1e-9);
    if (rel > tolerance) out.push({ college_id: s.college_id, field: s.field, observations: [{ value: s.value_num, reporting_year: s.reporting_year, source: s.library_source_id || s.source }, { value: t.value_num, reporting_year: t.reporting_year, source: t.library_source_id || t.source }] });
  }
  return out;
}

// ---------- BLS Occupational Outlook Handbook (XML compilation) ----------
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? m[1] : null; };
const text = (s) => (s == null ? null : s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim());
const qf = (occ, name) => { const block = tag(occ, name); return block == null ? null : text(tag(block, 'value')); };

export function parseOOH(xml) {
  const meta = { currentYear: text(tag(xml, 'current_year')), projectionYear: text(tag(xml, 'projection_year')), referencePeriod: text(tag(xml, 'reference_period')), lastUpdated: text(tag(xml, 'last_updated')) };
  const occs = xml.split(/<occupation>/).slice(1).map((s) => s.split(/<\/occupation>/)[0]);
  const careers = [];
  for (const o of occs) {
    const code = text(tag(o, 'occupation_code'));
    const title = text(tag(o, 'title'));
    // The profile's own URL is in its citation block (other sections link to similar occupations).
    const href = ((tag(o, 'citation') || '').match(/href="(https:\/\/www\.bls\.gov\/ooh\/[^"]+\.htm)"/) || [])[1];
    if (!code || !title || !href) continue;
    const soc = [...(tag(o, 'soc_coverage') || '').matchAll(/<soc_code[^>]*>([^<]+)<\/soc_code>/g)].map((m) => m[1].trim());
    const n = (s) => (s == null || s === '' || Number.isNaN(Number(String(s).replace(/,/g, ''))) ? null : Number(String(s).replace(/,/g, '')));
    const outlookBlock = tag(o, 'qf_employment_outlook') || '';
    careers.push({
      occupation_code: code, title, soc_codes: soc, description: text(tag(o, 'description')), ooh_url: href,
      median_pay_annual: n(qf(o, 'qf_median_pay_annual')), median_pay_hourly: n(qf(o, 'qf_median_pay_hourly')), pay_year: meta.referencePeriod,
      entry_education: qf(o, 'qf_entry_level_education') || null, work_experience: qf(o, 'qf_work_experience') || null, on_the_job_training: qf(o, 'qf_on_the_job_training') || null,
      employment: n(qf(o, 'qf_number_of_jobs')), employment_year: meta.currentYear,
      projected_change_pct: n(qf(o, 'qf_employment_outlook')), projection_period: meta.currentYear && meta.projectionYear ? `${meta.currentYear}–${meta.projectionYear}` : null,
      outlook_label: text(tag(outlookBlock, 'description')) || null, annual_openings: n(qf(o, 'qf_employment_openings')),
      data_published: text(tag(o, 'publish_date')) || null,
    });
  }
  return { meta, careers };
}
export function careerSource(c, meta) {
  return { url: c.ooh_url, url_normalized: normalizeUrl(c.ooh_url), title: `Occupational Outlook Handbook — ${c.title}`, organization: 'U.S. Bureau of Labor Statistics', category: 'employment_projections', source_type: 'government_publication', reliability_tier: 1,
    data_year: meta.referencePeriod || meta.currentYear, geographic_scope: 'US', career_soc: c.soc_codes[0] || null, summary: c.description, summary_is_ai: false,
    citation: { publisher: 'Bureau of Labor Statistics, U.S. Department of Labor', title: `Occupational Outlook Handbook, ${c.title}`, url: c.ooh_url, updated: meta.lastUpdated },
    origin: 'bls_ooh', origin_ref: `code=${c.occupation_code}` };
}

// ---------- CIP 2020 (NCES classification of instructional programs) ----------
/** Minimal RFC-4180 CSV parser (handles quotes, escaped quotes, CRLF, and NCES' ="…" Excel wrappers). */
export function parseCSV(input) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (q) { if (ch === '"') { if (input[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && input[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const clean = (v) => v.replace(/^=?"?|"$/g, '').replace(/^="(.*)"$/, '$1').trim();
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  const h = head.map(clean);
  return body.map((r) => Object.fromEntries(h.map((k, i) => [k, clean(r[i] ?? '')])));
}
export function cipToMajors(rows) {
  const titleCase = (t) => (t === t.toUpperCase() ? t.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(And|Of|The|In|For|To|Or|With)\b/g, (w) => w.toLowerCase()) : t);
  const families = new Map(rows.filter((r) => /^\d{2}$/.test(r.CIPCode)).map((r) => [r.CIPCode, titleCase(r.CIPTitle.replace(/\.$/, ''))]));
  return rows.filter((r) => /^\d{2}\.\d{4}$/.test(r.CIPCode) && !/^(Deleted|Moved)/i.test(r.Action || '')).map((r) => ({
    cip_code: r.CIPCode, title: r.CIPTitle.replace(/\.$/, ''), family_code: r.CIPCode.slice(0, 2), family_title: families.get(r.CIPCode.slice(0, 2)) || null,
    definition: r.CIPDefinition || null, updated_at: new Date().toISOString(),
  }));
}

/** IPEDS completions (race=99, sex=99, majornum=1) → college_majors rows. */
export function completionsToCollegeMajors(rows, year, idFor) {
  const out = [];
  for (const r of rows) {
    if (r.race !== 99 || r.sex !== 99 || r.majornum !== 1) continue;
    const id = idFor(r.unitid); if (!id) continue;
    const cip = String(r.cipcode_6digit).padStart(6, '0');
    if (cip === '000099' || cip === '000000' || !/^\d{6}$/.test(cip)) continue; // 99 = all programs total
    const completions = num(r.awards_6digit);
    if (!completions) continue;
    out.push({ college_id: id, cip_code: `${cip.slice(0, 2)}.${cip.slice(2)}`, award_level: r.award_level, completions, data_year: year });
  }
  return out;
}

/** Split long text into ~1,200-character chunks on paragraph/sentence boundaries for embedding. */
export function chunkText(t, size = 1200, overlap = 150) {
  const clean = String(t || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(clean.length, i + size);
    if (end < clean.length) { const cut = clean.lastIndexOf('. ', end); if (cut > i + size * 0.5) end = cut + 1; }
    chunks.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks;
}

/** De-duplicate source records by url_normalized, keeping the first (the most specific origin wins). */
export function dedupeSources(list) {
  const seen = new Map(); let dupes = 0, invalid = 0;
  for (const s of list) {
    if (!s.url_normalized || !s.title) { invalid++; continue; }
    if (seen.has(s.url_normalized)) { dupes++; continue; }
    seen.set(s.url_normalized, s);
  }
  return { sources: [...seen.values()], dupes, invalid };
}
