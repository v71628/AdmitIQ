import React, { useMemo, useState } from 'react';
import { LuArrowRight, LuRotateCcw, LuFlaskConical } from 'react-icons/lu';
import { Badge, Button, Card, CardHeader, Toggle, bucketTone, cx } from './ui';
import { COLLEGES } from '../data/colleges';
import type { AppState, Course } from '../lib/types';
import { assess, studentAcademics } from '../lib/analysis';

const ORDER = { Reach: 0, Target: 1, Likely: 2 } as Record<string, number>;

function Slider({ label, value, min, max, step, onChange, fmt, base }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt: (v: number) => string; base: number }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2 text-sm"><span className="font-medium text-ink">{label}</span><span className="tabular-nums text-ink">{fmt(value)}{value !== base && <span className={cx('ml-1.5 text-xs', value > base ? 'text-teal' : 'text-rose-600')}>({value > base ? '+' : ''}{fmt(value - base).replace(/^\+?/, '')})</span>}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label}
        className="range mt-2 w-full" style={{ ['--p' as string]: `${pct}%` }} />
    </label>
  );
}

export function WhatIf({ s }: { s: AppState }) {
  const ac = studentAcademics(s);
  const baseSat = s.profile.sat.total ?? 1200, baseGpa = Math.round((ac.gpa4 ?? 3.5) * 100) / 100, baseAdv = ac.rigor.advanced;
  const [sat, setSat] = useState(baseSat);
  const [gpa, setGpa] = useState(baseGpa);
  const [adv, setAdv] = useState(baseAdv);
  const [submit, setSubmit] = useState(s.profile.testingStatus !== 'Not submitting scores');
  const ids = s.list.length ? s.list.map((l) => l.collegeId) : COLLEGES.filter((c) => c.kind !== 'International').slice(0, 10).map((c) => c.id);

  const rows = useMemo(() => {
    const sim: AppState = structuredClone(s);
    sim.profile.sat.total = sat; sim.profile.gpaUnweighted = gpa; sim.profile.gpaScale = '4.0';
    sim.profile.testingStatus = submit ? 'Tested' : 'Not submitting scores';
    // Replace the transcript with one that has the chosen number of advanced courses (only rigor counts are read).
    sim.courses = Array.from({ length: Math.max(6, adv) }, (_, k): Course => ({ id: `w${k}`, name: 'sim', year: 11, term: 'Full year', level: k < adv ? 'AP' : 'Regular', subject: 'Science', grade: 'P', credits: 1 }));
    // Pass/fail grades keep the simulated transcript from overriding the GPA slider.
    const simA = (c: (typeof COLLEGES)[number]) => assess(c, sim);
    return ids.map((id) => { const c = COLLEGES.find((x) => x.id === id)!; const now = assess(c, s), then = simA(c); return { c, now, then, delta: ORDER[then.bucket] - ORDER[now.bucket] }; });
  }, [s, sat, gpa, adv, submit]);
  const changed = rows.filter((r) => r.delta !== 0 || r.now.competitiveness !== r.then.competitiveness).length;
  const reset = () => { setSat(baseSat); setGpa(baseGpa); setAdv(baseAdv); setSubmit(s.profile.testingStatus !== 'Not submitting scores'); };

  return (
    <Card className="mb-5 overflow-hidden">
      <CardHeader title={<span className="flex items-center gap-2"><LuFlaskConical className="text-accent" />What-if simulator</span>} desc="See how improving a score, grades or course load would shift each estimate. Nothing here changes your saved profile." action={<Button size="sm" variant="ghost" icon={<LuRotateCcw />} onClick={reset}>Reset</Button>} />
      <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Slider label="SAT total" value={sat} min={900} max={1600} step={10} onChange={setSat} fmt={(v) => String(v)} base={baseSat} />
          <Slider label="Unweighted GPA" value={gpa} min={2.5} max={4} step={0.01} onChange={setGpa} fmt={(v) => v.toFixed(2)} base={baseGpa} />
          <Slider label="AP / IB / dual-enrollment courses" value={adv} min={0} max={16} step={1} onChange={setAdv} fmt={(v) => String(v)} base={baseAdv} />
          <Toggle label="Submit test scores" checked={submit} onChange={setSubmit} />
          <p className="text-xs text-muted">Same transparent rules as the analysis below — still estimates, not probabilities. Test-free schools ignore the SAT slider.</p>
        </div>
        <div className="min-w-0">
          <p className="mb-2 text-sm text-muted" aria-live="polite">{changed ? `${changed} of ${rows.length} estimates change` : 'No estimates change yet — try moving a slider.'}</p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {rows.map(({ c, now, then, delta }) => (
              <li key={c.id} className={cx('flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm transition-colors', delta > 0 && 'bg-teal-500/[0.06]', delta < 0 && 'bg-rose-500/[0.05]')}>
                <a href={`#college-${c.id}`} className="min-w-0 flex-1 truncate font-medium text-ink hover:text-accent">{c.short}</a>
                <Badge tone={bucketTone(now.bucket)}>{now.bucket}</Badge>
                <LuArrowRight className={cx('text-muted', delta !== 0 && 'text-ink')} />
                <Badge tone={bucketTone(then.bucket)}>{then.bucket}</Badge>
                {then.competitiveness !== now.competitiveness && <span className="w-full text-xs text-muted sm:w-auto">{now.competitiveness} → <b className="text-ink">{then.competitiveness}</b></span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
