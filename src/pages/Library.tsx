import React, { useEffect, useState } from 'react';
import { LuLibrary, LuSearch, LuExternalLink, LuSparkles } from 'react-icons/lu';
import { useCaps } from '../App';
import { Badge, Button, Card, CardHeader, Counter, EmptyState, Input, Notice, PageHeader, Select, Skeleton, Stat, cx } from '../components/ui';
import { library, type LibrarySource } from '../lib/services';
import { Markdown } from '../lib/markdown';

export const SOURCE_CATEGORIES: Record<string, string> = {
  institution_home: 'Official institution websites', college_admissions: 'College admissions', admissions_statistics: 'Admissions statistics', common_data_set: 'Common Data Sets',
  academic_programs: 'Academic programs', majors: 'Majors', course_catalogs: 'Course catalogs', tuition_fees: 'Tuition and fees', financial_aid: 'Financial aid', scholarships: 'Scholarships',
  graduation: 'Graduation', retention: 'Retention', employment_outcomes: 'Employment outcomes', career_salaries: 'Career salaries', employment_projections: 'Employment projections',
  demographics: 'Student demographics', housing: 'Campus housing', rankings: 'Rankings & methodology', testing: 'Standardized testing', affordability: 'Affordability',
  career_development: 'Career development', higher_ed_research: 'Higher education research', accessibility: 'Accessibility services', veterans: 'Military & veteran students', athletics: 'Athletics',
  test_optional: 'Test-optional policies', early_decision: 'Early Decision / Early Action', transfer_admissions: 'Transfer admissions', international_admissions: 'International admissions',
};
const TIER: Record<number, { label: string; tone: string; desc: string }> = {
  1: { label: 'Tier 1 · Official', tone: 'green', desc: 'Government or institutional primary source' },
  2: { label: 'Tier 2 · Research', tone: 'blue', desc: 'Peer-reviewed or established research organization' },
  3: { label: 'Tier 3 · Publication', tone: 'amber', desc: 'Reputable educational publication' },
  4: { label: 'Tier 4 · Secondary', tone: 'neutral', desc: 'Secondary reporting' },
};
const SAMPLES = ['net price calculator for public universities in Ohio', 'test-optional admissions policy', 'nursing employment projections', 'financial aid office University of Michigan'];

function freshness(s: LibrarySource) {
  if (!s.last_verified_at) return { label: 'Not yet link-checked', tone: 'neutral' };
  const days = (Date.now() - new Date(s.last_verified_at).getTime()) / 864e5;
  return days < 180 ? { label: `Verified ${new Date(s.last_verified_at).toLocaleDateString()}`, tone: 'green' } : { label: `Last verified ${Math.round(days / 30)} months ago`, tone: 'amber' };
}

type Stats = Awaited<ReturnType<typeof library.stats>>;

