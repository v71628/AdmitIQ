import React, { useMemo, useState } from 'react';
import { LuPlus, LuX } from 'react-icons/lu';
import { Badge, Button, Card, CardHeader, EmptyState, ExtLink, Field, Notice, NumberInput, PageHeader, Select, Tabs, cx } from '../components/ui';
import { ChartCard, HBars, PALETTE, StackedBars } from '../components/charts';
import { COLLEGES, DATA_META, NPC_CENTER, npcSearchUrl } from '../data/colleges';
import { useStore } from '../lib/store';
import { DEFAULT_COST, computeCost, type CostInputs } from '../lib/cost';
import { byId, usd, usdK } from '../lib/format';
import { OfferComparer } from '../components/offers';

type Aid = { grants: number; merit: number; scholarships: number; loans: number };
const SRC = `${DATA_META.sources} (${DATA_META.label}, ${DATA_META.reportingYears}) + your inputs`;

export default function Costs() {
  const s = useStore((x) => x);
  const [ids, setIds] = useState<string[]>(() => s.list.slice(0, 4).map((l) => l.collegeId).filter((id) => byId(id)?.tuitionIn !== null));
  const [base, setBase] = useState<CostInputs>({ ...DEFAULT_COST, homeState: s.profile.state });
  const [aid, setAid] = useState<Record<string, Aid>>({});
  const [focus, setFocus] = useState<string>('');
  const [addId, setAddId] = useState('');
  const [view, setView] = useState<'compare' | 'scenarios' | 'offers'>(() => (s.apps.some((a) => a.status === 'Accepted') || s.offers.length ? 'offers' : 'compare'));
  const getAid = (id: string): Aid => aid[id] || { grants: 0, merit: 0, scholarships: 0, loans: 0 };
  const results = useMemo(() => ids.map((id) => computeCost(byId(id)!, { ...base, ...getAid(id) })), [ids, base, aid]);
  const f = focus && ids.includes(focus) ? focus : ids[0];
  const fc = f ? byId(f)! : null;
  const scenarios = useMemo(() => {
    if (!fc) return [];
    const mk = (label: string, p: Partial<CostInputs>) => ({ label, r: computeCost(fc, { ...base, ...getAid(fc.id), ...p }) });
    const out = [mk('On campus', { living: 'on-campus' }), mk('Living at home', { living: 'at-home' }), mk('Off campus', { living: 'off-campus' })];
    if (fc.kind === 'Public') out.unshift(mk('In-state, on campus', { residency: 'in-state', living: 'on-campus' }), mk('Out-of-state, on campus', { residency: 'out-of-state', living: 'on-campus' }));
    return out;
  }, [fc, base, aid]);
  const budget = s.financial.maxAnnualCost;

  return (
    <>
      <PageHeader title="Cost calculator" desc="Model what college could cost per year and over four years. Every number here is an estimate — only a financial aid offer tells you what you'll actually pay." />
      <Notice tone="warn" className="mb-5">AdmitIQ does not guarantee aid amounts. Enter grants and scholarships you've been offered, or estimates from each school's <ExtLink href={NPC_CENTER}>official net price calculator</ExtLink>. Bundled cost figures are {DATA_META.label.toLowerCase()} and may be 1–3 years old; tuition usually rises each year.</Notice>

      <Tabs tabs={[{ id: 'compare', label: 'Compare colleges' }, { id: 'scenarios', label: 'Scenarios for one college' }, { id: 'offers', label: 'Compare aid offers', count: s.offers.length || undefined }]} value={view} onChange={setView} className="mb-5" />
      {view === 'offers' ? <OfferComparer /> : (
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="h-fit p-5 lg:sticky lg:top-6">
          <h2 className="text-sm font-semibold text-ink">Assumptions</h2>
          <div className="mt-3 grid gap-3">
            <Field label="Residency" htmlFor="c-res" hint={s.profile.state ? `Auto uses your home state (${s.profile.state}).` : 'Set your home state in your profile.'}><Select id="c-res" value={base.residency} onChange={(e) => setBase({ ...base, residency: e.target.value as CostInputs['residency'] })} options={[{ value: 'auto', label: 'Automatic' }, { value: 'in-state', label: 'In-state' }, { value: 'out-of-state', label: 'Out-of-state' }]} /></Field>
            <Field label="Living" htmlFor="c-liv"><Select id="c-liv" value={base.living} onChange={(e) => setBase({ ...base, living: e.target.value as CostInputs['living'] })} options={[{ value: 'on-campus', label: 'On campus' }, { value: 'at-home', label: 'At home (commute)' }, { value: 'off-campus', label: 'Off campus' }]} /></Field>
            {base.living === 'off-campus' && <Field label="Rent + food per year" htmlFor="c-rent"><NumberInput id="c-rent" value={base.offCampusRent} onChange={(v) => setBase({ ...base, offCampusRent: v ?? 0 })} /></Field>}
            {base.living === 'at-home' && <Field label="Commute per year" htmlFor="c-comm"><NumberInput id="c-comm" value={base.commute} onChange={(v) => setBase({ ...base, commute: v ?? 0 })} /></Field>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Transportation" htmlFor="c-tr"><NumberInput id="c-tr" value={base.transport} onChange={(v) => setBase({ ...base, transport: v ?? 0 })} /></Field>
              <Field label="Books & supplies" htmlFor="c-bk"><NumberInput id="c-bk" value={base.books} onChange={(v) => setBase({ ...base, books: v ?? 0 })} /></Field>
              <Field label="Personal" htmlFor="c-pe"><NumberInput id="c-pe" value={base.personal} onChange={(v) => setBase({ ...base, personal: v ?? 0 })} /></Field>
              <Field label="Annual increase %" htmlFor="c-inc"><NumberInput id="c-inc" value={base.increase} onChange={(v) => setBase({ ...base, increase: Math.max(0, Math.min(15, v ?? 0)) })} /></Field>
            </div>
            <p className="text-xs text-muted">Defaults for transport, books and personal costs are AdmitIQ placeholders — each college publishes its own estimates in its cost of attendance.</p>
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card className="p-5">
            <div className="flex flex-wrap items-center gap-2">
              {ids.map((id, i) => <span key={id} className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-surface pl-3 text-sm"><span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i] }} />{byId(id)?.short}<button aria-label={`Remove ${byId(id)?.short}`} className="grid h-9 w-9 place-items-center text-muted hover:text-rose-600" onClick={() => setIds(ids.filter((x) => x !== id))}><LuX /></button></span>)}
              <div className="flex gap-2">
                <Select aria-label="Add college" value={addId} onChange={(e) => setAddId(e.target.value)} options={[{ value: '', label: 'Add a college…' }, ...COLLEGES.filter((c) => !ids.includes(c.id)).map((c) => ({ value: c.id, label: `${c.short}${c.tuitionIn === null ? ' (no cost data)' : ''}` }))]} className="h-9 w-auto text-sm" />
                <Button size="sm" icon={<LuPlus />} disabled={!addId || ids.length >= 6} onClick={() => { setIds([...ids, addId]); setAddId(''); }}>Add</Button>
              </div>
            </div>
            {ids.length >= 6 && <p className="mt-2 text-xs text-muted">Up to 6 colleges at a time.</p>}
          </Card>

          {!ids.length ? <Card><EmptyState title="Choose colleges to model" body="Add colleges above, or add them to your list first." /></Card> : (
            <>
              <Card className="overflow-hidden">
                <CardHeader title="Your aid & loans (per year)" desc="Enter offered or estimated amounts. Leave at 0 to see sticker price." />
                <div className="scroll mt-3 overflow-x-auto">
                  <table className="w-full min-w-[620px] text-sm">
                    <thead><tr className="border-y border-line text-left text-muted"><th className="px-5 py-2 font-medium">College</th><th className="px-2 py-2 font-medium">Need-based grants</th><th className="px-2 py-2 font-medium">Merit aid</th><th className="px-2 py-2 font-medium">Outside scholarships</th><th className="px-2 py-2 font-medium">Loans</th><th className="px-5 py-2 text-right font-medium">Net / yr</th></tr></thead>
                    <tbody>
                      {results.map((r, i) => (
                        <tr key={r.college.id} className="border-b border-line last:border-0">
                          <td className="px-5 py-2"><span className="flex items-center gap-2 font-medium text-ink"><span className="h-2.5 w-2.5 rounded-full" style={{ background: PALETTE[i] }} />{r.college.short}</span>{r.inState && <Badge tone="teal" className="mt-1">In-state</Badge>}</td>
                          {(['grants', 'merit', 'scholarships', 'loans'] as const).map((k) => <td key={k} className="px-2 py-2"><NumberInput aria-label={`${r.college.short} ${k}`} value={getAid(r.college.id)[k] || null} placeholder="0" onChange={(v) => setAid({ ...aid, [r.college.id]: { ...getAid(r.college.id), [k]: Math.max(0, v ?? 0) } })} className="h-10 w-28" /></td>)}
                          <td className="px-5 py-2 text-right font-semibold tabular-nums text-ink">{usd(r.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>


              {view === 'compare' ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  <ChartCard title="Cost breakdown per year" desc="Before aid." source={SRC} legend={[{ label: 'Tuition & fees', color: 'var(--c1)' }, { label: 'Housing & meals', color: 'var(--c2)' }, { label: 'Transportation', color: 'var(--c3)' }, { label: 'Books', color: 'var(--c4)' }, { label: 'Personal', color: 'var(--c6)' }]}>
                    <StackedBars format={usd} keys={[{ key: 't', label: 'Tuition & fees', color: 'var(--c1)' }, { key: 'h', label: 'Housing & meals', color: 'var(--c2)' }, { key: 'tr', label: 'Transportation', color: 'var(--c3)' }, { key: 'b', label: 'Books', color: 'var(--c4)' }, { key: 'p', label: 'Personal', color: 'var(--c6)' }]}
                      rows={results.map((r) => ({ label: r.college.short, total: r.gross, parts: (r.tuition === null ? {} : { t: r.tuition, h: r.housing, tr: r.transport, b: r.books, p: r.personal }) as Record<string, number> }))} />
                  </ChartCard>
                  <ChartCard title="Net price comparison" desc={budget ? `Your budget: ${usd(budget)}/yr` : 'Sticker price minus the aid you entered.'} source={SRC}>
                    <div className="space-y-4">
                      {results.map((r, i) => (
                        <div key={r.college.id}>
                          <div className="mb-1 flex justify-between text-sm"><span className="text-ink">{r.college.short}</span>{budget && r.net !== null && <Badge tone={r.net <= budget ? 'teal' : 'rose'}>{r.net <= budget ? 'Within budget' : `${usd(r.net - budget)} over`}</Badge>}</div>
                          <HBars data={[{ label: 'Sticker', value: r.gross, color: 'var(--line-strong)' }, { label: 'Your net', value: r.net, color: PALETTE[i] }, { label: 'Avg net (aided)', value: r.avgNetPrice, color: 'var(--c9)' }]} max={Math.max(1, ...results.map((x) => x.gross ?? 0))} format={usdK} />
                        </div>
                      ))}
                    </div>
                  </ChartCard>
                  <ChartCard title="Four-year estimated cost" desc={`Net cost with ${base.increase}% annual increase.`} source={SRC} className="xl:col-span-2" legend={['Year 1', 'Year 2', 'Year 3', 'Year 4'].map((y, i) => ({ label: y, color: `var(--c${i + 1})` }))}>
                    <StackedBars format={usd} keys={[0, 1, 2, 3].map((y) => ({ key: `y${y}`, label: `Year ${y + 1}`, color: `var(--c${y + 1})` }))} rows={results.map((r) => ({ label: r.college.short, total: r.fourYearTotal, parts: r.fourYear ? Object.fromEntries(r.fourYear.map((v, y) => [`y${y}`, v])) : {}, note: r.college.kind === 'Community college' ? 'Two-year program — see note.' : undefined }))} />
                  </ChartCard>
                  <Card className="p-5 xl:col-span-2">
                    <h3 className="text-sm font-semibold text-ink">Notes & official calculators</h3>
                    <ul className="mt-2 space-y-2 text-sm">
                      {results.map((r) => <li key={r.college.id}><b className="text-ink">{r.college.short}:</b> <span className="text-muted">{r.notes.join(' ') || 'No caveats.'}</span> <ExtLink href={npcSearchUrl(r.college)} className="ml-1">Net price calculator</ExtLink>{r.outOfPocket !== null && getAid(r.college.id).loans > 0 && <span className="text-muted"> · Out of pocket after loans: <b className="text-ink">{usd(r.outOfPocket)}</b>/yr (loans total ~{usd(getAid(r.college.id).loans * 4)} over 4 years, before interest).</span>}</li>)}
                    </ul>
                  </Card>
                </div>
              ) : fc && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-muted">College:</span><Select aria-label="Scenario college" value={f} onChange={(e) => setFocus(e.target.value)} options={ids.map((id) => ({ value: id, label: byId(id)!.short }))} className="w-auto" /></div>
                  <ChartCard title={`${fc.short}: living & residency scenarios`} desc="Per-year net cost using your aid inputs." source={SRC}>
                    <HBars data={scenarios.map((x, i) => ({ label: x.label, value: x.r.net, color: PALETTE[i] }))} format={usd} />
                  </ChartCard>
                  <ChartCard title={`${fc.short}: financial aid scenarios`} desc="What different aid levels would mean per year. The 'average aid' scenario uses published average net price — your aid could differ a lot." source={SRC}>
                    {(() => {
                      const r = computeCost(fc, { ...base, grants: 0, merit: 0, scholarships: 0 });
                      const rows = [
                        { label: 'No aid (sticker)', value: r.gross },
                        { label: 'Average aided student', value: fc.netPrice },
                        { label: 'Your entered aid', value: computeCost(fc, { ...base, ...getAid(fc.id) }).net },
                        { label: 'Your aid + $5k scholarship', value: r.gross === null ? null : Math.max(0, (computeCost(fc, { ...base, ...getAid(fc.id) }).net ?? 0) - 5000) },
                      ];
                      return <HBars data={rows.map((x, i) => ({ ...x, color: PALETTE[i] }))} format={usd} />;
                    })()}
                  </ChartCard>
                  <Card className="overflow-hidden">
                    <div className="scroll overflow-x-auto">
                      <table className="w-full min-w-[560px] text-sm">
                        <thead><tr className="border-b border-line text-left text-muted"><th className="px-5 py-2 font-medium">Scenario</th><th className="px-3 py-2 text-right font-medium">Sticker / yr</th><th className="px-3 py-2 text-right font-medium">Net / yr</th><th className="px-5 py-2 text-right font-medium">4-year net</th></tr></thead>
                        <tbody>{scenarios.map((x) => <tr key={x.label} className="border-b border-line last:border-0"><td className="px-5 py-2.5 text-ink">{x.label}</td><td className="px-3 py-2.5 text-right tabular-nums">{usd(x.r.gross)}</td><td className="px-3 py-2.5 text-right font-semibold tabular-nums text-ink">{usd(x.r.net)}</td><td className={cx('px-5 py-2.5 text-right tabular-nums', budget && x.r.net !== null && x.r.net > budget ? 'text-rose-600' : 'text-ink')}>{usd(x.r.fourYearTotal)}</td></tr>)}</tbody>
                      </table>
                    </div>
                  </Card>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      )}
    </>
  );
}
