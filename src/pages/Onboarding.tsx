import React, { useState } from 'react';
import { LuArrowLeft, LuArrowRight, LuCheck } from 'react-icons/lu';
import { Logo, navigate } from '../App';
import { Button, Card, Progress, cx } from '../components/ui';
import { AcademicsForm, ActivitiesEditor, BasicsForm, FinancialForm, PersonalForm } from '../components/forms';
import { ResearchLoader, runSteps, type StepState } from '../components/loader';
import { store } from '../lib/store';
import { COLLEGES } from '../data/colleges';
import { assess, recommendList } from '../lib/analysis';
import { portfolio } from '../lib/activities';
import { computeCost, DEFAULT_COST } from '../lib/cost';

const STEPS = [
  { id: 'basics', title: 'The basics', desc: 'Where you are and what you might study.', C: BasicsForm },
  { id: 'academics', title: 'Grades & testing', desc: 'Enter what your school reports. You can add a full transcript later.', C: AcademicsForm },
  { id: 'activities', title: 'Activities', desc: 'Add a few now — you can refine descriptions later.', C: ActivitiesEditor },
  { id: 'personal', title: 'What you want in a college', desc: 'Setting, size, region and priorities.', C: PersonalForm },
  { id: 'financial', title: 'Budget', desc: 'Optional and private. Used only for cost estimates.', C: FinancialForm },
];

export default function Onboarding() {
  const [i, setI] = useState(0);
  const [building, setBuilding] = useState<StepState[] | null>(null);
  const step = STEPS[i];
  async function finish() {
    const s = store.get();
    let recs: ReturnType<typeof recommendList> | null = null;
    await runSteps([
      { label: 'Analyzing academic profile', run: () => { assess(COLLEGES[0], s); } },
      { label: 'Reviewing institutional admissions data', run: () => { COLLEGES.forEach((c) => assess(c, s)); } },
      { label: 'Comparing financial outcomes', run: () => { COLLEGES.forEach((c) => computeCost(c, { ...DEFAULT_COST, homeState: s.profile.state })); } },
      { label: 'Cross-checking college requirements', run: () => { portfolio(s.activities); } },
      { label: 'Building your personalized college strategy', run: () => { recs = recommendList(COLLEGES, s, 3); } },
    ], setBuilding);
    store.set((st) => {
      st.meta.onboarded = true;
      if (recs && !st.list.length) {
        for (const b of ['Reach', 'Target', 'Likely'] as const) for (const f of recs[b]) st.list.push({ collegeId: f.college.id, category: b, favorite: false, notes: 'Suggested during onboarding', addedAt: new Date().toISOString() });
      }
    });
    navigate('dashboard');
  }
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="glass sticky top-0 z-30 border-b border-line">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4"><a href="#home"><Logo /></a><button className="h-10 rounded-lg px-3 text-sm text-muted hover:text-ink" onClick={() => { store.set((s) => { s.meta.onboarded = true; }); navigate('dashboard'); }}>Skip setup</button></div>
        <Progress value={((i + 1) / STEPS.length) * 100} className="h-1 rounded-none" label="Setup progress" />
      </header>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:py-12">
        {building ? <Card className="mx-auto max-w-lg p-8"><ResearchLoader steps={building} title="Setting up your dashboard" /></Card> : (
          <>
            <ol className="no-scrollbar mb-8 flex gap-2 overflow-x-auto">
              {STEPS.map((s, j) => (
                <li key={s.id}><button onClick={() => setI(j)} className={cx('flex h-9 items-center gap-2 rounded-full border px-3 text-sm whitespace-nowrap', j === i ? 'border-ink bg-ink text-canvas' : j < i ? 'border-line bg-surface text-ink' : 'border-line text-muted')}>
                  <span className={cx('grid h-5 w-5 place-items-center rounded-full text-[11px]', j < i ? 'bg-teal text-white' : j === i ? 'bg-canvas/20' : 'bg-raised')}>{j < i ? <LuCheck /> : j + 1}</span>{s.title}
                </button></li>
              ))}
            </ol>
            <div key={step.id} className="fade-up">
              <h1 className="text-[28px] font-semibold tracking-tight text-ink sm:text-[34px]">{step.title}</h1>
              <p className="mt-1.5 text-muted">{step.desc} Everything saves as you type.</p>
              <Card className="mt-6 p-5 sm:p-7"><step.C /></Card>
            </div>
            <div className="mt-6 flex items-center justify-between">
              <Button variant="ghost" disabled={i === 0} onClick={() => setI(i - 1)} icon={<LuArrowLeft />}>Back</Button>
              {i < STEPS.length - 1 ? <Button variant="primary" onClick={() => { setI(i + 1); window.scrollTo({ top: 0 }); }}>Continue <LuArrowRight /></Button> : <Button variant="primary" onClick={finish}>Build my strategy <LuArrowRight /></Button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
