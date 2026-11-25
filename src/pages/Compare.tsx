import React, { useMemo, useState } from 'react';
import { LuArrowLeft, LuArrowRight, LuCopy, LuDownload, LuPlus, LuPrinter, LuX } from 'react-icons/lu';
import { navigate } from '../App';
import { Badge, Button, Card, Chips, EmptyState, Modal, PageHeader, Select, SourceTag, bucketTone, copyText, cx, downloadFile, useToast } from '../components/ui';
import { ChartCard, HBars, PALETTE, Radar, RangeChart, StackedBars } from '../components/charts';
import { COLLEGES, DATA_META, type College } from '../data/colleges';
import { store, useStore } from '../lib/store';
import { assess, fit } from '../lib/analysis';
import { distanceFromHome } from '../lib/geo';
import { num, pct, prov, range, toCSV, usd } from '../lib/format';
import type { AppState } from '../lib/types';

type Metric = { id: string; group: string; label: string; get: (c: College, s: AppState) => string; raw?: (c: College, s: AppState) => number | null; better?: 'high' | 'low'; field?: keyof typeof DATA_META.confidence };
const isPub = (c: College) => c.kind === 'Public' || c.kind === 'Community college';
const coa = (c: College, s: AppState) => (isPub(c) && s.profile.state !== c.state ? c.coaOut : c.coaIn);
const tuit = (c: College, s: AppState) => (isPub(c) && s.profile.state !== c.state ? c.tuitionOut : c.tuitionIn);