export default function Library() {
  const { caps, checked } = useCaps();
  const [stats, setStats] = useState<Stats | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [results, setResults] = useState<LibrarySource[] | null>(null);
  const [mode, setMode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Awaited<ReturnType<typeof library.answer>> | null>(null);
  const [answering, setAnswering] = useState(false);

  useEffect(() => { if (caps?.research?.library) library.stats().then(setStats).catch(() => setStats({ configured: false })); }, [caps]);

  async function search(e?: React.FormEvent, query = q, cat = category) {
    e?.preventDefault(); const text = query.trim(); if (!text) return;
    setQ(text); setLoading(true); setError(null); setAnswer(null);
    try { const r = await library.search(text, { category: cat || undefined, limit: 20 }); setResults(r.results); setMode(r.mode); }
    catch (err) { setError((err as Error).message); setResults(null); }
    finally { setLoading(false); }
  }
  async function ask() {
    setAnswering(true); setError(null);
    try { setAnswer(await library.answer(q.trim(), { category: category || undefined })); }
    catch (err) { setError((err as Error).message); }
    finally { setAnswering(false); }
  }

  const header = <PageHeader title="Source library" desc="Every fact AdmitIQ cites comes from a record here: official college pages, federal datasets and labor statistics — each with its reliability tier, data year and last verification date." />;

  if (checked && !caps?.research?.library) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState icon={<LuLibrary />} title="The source library isn't connected on this server" body="It lives in the Supabase database. Once the server has SUPABASE_SERVICE_ROLE_KEY and the ingestion pipeline has run (npm run ingest), this page lists about 37,000 official sources — college admissions, financial aid and net price calculator pages for 6,000+ institutions, federal College Navigator and College Scorecard profiles, and 343 Bureau of Labor Statistics occupation profiles." action={<Button onClick={() => (location.hash = 'research')}>Use the research center</Button>} />
        <Notice>Counts above were measured from the live federal datasets on 24 Nov 2026; they are what the pipeline loads, not a claim about this server's database.</Notice>
      </div>
    );
  }

  const total = stats && stats.configured ? stats.total ?? 0 : null;
  return (
    <div className="space-y-6">
      {header}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Source records" value={total === null ? <Skeleton className="h-7 w-20" /> : <Counter value={total} />} sub="Excludes rejected records" />
        <Stat label="Link-verified" value={stats?.configured ? <Counter value={stats.verified ?? 0} /> : <Skeleton className="h-7 w-16" />} sub="Checked page loads or extracted text" />
        <Stat label="Listed, not yet checked" value={stats?.configured ? <Counter value={stats.listed ?? 0} /> : <Skeleton className="h-7 w-16" />} sub="From official federal data" />
        <Stat label="Stale or broken" value={stats?.configured ? <Counter value={(stats.stale ?? 0) + (stats.broken ?? 0)} /> : <Skeleton className="h-7 w-16" />} sub="Shown with a warning" />
      </div>

      <Card className="p-4">
        <form onSubmit={search} className="flex flex-col gap-2 sm:flex-row">
          <label className="relative flex-1"><LuSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search official sources, e.g. “net price calculator Ohio State”" className="pl-9" aria-label="Search the source library" /></label>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} options={[{ value: '', label: 'All categories' }, ...Object.entries(SOURCE_CATEGORIES).map(([value, label]) => ({ value, label }))]} aria-label="Category" className="sm:w-56" />
          <Button type="submit" variant="primary" disabled={!q.trim() || loading}>Search</Button>
        </form>
        {!results && !loading && <div className="mt-3 flex flex-wrap gap-2">{SAMPLES.map((s) => <button key={s} onClick={() => search(undefined, s)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-ink">{s}</button>)}</div>}
      </Card>

      {error && <Notice tone="warn">{error}</Notice>}
      {loading && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>}

      {results && !loading && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
            <span>{results.length} result{results.length === 1 ? '' : 's'} · {mode}</span>
            {caps?.ai && results.length > 0 && <Button size="sm" icon={<LuSparkles />} onClick={ask} disabled={answering}>{answering ? 'Reading sources…' : 'Answer from these sources'}</Button>}
          </div>
          {answer && (
            <Card className="p-4">
              <div className="mb-2 flex items-center gap-2"><Badge tone="violet">AI summary of library sources</Badge><span className="text-xs text-muted">{answer.mode}</span></div>
              {answer.text ? <Markdown text={answer.text} /> : <p className="text-sm text-muted">{answer.note}</p>}
              {answer.citations.some((c) => c.used) && <ol className="mt-3 space-y-1 text-sm">{answer.citations.filter((c) => c.used).map((c) => <li key={c.sourceId}><span className="text-muted">[{c.n}]</span> <a className="underline underline-offset-2" href={c.url} target="_blank" rel="noopener noreferrer">{c.title}</a> <span className="text-muted">· tier {c.tier}{c.dataYear ? ` · ${c.dataYear}` : ''}</span></li>)}</ol>}
            </Card>
          )}
          {results.length === 0 ? <EmptyState icon={<LuSearch />} title="No matching sources" body="Try fewer words, a college's full name, or a different category." /> : (
            <ul className="grid gap-3 md:grid-cols-2">
              {results.map((s) => {
                const t = TIER[s.reliability_tier] || TIER[4]; const f = freshness(s);
                let host = ''; try { host = new URL(s.url).host.replace(/^www\./, ''); } catch { /* invalid url */ }
                return (
                  <li key={s.id}>
                    <Card hover className="h-full p-4">
                      <div className="flex flex-wrap gap-1.5"><Badge tone={t.tone} title={t.desc}>{t.label}</Badge><Badge>{SOURCE_CATEGORIES[s.category] || s.category}</Badge>{s.data_year && <Badge>Data {s.data_year}</Badge>}</div>
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="mt-2 flex items-start gap-1.5 font-medium text-ink hover:underline">{s.title}<LuExternalLink className="mt-1 shrink-0 text-xs text-muted" /></a>
                      <div className="mt-0.5 text-xs text-muted">{s.organization || host} · {host}</div>
                      {(s.summary || s.excerpt) && <p className="mt-2 line-clamp-3 text-sm text-muted">{s.summary || s.excerpt}</p>}
                      <div className={cx('mt-3 text-xs', f.tone === 'amber' ? 'text-amber-700 dark:text-amber-300' : 'text-muted')}>{f.label}</div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {stats?.configured && stats.by_category && (
        <Card>
          <CardHeader title="What's in the library" desc="Record counts by category, straight from the database." />
          <div className="grid gap-2 p-4 pt-0 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(stats.by_category).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
              <button key={k} onClick={() => { setCategory(k); if (q.trim()) search(undefined, q, k); }} className="flex items-center justify-between rounded-xl border border-line px-3 py-2 text-left text-sm hover:border-ink/20">
                <span className="truncate">{SOURCE_CATEGORIES[k] || k}</span><span className="tabular-nums text-muted">{n.toLocaleString()}</span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
