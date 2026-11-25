import React, { useEffect, useState } from 'react';
import { LuCheck, LuCreditCard, LuReceipt } from 'react-icons/lu';
import { useCaps } from '../App';
import { Badge, Button, Card, CardHeader, Notice, PageHeader, Progress, Tabs, cx } from '../components/ui';
import { ai, auth, billing, type PlanPrice, type Usage } from '../lib/services';
import { PLAN_INFO, TASK_UNIT_COSTS, formatPrice, type PlanId } from '../lib/plans';

type Prices = Awaited<ReturnType<typeof billing.prices>>;
type Invoice = Awaited<ReturnType<typeof billing.invoices>>['invoices'][number];

export default function Pricing() {
  const { caps } = useCaps();
  const [period, setPeriod] = useState<'monthly' | 'annual'>('monthly');
  const [prices, setPrices] = useState<Prices | null>(null);
  const [usage, setUsage] = useState<(Usage & { signedIn: boolean }) | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedIn = !!auth.current();
  const status = new URLSearchParams(location.hash.split('?')[1] || '').get('status');

  useEffect(() => {
    if (!caps) return;
    billing.prices().then(setPrices).catch(() => setPrices({ configured: false, plans: {} }));
    if (caps.ai) ai.usage().then(setUsage).catch(() => setUsage(null));
    if (caps.billing && signedIn) billing.invoices().then((r) => setInvoices(r.invoices)).catch(() => setInvoices(null));
  }, [caps, signedIn]);

  async function go(fn: () => Promise<{ url: string }>, label: string) {
    setBusy(label); setError(null);
    try { const { url } = await fn(); location.href = url; }
    catch (e) { setError((e as Error).message); setBusy(null); }
  }

  const current: PlanId = (usage?.plan === 'anonymous' ? 'free' : (usage?.plan as PlanId)) || 'free';
  const priceFor = (id: PlanId): PlanPrice | undefined => (id === 'free' ? undefined : prices?.plans[id]?.[period]);
  const annualSaving = (() => {
    const m = prices?.plans.pro?.monthly?.amount, a = prices?.plans.pro?.annual?.amount;
    return m && a ? Math.round((1 - a / (m * 12)) * 100) : null;
  })();

  return (
    <div className="space-y-6">
      <PageHeader title="Plans" desc="Start free. Upgrade when you want deeper AI analysis, more usage and the full application toolkit. Cancel any time." />
      {status === 'success' && <Notice tone="ok">Thanks — your subscription is active. It can take a few seconds to show here.</Notice>}
      {status === 'cancelled' && <Notice>Checkout was cancelled. Nothing was charged.</Notice>}
      {caps && !caps.billing && <Notice>Payments aren't configured on this server yet, so plans can't be purchased here. Everything in Free works today.</Notice>}
      {error && <Notice tone="warn">{error}</Notice>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs tabs={[{ id: 'monthly', label: 'Monthly' }, { id: 'annual', label: annualSaving && annualSaving > 0 ? `Annual · save ${annualSaving}%` : 'Annual' }]} value={period} onChange={setPeriod} />
        {usage && <span className="text-sm text-muted">Current plan: <Badge tone="green">{PLAN_INFO.find((p) => p.id === current)?.name || current}</Badge></span>}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {PLAN_INFO.map((p) => {
          const price = priceFor(p.id); const label = price ? formatPrice(price.amount, price.currency) : null;
          const isCurrent = p.id === current; const featured = p.id === 'pro';
          return (
            <Card key={p.id} className={cx('relative flex flex-col p-5', featured && 'ring-2 ring-accent')}>
              {featured && <Badge tone="orange" className="absolute right-4 top-4">Most popular</Badge>}
              <div className="text-lg font-semibold text-ink">{p.name}</div>
              <div className="text-sm text-muted">{p.tagline}</div>
              <div className="mt-4 h-12">
                {p.id === 'free' ? <span className="text-3xl font-semibold text-ink">$0</span>
                  : label ? <><span className="text-3xl font-semibold tabular-nums text-ink">{label}</span><span className="text-sm text-muted"> / {price?.interval === 'year' ? 'year' : 'month'}</span></>
                  : <span className="text-sm text-muted">{prices?.configured ? 'Not offered for this period' : 'Price shown once payments are set up'}</span>}
              </div>
              <div className="text-xs text-muted">{p.units.toLocaleString()} AI units per day</div>
              <ul className="mt-4 flex-1 space-y-2 text-sm">{p.features.map((f) => <li key={f} className="flex gap-2"><LuCheck className="mt-0.5 shrink-0 text-[var(--teal)]" />{f}</li>)}</ul>
              <div className="mt-5">
                {isCurrent ? <Button className="w-full" disabled>Current plan</Button>
                  : p.id === 'free' ? <Button className="w-full" disabled={!signedIn || !caps?.billing} onClick={() => go(billing.portal, 'portal')}>{signedIn ? 'Switch to Free' : 'Included'}</Button>
                  : !signedIn ? <Button className="w-full" variant={featured ? 'primary' : 'secondary'} onClick={() => (location.hash = 'login')}>Sign in to upgrade</Button>
                  : <Button className="w-full" variant={featured ? 'primary' : 'secondary'} disabled={!caps?.billing || !price || !!busy} onClick={() => go(() => billing.checkout(p.id as 'plus' | 'pro' | 'ultimate', period), p.id)}>{busy === p.id ? 'Opening checkout…' : `Choose ${p.name}`}</Button>}
              </div>
            </Card>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Today's AI usage" desc="Units reset at midnight UTC. Bigger tasks use more units." />
          <div className="space-y-3 p-4 pt-0">
            {usage ? <><Progress value={Math.min(100, (usage.used / Math.max(1, usage.limit)) * 100)} label={`${usage.used} of ${usage.limit} units used`} /><div className="text-sm text-muted">{Math.max(0, usage.limit - usage.used)} units left today{!usage.signedIn && ' · sign in for the Free plan allowance'}</div></>
              : <div className="text-sm text-muted">{caps?.ai ? 'Loading…' : 'AI is not connected on this server.'}</div>}
            <table className="w-full text-sm"><tbody>{TASK_UNIT_COSTS.map((t) => <tr key={t.task} className="border-t border-line"><td className="py-1.5">{t.task}</td><td className="py-1.5 text-right tabular-nums text-muted">{t.units} unit{t.units > 1 ? 's' : ''}</td></tr>)}</tbody></table>
          </div>
        </Card>
        <Card>
          <CardHeader title="Billing" desc="Payment details are handled by Stripe. AdmitIQ never sees your card number." action={signedIn && caps?.billing ? <Button size="sm" icon={<LuCreditCard />} disabled={!!busy} onClick={() => go(billing.portal, 'portal')}>{busy === 'portal' ? 'Opening…' : 'Manage billing'}</Button> : undefined} />
          <div className="p-4 pt-0 text-sm">
            {!signedIn ? <span className="text-muted">Sign in to see your billing history.</span>
              : !caps?.billing ? <span className="text-muted">Billing isn't configured on this server.</span>
              : invoices === null ? <span className="text-muted">Loading…</span>
              : invoices.length === 0 ? <span className="text-muted">No invoices yet.</span>
              : <ul className="divide-y divide-line">{invoices.map((i) => <li key={i.id} className="flex items-center justify-between py-2"><span className="flex items-center gap-2"><LuReceipt className="text-muted" />{new Date(i.created).toLocaleDateString()} · {formatPrice(i.amount, i.currency)}</span><span className="flex items-center gap-2"><Badge tone={i.status === 'paid' ? 'green' : 'amber'}>{i.status}</Badge>{i.url && <a className="underline" href={i.url} target="_blank" rel="noopener noreferrer">View</a>}</span></li>)}</ul>}
          </div>
        </Card>
      </div>
      <p className="text-xs text-muted">AdmitIQ gives estimates and guidance, not guarantees. No plan changes how colleges evaluate you.</p>
    </div>
  );
}