const METRICS: Metric[] = [
  { id: 'admit', group: 'Admissions', label: 'Acceptance rate', get: (c) => (c.kind === 'Community college' ? 'Open' : pct(c.admit)), raw: (c) => c.admit, better: 'high', field: 'admit' },
  { id: 'ed', group: 'Admissions', label: 'ED / EA / RD rates', get: () => 'Unavailable' },
  { id: 'rounds', group: 'Admissions', label: 'Rounds offered', get: (c) => c.rounds.join(', ') || '—', field: 'deadlines' },
  { id: 'sat', group: 'Admissions', label: 'SAT middle 50%', get: (c) => range(c.sat), raw: (c) => (c.sat ? (c.sat[0] + c.sat[1]) / 2 : null), field: 'sat' },
  { id: 'act', group: 'Admissions', label: 'ACT middle 50%', get: (c) => range(c.act), raw: (c) => (c.act ? (c.act[0] + c.act[1]) / 2 : null), field: 'act' },
  { id: 'gpa', group: 'Admissions', label: 'Avg HS GPA (published)', get: (c) => (c.gpaAvg ? String(c.gpaAvg) : 'Unavailable') },
  { id: 'tests', group: 'Admissions', label: 'Testing policy', get: (c) => c.tests, field: 'tests' },
  { id: 'bucket', group: 'Admissions', label: 'Your estimate', get: (c, s) => assess(c, s).bucket },
  { id: 'major', group: 'Academics', label: 'Your major offered', get: (c, s) => (!s.profile.intendedMajor ? 'Set a major' : c.majors.includes(s.profile.intendedMajor) ? 'Yes' : 'Not listed') },
  { id: 'sfr', group: 'Academics', label: 'Student-to-faculty ratio', get: (c) => (c.sfr ? `${c.sfr}:1` : 'Unavailable'), raw: (c) => c.sfr, better: 'low', field: 'sfr' },
  { id: 'research', group: 'Academics', label: 'Undergrad research program', get: (c) => (c.features.some((f) => /research|urop|urap/i.test(f)) ? 'Yes' : 'Not listed') },
  { id: 'intern', group: 'Academics', label: 'Co-op / internship program', get: (c) => (c.features.some((f) => /co-op|internship/i.test(f)) ? 'Yes' : 'Not listed') },
  { id: 'honors', group: 'Academics', label: 'Honors college', get: (c) => (c.features.some((f) => /honors/i.test(f)) ? 'Yes' : 'Not listed') },
  { id: 'tuition', group: 'Financials', label: 'Tuition & fees (your rate)', get: (c, s) => usd(tuit(c, s)), raw: (c, s) => tuit(c, s), better: 'low', field: 'tuition' },
  { id: 'housing', group: 'Financials', label: 'Housing & meals', get: (c) => usd(c.housingMeals), raw: (c) => c.housingMeals, better: 'low', field: 'coa' },
  { id: 'coa', group: 'Financials', label: 'Total cost of attendance', get: (c, s) => usd(coa(c, s)), raw: (c, s) => coa(c, s), better: 'low', field: 'coa' },
  { id: 'net', group: 'Financials', label: 'Average net price', get: (c) => usd(c.netPrice), raw: (c) => c.netPrice, better: 'low', field: 'netPrice' },
  { id: 'fourYear', group: 'Financials', label: '4-yr sticker cost (+3%/yr)', get: (c, s) => { const v = coa(c, s); return v === null ? 'Unavailable' : usd(Math.round(v * (1 + 1.03 + 1.03 ** 2 + 1.03 ** 3))); }, raw: (c, s) => coa(c, s), better: 'low' },
  { id: 'merit', group: 'Financials', label: 'Merit scholarships', get: (c) => (c.features.some((f) => /merit/i.test(f)) ? 'Offered' : 'Not listed') },
  { id: 'need', group: 'Financials', label: 'Meets full need', get: (c) => (c.features.some((f) => /full need/i.test(f)) ? 'Yes' : 'Not listed') },
  { id: 'debt', group: 'Financials', label: 'Median federal debt', get: (c) => usd(c.debt), raw: (c) => c.debt, better: 'low', field: 'debt' },
  { id: 'npi', group: 'Financials', label: 'Net price by income', get: () => 'Unavailable' },
  { id: 'kind', group: 'Student experience', label: 'Type', get: (c) => c.kind },
  { id: 'setting', group: 'Student experience', label: 'Setting', get: (c) => c.setting },
  { id: 'size', group: 'Student experience', label: 'Undergraduates', get: (c) => num(c.undergrad), raw: (c) => c.undergrad, field: 'undergrad' },
  { id: 'loc', group: 'Student experience', label: 'Location', get: (c) => `${c.city}, ${c.state}` },
  { id: 'dist', group: 'Student experience', label: 'Distance from home (rough)', get: (c, s) => { const d = s.profile.state ? distanceFromHome(s.profile.state, c) : null; return d === null ? 'Set home state' : `${d.toLocaleString()} mi`; }, raw: (c, s) => (s.profile.state ? distanceFromHome(s.profile.state, c) : null), better: 'low' },
  { id: 'safety', group: 'Student experience', label: 'Safety statistics', get: () => 'Unavailable — see Clery Act report' },
  { id: 'grad', group: 'Outcomes', label: '6-year graduation rate', get: (c) => pct(c.grad), raw: (c) => c.grad, better: 'high', field: 'grad' },
  { id: 'ret', group: 'Outcomes', label: 'First-year retention', get: (c) => pct(c.retention), raw: (c) => c.retention, better: 'high', field: 'retention' },
  { id: 'earn', group: 'Outcomes', label: 'Median earnings (~10 yrs)', get: (c) => usd(c.earnings), raw: (c) => c.earnings, better: 'high', field: 'earnings' },
  { id: 'fit', group: 'Outcomes', label: 'AdmitIQ fit score', get: (c, s) => `${fit(c, s).score}/100`, raw: (c, s) => fit(c, s).score, better: 'high' },
];
const GROUPS = ['Admissions', 'Academics', 'Financials', 'Student experience', 'Outcomes'];

