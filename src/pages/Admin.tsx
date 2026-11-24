import React, { useEffect, useState } from 'react';
import { LuShieldCheck, LuRefreshCw, LuServer, LuDatabase, LuActivity } from 'react-icons/lu';
import { useCaps } from '../App';
import { Badge, Button, Card, CardHeader, EmptyState, Notice, PageHeader, Skeleton, Stat } from '../components/ui';
import { admin, auth } from '../lib/services';

// Shapes returned by GET /api/admin/status (server/server.mjs). Everything is read-only here;
// configuration is done with environment variables so secrets never pass through the browser.
interface Group { key: string; requests: number; failures: number; input: number; output: number; cost: number; unpriced: number }
interface UsageSummary { since: string; requests: number; byProvider: Group[]; byModel: Group[]; byTask: Group[]; recentErrors: { at: number; provider: string; model?: string; status?: number; task: string }[] }
interface Status {
  ai: { providers: Record<string, { configured: boolean; models: Record<string, string>; healthy: boolean; lastError: string | null }>; routes: Record<string, string[]>; pricingConfigured: number; monthlyBudget: number | null; monthCost: number; planUnits: Record<string, number> };
  usage24h: UsageSummary; usage30d: UsageSummary;
  database: null | { error?: string; users?: number; active_users_30d?: number; subscriptions?: Record<string, number>; colleges?: number; colleges_active?: number; majors?: number; careers?: number; sources_total?: number; sources_verified?: number; sources_stale?: number; failed_ingestion_7d?: number; ai_requests_30d?: number; ai_cost_30d?: number };
  billing: boolean; uptimeSec: number; memoryMb: number;
}

