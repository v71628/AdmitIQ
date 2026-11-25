import type { College } from '../data/colleges';
import type { AppState } from './types';
import { rigor, unweighted, weighted } from './gpa';
import { distanceFromHome, regionOf } from './geo';
import { activityScore } from './activities';

export type Competitiveness = 'Highly competitive' | 'Competitive' | 'Possible' | 'Less competitive' | 'Open admission' | 'Insufficient data';
export type Bucket = 'Reach' | 'Target' | 'Likely';

export interface Assessment {
  college: College;
  competitiveness: Competitiveness;
  bucket: Bucket;
  academic: { label: string; detail: string }[];
  strengths: string[];
  weaknesses: string[];
  missing: string[];
  improvements: string[];
  strategy: string[];
  round: string;
  testing: string;
  major: string[];
  position: number | null; // internal academic index, not a probability
}

function on4(s: AppState): number | null {
  const p = s.profile;
  // Prefer the transcript once it is substantial; a handful of courses shouldn't override the reported GPA.
  const fromCourses = s.courses.length >= 6 ? unweighted(s.courses).value : null;
  if (fromCourses !== null) return fromCourses;
  if (p.gpaUnweighted === null) return null;
  const scale = p.gpaScale === '4.3' ? 4.3 : p.gpaScale === '5.0' ? 5 : p.gpaScale === '100' ? 100 : 4;
  if (scale === 100) return Math.max(0, Math.min(4, (p.gpaUnweighted - 60) / 10));
  return (p.gpaUnweighted / scale) * 4;
}

export function studentAcademics(s: AppState) {
  const sat = s.profile.sat.total, act = s.profile.act.composite;
  const r = rigor(s.courses);
  return { gpa4: on4(s), weighted: (s.courses.length >= 6 ? weighted(s.courses).value : null) ?? s.profile.gpaWeighted, sat, act, rigor: r };
}

function testPosition(score: number | null, range: [number, number] | null) {
  if (score === null || !range) return null;
  const [lo, hi] = range, mid = (lo + hi) / 2;
  if (score >= hi) return { v: 2, text: 'at or above the 75th percentile' };
  if (score >= mid) return { v: 1, text: 'in the upper half of the middle 50%' };
  if (score >= lo) return { v: 0, text: 'in the lower half of the middle 50%' };
  return { v: -1, text: 'below the 25th percentile' };
}