export default function Compare() {
  const s = useStore((x) => x);
  const toast = useToast();
  const [hidden, setHidden] = useState<string[]>(['ed', 'npi', 'safety', 'honors']);
  const [groups, setGroups] = useState<string[]>(GROUPS);
  const [picker, setPicker] = useState(false);
  const [add, setAdd] = useState('');
  const colleges = s.compare.map((id) => COLLEGES.find((c) => c.id === id)!).filter(Boolean);
  const metrics = METRICS.filter((m) => !hidden.includes(m.id) && groups.includes(m.group));
  const move = (i: number, d: number) => store.set((st) => { const j = i + d; if (j < 0 || j >= st.compare.length) return; [st.compare[i], st.compare[j]] = [st.compare[j], st.compare[i]]; });
  const best = (m: Metric) => {
    if (!m.raw || !m.better) return null;
    const vals = colleges.map((c) => m.raw!(c, s)).filter((v): v is number => v !== null);
    if (vals.length < 2) return null;
    return m.better === 'high' ? Math.max(...vals) : Math.min(...vals);
  };
  const radar = useMemo(() => {
    const maxNet = Math.max(1, ...colleges.map((c) => c.netPrice ?? 0));
    const maxEarn = Math.max(1, ...colleges.map((c) => c.earnings ?? 0));
    return colleges.map((c, i) => ({
      name: c.short, color: PALETTE[i],
      values: [c.admit === null ? null : 1 - c.admit, c.sat ? (c.sat[1] - 1000) / 600 : null, c.grad, c.retention, c.netPrice === null ? null : 1 - c.netPrice / (maxNet * 1.15), c.earnings === null ? null : c.earnings / maxEarn],
      raw: [pct(c.admit), range(c.sat), pct(c.grad), pct(c.retention), usd(c.netPrice), usd(c.earnings)],
    }));
  }, [s.compare]);

  function rows() { return [['Metric', ...colleges.map((c) => c.name)], ...metrics.map((m) => [m.label, ...colleges.map((c) => m.get(c, s))])]; }
  function exportCSV() {
    const csv = toCSV([...rows(), [], ['Source', `${DATA_META.sources} (${DATA_META.label}, ${DATA_META.reportingYears})`], ['Exported', new Date().toISOString()]]);
    if (!downloadFile('admitiq-comparison.csv', csv, 'text/csv')) copyText(csv).then(() => toast('Download blocked here — CSV copied to clipboard', 'info'));
    else toast('Comparison exported');
  }
  async function copyMd() {
    const r = rows();
    const md = [`| ${r[0].join(' | ')} |`, `|${r[0].map(() => '---').join('|')}|`, ...r.slice(1).map((x) => `| ${x.join(' | ')} |`), '', `_Source: ${DATA_META.sources} — ${DATA_META.label}, ${DATA_META.reportingYears}. Exported from AdmitIQ ${new Date().toLocaleDateString()}._`].join('\n');
    toast((await copyText(md)) ? 'Markdown table copied' : 'Copy failed', 'info');
  }

  if (colleges.length < 2) {
    return (
      <>
        <PageHeader title="Compare colleges" desc="Choose 2–10 colleges to compare side by side." />
        <Card><EmptyState title={colleges.length ? 'Add one more college' : 'Nothing to compare yet'} body="Pick from your list, or use Compare buttons in search." action={<div className="flex flex-wrap justify-center gap-2">{s.list.length >= 2 && <Button variant="primary" onClick={() => store.set((st) => { st.compare = st.list.slice(0, 10).map((l) => l.collegeId); })}>Compare my list ({Math.min(10, s.list.length)})</Button>}<Button onClick={() => setPicker(true)} icon={<LuPlus />}>Choose colleges</Button></div>} /></Card>
        <PickerModal open={picker} onClose={() => setPicker(false)} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Compare colleges" desc={`${colleges.length} colleges · ${metrics.length} metrics. Best value per row is highlighted where "better" is clear.`}
        actions={<><Button icon={<LuPlus />} onClick={() => setPicker(true)} disabled={colleges.length >= 10}>Add</Button><Button icon={<LuCopy />} onClick={copyMd}>Copy table</Button><Button icon={<LuDownload />} onClick={exportCSV}>Export CSV</Button><Button icon={<LuPrinter />} onClick={() => { try { window.print(); } catch { toast('Printing is not available here', 'error'); } }}>Print</Button></>} />
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-3"><span className="text-sm font-medium text-ink">Categories</span><Chips options={GROUPS} value={groups} onChange={setGroups} /></div>
        <details className="mt-3"><summary className="cursor-pointer text-sm text-accent">Toggle individual metrics ({METRICS.length - hidden.length} shown)</summary>
          <div className="mt-3 flex flex-wrap gap-2">{METRICS.map((m) => <button key={m.id} aria-pressed={!hidden.includes(m.id)} onClick={() => setHidden((h) => (h.includes(m.id) ? h.filter((x) => x !== m.id) : [...h, m.id]))} className={cx('h-8 rounded-full border px-3 text-xs', !hidden.includes(m.id) ? 'border-accent/40 bg-accent/10 text-ink' : 'border-line text-muted')}>{m.label}</button>)}</div>
        </details>
      </Card>

      <Card className="overflow-hidden">
        <div className="scroll overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="sticky left-0 z-10 w-48 bg-surface px-4 py-3 text-left font-medium text-muted">Metric</th>
                {colleges.map((c, i) => (
                  <th key={c.id} className="min-w-[150px] px-3 py-3 text-left align-top">
                    <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PALETTE[i] }} /><a href={`#college-${c.id}`} className="font-semibold text-ink hover:text-accent">{c.short}</a></div>
                    <div className="mt-1.5 flex gap-0.5">
                      <button aria-label={`Move ${c.short} left`} disabled={i === 0} onClick={() => move(i, -1)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised disabled:opacity-30"><LuArrowLeft /></button>
                      <button aria-label={`Move ${c.short} right`} disabled={i === colleges.length - 1} onClick={() => move(i, 1)} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised disabled:opacity-30"><LuArrowRight /></button>
                      <button aria-label={`Remove ${c.short}`} onClick={() => store.set((st) => { st.compare = st.compare.filter((x) => x !== c.id); })} className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-rose-600"><LuX /></button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GROUPS.filter((g) => groups.includes(g)).map((g) => {
                const ms = metrics.filter((m) => m.group === g);
                if (!ms.length) return null;
                return (
                  <React.Fragment key={g}>
                    <tr><td colSpan={colleges.length + 1} className="sticky left-0 bg-raised/60 px-4 py-2 text-xs font-semibold text-muted">{g}</td></tr>
                    {ms.map((m) => {
                      const b = best(m);
                      return (
                        <tr key={m.id} className="border-b border-line last:border-0 hover:bg-raised/40">
                          <td className="sticky left-0 z-10 bg-surface px-4 py-2.5 text-muted">{m.label}</td>
                          {colleges.map((c) => {
                            const v = m.get(c, s), r = m.raw?.(c, s) ?? null, isBest = b !== null && r === b;
                            return <td key={c.id} className={cx('px-3 py-2.5 tabular-nums', v.startsWith('Unavailable') ? 'text-muted' : 'text-ink', isBest && 'font-semibold text-teal')}>
                              {m.id === 'bucket' ? <Badge tone={bucketTone(v)}>{v}</Badge> : v}
                              {m.field && !v.startsWith('Unavailable') && m.id === 'admit' && <span className="ml-1.5 inline-block align-middle"><SourceTag {...prov(c, m.field, r)} /></span>}
                            </td>;
                          })}
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-4 py-3 text-xs text-muted">Source: {DATA_META.sources} · {DATA_META.label}, {DATA_META.reportingYears}. Tap a tag for details. Estimates and fit scores are AdmitIQ interpretations.</p>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <ChartCard title="Profile shape" desc="Each axis is scaled 0–1 within this comparison (selectivity = 1 − admit rate; affordability = lower net price). Hover points for actual values." source={`${DATA_META.sources} (${DATA_META.label}) · normalization by AdmitIQ`} legend={colleges.map((c, i) => ({ label: c.short, color: PALETTE[i] }))}>
          <Radar axes={['Selectivity', 'SAT (75th)', 'Graduation', 'Retention', 'Affordability', 'Earnings']} series={radar} size={340} />
        </ChartCard>
        <ChartCard title="SAT middle 50%" desc="Dashed line marks your score." source={`${DATA_META.sources} (${DATA_META.label})`}>
          <RangeChart rows={colleges.map((c) => ({ label: c.short, lo: c.sat?.[0] ?? null, hi: c.sat?.[1] ?? null, note: c.tests === 'Test-free' ? 'Test-free' : 'Unavailable' }))} min={1000} max={1600} you={s.profile.sat.total} youLabel="You" />
        </ChartCard>
        <ChartCard title="Cost breakdown (your rate, per year)" source={`${DATA_META.sources} (${DATA_META.label})`} legend={[{ label: 'Tuition & fees', color: 'var(--c1)' }, { label: 'Housing & meals', color: 'var(--c2)' }, { label: 'Other', color: 'var(--c3)' }]}>
          <StackedBars format={usd} keys={[{ key: 't', label: 'Tuition & fees', color: 'var(--c1)' }, { key: 'h', label: 'Housing & meals', color: 'var(--c2)' }, { key: 'o', label: 'Books, travel, personal', color: 'var(--c3)' }]}
            rows={colleges.map((c) => { const t = tuit(c, s), total = coa(c, s); return { label: c.short, total, parts: (t === null ? {} : { t, h: c.housingMeals ?? 0, o: total !== null && c.housingMeals !== null ? Math.max(0, total - t - c.housingMeals) : 0 }) as Record<string, number> }; })} />
        </ChartCard>
        <ChartCard title="Average net price" desc="What aided students paid on average." source={`${DATA_META.sources} (${DATA_META.label})`}>
          <HBars data={colleges.map((c, i) => ({ label: c.short, value: c.netPrice, color: PALETTE[i] }))} format={usd} />
        </ChartCard>
        <ChartCard title="Graduation & retention" source={`${DATA_META.sources} (${DATA_META.label})`} legend={[{ label: '6-yr graduation', color: 'var(--c1)' }, { label: 'Retention', color: 'var(--c3)' }]}>
          <div className="space-y-5"><HBars data={colleges.map((c) => ({ label: c.short, value: c.grad, color: 'var(--c1)' }))} max={1} format={(v) => pct(v)} /><HBars data={colleges.map((c) => ({ label: c.short, value: c.retention, color: 'var(--c3)' }))} max={1} format={(v) => pct(v)} /></div>
        </ChartCard>
        <ChartCard title="Median earnings ~10 years after entry" desc="Institution-wide; not major-specific. Low confidence." source={`${DATA_META.sources} (${DATA_META.label})`}>
          <HBars data={colleges.map((c, i) => ({ label: c.short, value: c.earnings, color: PALETTE[i] }))} format={usd} />
        </ChartCard>
      </div>
      <PickerModal open={picker} onClose={() => setPicker(false)} value={add} setValue={setAdd} />
    </>
  );
}

function PickerModal({ open, onClose, value, setValue }: { open: boolean; onClose: () => void; value?: string; setValue?: (v: string) => void }) {
  const s = useStore((x) => x);
  const [local, setLocal] = useState('');
  const v = value ?? local, setV = setValue ?? setLocal;
  const avail = COLLEGES.filter((c) => !s.compare.includes(c.id));
  return (
    <Modal open={open} onClose={onClose} title="Add colleges to compare" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="flex gap-2"><Select aria-label="College" value={v} onChange={(e) => setV(e.target.value)} options={[{ value: '', label: 'Choose a college' }, ...avail.map((c) => ({ value: c.id, label: c.name }))]} /><Button variant="primary" disabled={!v || s.compare.length >= 10} onClick={() => { store.set((st) => { st.compare = [...st.compare, v].slice(0, 10); }); setV(''); }}>Add</Button></div>
      {s.list.length > 0 && <><p className="mt-5 mb-2 text-sm font-medium text-ink">From your list</p><div className="flex flex-wrap gap-2">{s.list.filter((l) => !s.compare.includes(l.collegeId)).map((l) => { const c = COLLEGES.find((x) => x.id === l.collegeId)!; return <Button key={c.id} size="sm" icon={<LuPlus />} disabled={s.compare.length >= 10} onClick={() => store.set((st) => { st.compare = [...st.compare, c.id].slice(0, 10); })}>{c.short}</Button>; })}</div></>}
      <p className="mt-4 text-xs text-muted">{s.compare.length}/10 selected.</p>
      {s.compare.length > 0 && <button className="mt-2 text-sm text-accent hover:underline" onClick={() => navigate('compare')}>Back to comparison</button>}
    </Modal>
  );
}