const n = (v: number | undefined | null) => (v === undefined || v === null ? '—' : v.toLocaleString());
const usd = (v: number | undefined | null) => (v === undefined || v === null ? '—' : v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`);

function GroupTable({ rows, label }: { rows: Group[]; label: string }) {
  if (!rows.length) return <p className="px-4 pb-4 text-sm text-muted">No requests in this period.</p>;
  return (
    <div className="overflow-x-auto px-4 pb-4">
      <table className="w-full text-sm">
        <thead className="text-left text-muted"><tr><th className="py-1.5 font-medium">{label}</th><th className="py-1.5 text-right font-medium">Requests</th><th className="py-1.5 text-right font-medium">Failed</th><th className="py-1.5 text-right font-medium">Tokens in / out</th><th className="py-1.5 text-right font-medium">Cost</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.key} className="border-t border-line"><td className="py-1.5">{r.key}</td><td className="py-1.5 text-right tabular-nums">{n(r.requests)}</td><td className="py-1.5 text-right tabular-nums">{r.failures ? <span className="text-rose-600">{r.failures}</span> : 0}</td><td className="py-1.5 text-right tabular-nums">{n(r.input)} / {n(r.output)}</td><td className="py-1.5 text-right tabular-nums">{usd(r.cost)}{r.unpriced ? <span className="text-muted" title="Requests for models with no price in AI_PRICING_JSON"> +{r.unpriced} unpriced</span> : null}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export default function Admin() {
  const { caps } = useCaps();
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const signedIn = !!auth.current();

  async function load() {
    setLoading(true); setError(null);
    try { setS((await admin.status()) as unknown as Status); } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }
  useEffect(() => { if (signedIn && caps) load(); }, [signedIn, caps]);

  if (!signedIn) return <div className="space-y-6"><PageHeader title="Admin" /><EmptyState icon={<LuShieldCheck />} title="Admins only" body="Sign in with an account listed in ADMIN_EMAILS on the server." action={<Button variant="primary" onClick={() => (location.hash = 'login')}>Sign in</Button>} /></div>;

  const db = s?.database;
  return (
    <div className="space-y-6">
      <PageHeader title="Admin" desc="Live system health, AI usage and costs, and real database counts. Read-only: settings are environment variables on the server." actions={<Button icon={<LuRefreshCw />} onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</Button>} />
      {error && <Notice tone="warn">{error}</Notice>}
      {!s && !error && <div className="grid gap-3 md:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div>}
      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat icon={<LuDatabase />} label="Verified sources" value={db && !db.error ? n(db.sources_verified) : '—'} sub={db && !db.error ? `of ${n(db.sources_total)} records · ${n(db.sources_stale)} stale` : 'Database not connected'} />
            <Stat label="Colleges" value={db && !db.error ? n(db.colleges) : '—'} sub={db && !db.error ? `${n(db.colleges_active)} active` : undefined} />
            <Stat label="Majors / careers" value={db && !db.error ? `${n(db.majors)} / ${n(db.careers)}` : '—'} />
            <Stat icon={<LuActivity />} label="AI requests (24h)" value={n(s.usage24h.requests)} sub={`30 days: ${n(s.usage30d.requests)}`} />
            <Stat label="Users" value={db && !db.error ? n(db.users) : '—'} sub={db && !db.error ? `${n(db.active_users_30d)} active in 30 days` : undefined} />
            <Stat label="Subscriptions" value={db?.subscriptions ? Object.values(db.subscriptions).reduce((a, b) => a + b, 0) : '—'} sub={db?.subscriptions ? Object.entries(db.subscriptions).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none' : s.billing ? 'Stripe connected' : 'Stripe not configured'} />
            <Stat label="AI cost this month" value={usd(s.ai.monthCost)} sub={s.ai.monthlyBudget ? `Budget ${usd(s.ai.monthlyBudget)}` : 'No budget cap set'} />
            <Stat icon={<LuServer />} label="Server" value={`${Math.round(s.uptimeSec / 3600)}h up`} sub={`${s.memoryMb} MB memory`} />
          </div>
          {db?.error && <Notice tone="warn">Database: {db.error}</Notice>}
          {db && !db.error && (db.failed_ingestion_7d ?? 0) > 0 && <Notice tone="warn">{db.failed_ingestion_7d} ingestion errors in the last 7 days — see the ingestion_errors table.</Notice>}

          <Card>
            <CardHeader title="AI providers" desc={`${s.ai.pricingConfigured} model price(s) configured for cost tracking.`} />
            <div className="grid gap-3 p-4 pt-0 md:grid-cols-2">
              {Object.entries(s.ai.providers).length === 0 && <p className="text-sm text-muted">No AI provider configured.</p>}
              {Object.entries(s.ai.providers).map(([name, p]) => (
                <div key={name} className="rounded-xl border border-line p-3">
                  <div className="flex items-center justify-between"><span className="font-medium text-ink">{name}</span><Badge tone={p.healthy ? 'green' : 'rose'}>{p.healthy ? 'Healthy' : 'Cooling down'}</Badge></div>
                  <div className="mt-1 text-xs text-muted">{Object.keys(p.models).length ? Object.entries(p.models).map(([t, m]) => `${t}: ${m}`).join(' · ') : 'Models auto-selected from the provider'}</div>
                  {p.lastError && <div className="mt-1 text-xs text-rose-600">{p.lastError}</div>}
                </div>
              ))}
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader title="Usage by provider (24h)" /><GroupTable rows={s.usage24h.byProvider} label="Provider" /></Card>
            <Card><CardHeader title="Usage by task (24h)" /><GroupTable rows={s.usage24h.byTask} label="Task" /></Card>
          </div>
          <Card><CardHeader title="Usage by model (30 days)" /><GroupTable rows={s.usage30d.byModel} label="Model" /></Card>
          <Card>
            <CardHeader title="Routing" desc="First healthy provider in each route answers; the rest are fallbacks." />
            <div className="grid gap-2 p-4 pt-0 sm:grid-cols-2">{Object.entries(s.ai.routes).map(([t, r]) => <div key={t} className="rounded-xl border border-line px-3 py-2 text-sm"><span className="font-medium text-ink">{t}</span> <span className="text-muted">→ {r.join(' → ')}</span></div>)}</div>
          </Card>
          {s.usage24h.recentErrors.length > 0 && (
            <Card><CardHeader title="Recent AI errors" /><ul className="divide-y divide-line px-4 pb-4 text-sm">{s.usage24h.recentErrors.slice().reverse().map((e, i) => <li key={i} className="flex justify-between py-1.5"><span>{e.provider}{e.model ? ` · ${e.model}` : ''} · {e.task}</span><span className="text-muted">{e.status ?? 'error'} · {new Date(e.at).toLocaleTimeString()}</span></li>)}</ul></Card>
          )}
        </>
      )}
    </div>
  );
}