export function assess(c: College, s: AppState): Assessment {
  const a = studentAcademics(s);
  const strengths: string[] = [], weaknesses: string[] = [], missing: string[] = [], improvements: string[] = [], strategy: string[] = [], major: string[] = [];
  const academic: { label: string; detail: string }[] = [];
  const submitting = s.profile.testingStatus !== 'Not submitting scores';
  const considersTests = c.tests !== 'Test-free';

  // --- Academic index (internal, ordinal; never shown as a percentage) ---
  const parts: number[] = [];
  const satPos = considersTests && submitting ? testPosition(a.sat, c.sat) : null;
  const actPos = considersTests && submitting ? testPosition(a.act, c.act) : null;
  const best = [satPos, actPos].filter(Boolean).sort((x, y) => y!.v - x!.v)[0] || null;
  if (best) {
    parts.push(best.v);
    academic.push({ label: 'Testing', detail: `Your ${satPos && best === satPos ? 'SAT' : 'ACT'} is ${best.text} of reported enrolled/admitted students.` });
    (best.v >= 1 ? strengths : best.v < 0 ? weaknesses : []).push(`Test score ${best.text} (${c.short}).`);
  } else if (!considersTests) {
    academic.push({ label: 'Testing', detail: `${c.short} does not consider SAT/ACT scores; grades, rigor and context carry more weight.` });
  } else if (c.sat || c.act) {
    academic.push({ label: 'Testing', detail: a.sat || a.act ? 'You indicated you are not submitting scores.' : 'No test score entered.' });
  } else {
    academic.push({ label: 'Testing', detail: 'Test score ranges are unavailable for this school in the dataset.' });
  }

  if (a.gpa4 !== null) {
    const g = a.gpa4;
    const v = g >= 3.95 ? 2 : g >= 3.85 ? 1 : g >= 3.6 ? 0 : g >= 3.3 ? -1 : -2;
    // Highly selective schools: most admits are near the top of the class, so the scale shifts.
    const adj = c.admit !== null && c.admit < 0.15 ? v - 1 : c.admit !== null && c.admit > 0.5 ? v + 1 : v;
    parts.push(adj);
    academic.push({ label: 'Grades', detail: `Unweighted GPA ≈ ${g.toFixed(2)} on a 4.0 scale${c.gpaAvg ? `; ${c.short} publishes an average of ${c.gpaAvg} (their scale/method — not directly comparable)` : '; this school\'s average GPA is unavailable here'}.` });
    if (adj >= 1) strengths.push('Grades are strong relative to this school\'s selectivity.');
    if (adj < 0) weaknesses.push('Grades are below what is typical for admitted students at this selectivity level.');
  } else missing.push('GPA (enter your transcript or overall GPA)');

  const rg = a.rigor;
  if (rg.total) {
    const adv = rg.advanced;
    const v = adv >= 8 ? 1 : adv >= 4 ? 0 : -1;
    if (c.admit !== null && c.admit < 0.3) parts.push(v);
    academic.push({ label: 'Course rigor', detail: `${adv} AP/IB/dual-enrollment and ${rg.honors} honors courses entered. Colleges judge rigor relative to what your school offers, which AdmitIQ cannot see.` });
    if (adv >= 8) strengths.push('Demanding course load (8+ advanced courses).');
    else if (adv < 4 && c.admit !== null && c.admit < 0.3) improvements.push('If your school offers them, advanced courses in senior year signal rigor (your counselor report will describe what was available).');
  } else missing.push('Courses (transcript) for a rigor assessment');

  const position = parts.length ? parts.reduce((x, y) => x + y, 0) / parts.length : null;

  // --- Competitiveness + bucket ---
  let competitiveness: Competitiveness;
  let bucket: Bucket;
  if (c.kind === 'Community college') { competitiveness = 'Open admission'; bucket = 'Likely'; }
  else if (c.admit === null) { competitiveness = 'Insufficient data'; bucket = position !== null && position >= 1 ? 'Target' : 'Reach'; }
  else if (c.admit < 0.15) {
    competitiveness = 'Highly competitive'; bucket = 'Reach';
    strategy.push(`With an admit rate around ${Math.round(c.admit * 100)}%, ${c.short} is a reach for every applicant, including those with top academics.`);
  } else if (position === null) {
    competitiveness = c.admit < 0.35 ? 'Competitive' : 'Possible'; bucket = c.admit < 0.35 ? 'Reach' : 'Target';
  } else {
    if (c.admit < 0.35) { competitiveness = position >= 1 ? 'Competitive' : 'Highly competitive'; bucket = position >= 1.5 ? 'Target' : 'Reach'; }
    else if (c.admit < 0.6) { competitiveness = position >= 1 ? 'Possible' : position >= 0 ? 'Competitive' : 'Highly competitive'; bucket = position >= 1.5 ? 'Likely' : position >= 0 ? 'Target' : 'Reach'; }
    else { competitiveness = position >= 0 ? 'Less competitive' : 'Possible'; bucket = position >= 0 ? 'Likely' : 'Target'; }
  }

  // --- Activities ---
  const acts = s.activities.map(activityScore);
  if (!s.activities.length) missing.push('Extracurricular activities');
  else {
    const top = acts.filter((x) => x.total >= 70).length;
    if (top >= 2) strengths.push(`${top} activities show sustained commitment with leadership or measurable impact.`);
    if (acts.every((x) => x.leadership < 40) && c.admit !== null && c.admit < 0.3) improvements.push('None of your activities show a leadership role or initiative yet — taking on responsibility in one you already care about helps more than adding new ones.');
  }
  if (!s.essays.length) missing.push('Essays (draft your personal statement in the Essay Lab)');

  // --- Major ---
  const m = s.profile.intendedMajor;
  if (!m) missing.push('Intended major');
  else if (!c.majors.includes(m)) major.push(`${m} is not listed for ${c.short} in AdmitIQ's dataset — confirm on the official program list before applying.`);
  else major.push(`${m} is offered.`);
  if (m === 'Computer Science' && ['uiuc', 'uw', 'utaustin', 'gatech', 'umich', 'berkeley', 'ucla', 'purdue', 'cmu', 'wisc', 'uf'].includes(c.id)) {
    major.push(`Computer science at ${c.short} is widely reported to be more selective than the university overall (some schools admit directly into the major with separate capacity limits). Check whether your second-choice major is considered.`);
  }
  if (m === 'Nursing' && c.kind !== 'Community college') major.push('Nursing programs often admit directly into the major with limited seats; confirm whether direct-entry is offered.');
  if (c.notes?.toLowerCase().includes('major')) major.push(c.notes);

  // --- Testing recommendation (rule-based, based on published policy) ---
  let testing = '';
  const myScore = a.sat ?? (a.act ? a.act : null);
  if (c.tests === 'Required') testing = `Required: ${c.short} expects SAT or ACT scores${myScore ? '. You have a score on file — submit it' : '. You have no score on file yet — plan a test date before the deadline'}.`;
  else if (c.tests === 'Test-free') testing = `Do not send scores: ${c.short} does not consider SAT/ACT in admission decisions.`;
  else if (c.tests === 'Optional') {
    if (!myScore) testing = 'Optional: applying without scores is allowed.';
    else if (best && best.v >= 1) testing = 'Optional — common counselor guidance (opinion): submit when your score is at or above the middle of the published range, as yours is.';
    else if (best && best.v === 0) testing = 'Optional — judgment call (opinion): your score is in the lower half of the middle 50%. Submitting can still help if it is strong for your high school; ask your counselor.';
    else if (best) testing = 'Optional — common counselor guidance (opinion): consider applying test-optional, since your score is below the published middle 50%.';
    else testing = 'Optional: no published range in this dataset to compare against.';
  } else testing = 'Testing policy varies by program — check the specific program\'s requirements.';

  // --- Round / strategy ---
  const fav = s.list.find((l) => l.collegeId === c.id)?.favorite;
  let round = c.rounds.includes('RD') ? 'Regular Decision' : c.rounds[0] || '—';
  if (c.rounds.includes('EA')) { round = 'Early Action (non-binding)'; strategy.push('EA is non-binding and gets you an earlier answer; there is little downside if your application is ready.'); }
  if (c.rounds.includes('REA')) { round = 'Restrictive Early Action (if it is your top choice)'; strategy.push('REA usually restricts applying early to other private schools — read the policy.'); }
  if ((c.rounds.includes('ED') || c.rounds.includes('ED2')) && fav) {
    round = 'Consider Early Decision (binding)';
    strategy.push('Early Decision is binding. Only apply ED if this is your clear first choice and you have run the net price calculator — you cannot compare aid offers.');
  } else if (c.rounds.includes('ED')) strategy.push('Offers binding Early Decision. Mark it as a favorite if it is your first choice to see ED guidance.');
  if (c.rounds.includes('Rolling')) strategy.push('Rolling admission: apply early in the cycle; decisions and merit funds are released as applications arrive.');
  const budget = s.financial.maxAnnualCost;
  const inState = s.profile.state === c.state;
  const coa = c.kind === 'Public' ? (inState ? c.coaIn : c.coaOut) : c.coaIn;
  if (budget && coa && coa > budget * 1.25) strategy.push(`Sticker cost (${fmtUSD(coa)}/yr) is well above your budget — run the official net price calculator before investing in this application.`);
  if (c.features.some((f) => /merit/i.test(f)) && s.financial.meritPreference) strategy.push('Offers merit scholarships; check whether a separate application or early deadline is required.');

  if (!s.profile.sat.total && !s.profile.act.composite && c.tests === 'Required') improvements.push('Register for the SAT or ACT — this school requires scores.');
  if (s.profile.trend === 'Upward') strengths.push('Upward grade trend (explainable in your application).');
  if (s.profile.trend === 'Downward') improvements.push('A downward trend may raise questions; if there was context, the Additional Information section is the place to explain it briefly.');

  return { college: c, competitiveness, bucket, academic, strengths, weaknesses, missing, improvements, strategy, round, testing, major, position };
}

export function fmtUSD(n: number | null | undefined) {
  if (n === null || n === undefined) return 'Unavailable';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// --- Fit scoring for the list builder (0–100). Explains every factor. ---
export interface Fit { college: College; score: number; reasons: string[]; concerns: string[]; bucket: Bucket; cost: number | null }

export function fit(c: College, s: AppState): Fit {
  const reasons: string[] = [], concerns: string[] = [];
  let score = 50;
  const m = s.profile.intendedMajor;
  if (m) { if (c.majors.includes(m)) { score += 12; reasons.push(`Offers ${m}`); } else { score -= 25; concerns.push(`${m} not listed`); } }
  const p = s.personal;
  if (p.settings.length) { if ((p.settings as string[]).includes(c.setting)) { score += 8; reasons.push(`${c.setting} setting`); } else { score -= 6; concerns.push(`${c.setting} setting`); } }
  if (p.regions.length) { const r = regionOf(c.state, c.country); if (p.regions.includes(r)) { score += 8; reasons.push(`In ${r}`); } else { score -= 6; } }
  if (p.kinds.length) { if (p.kinds.includes(c.kind)) { score += 5; reasons.push(c.kind); } else score -= 5; }
  if (p.size !== 'Any' && c.undergrad) {
    const sz = c.undergrad < 5000 ? 'Small (<5k)' : c.undergrad < 15000 ? 'Medium (5k–15k)' : 'Large (15k+)';
    if (sz === p.size) { score += 6; reasons.push(`${p.size.split(' ')[0]} campus`); } else score -= 4;
  }
  if (p.maxDistance && s.profile.state) {
    const d = distanceFromHome(s.profile.state, c);
    if (d !== null) { if (d <= p.maxDistance) { score += 5; reasons.push(`~${d} mi from home`); } else { score -= 8; concerns.push(`~${d} mi away (beyond your ${p.maxDistance} mi)`); } }
  }
  if (p.wantsResearch && c.features.some((f) => /research/i.test(f))) { score += 4; reasons.push('Undergraduate research'); }
  if (p.wantsInternships && c.features.some((f) => /co-op|internship/i.test(f))) { score += 4; reasons.push('Co-op/internship program'); }
  const inState = s.profile.state === c.state;
  const cost = c.netPrice ?? (c.kind === 'Public' ? (inState ? c.coaIn : c.coaOut) : c.coaIn);
  const budget = s.financial.maxAnnualCost;
  if (budget && cost) {
    if (cost <= budget) { score += 10; reasons.push('Average net price within budget'); }
    else if (cost <= budget * 1.3) { concerns.push('Average net price slightly above budget'); }
    else { score -= 12; concerns.push('Average net price well above budget'); }
  }
  if (c.kind === 'Public' && inState) { score += 4; reasons.push('In-state public'); }
  if (s.financial.meritPreference && c.features.some((f) => /merit/i.test(f))) { score += 4; reasons.push('Merit aid offered'); }
  if (c.grad !== null && c.grad >= 0.9) { score += 3; }
  const a = assess(c, s);
  return { college: c, score: Math.max(0, Math.min(100, Math.round(score))), reasons, concerns, bucket: a.bucket, cost };
}

export function recommendList(colleges: College[], s: AppState, perBucket = 4) {
  const fits = colleges.filter((c) => (c.kind !== 'International' || s.personal.regions.includes('International')) && (c.kind !== 'Community college' || c.state === s.profile.state)).map((c) => fit(c, s)).sort((x, y) => y.score - x.score);
  const out: Record<Bucket, Fit[]> = { Reach: [], Target: [], Likely: [] };
  for (const f of fits) if (out[f.bucket].length < perBucket && f.score >= 35) out[f.bucket].push(f);
  return out;
}
