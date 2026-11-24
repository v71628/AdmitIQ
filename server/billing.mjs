// Stripe billing over plain HTTPS (no SDK). Nothing here runs unless STRIPE_SECRET_KEY is set,
// and the API reports `billing: false` so the pricing page can say payments are not configured.
import crypto from 'node:crypto';
import { planForPrice } from './plans.mjs';

const form = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => {
  const key = prefix ? `${prefix}[${k}]` : k;
  if (v === undefined || v === null) return [];
  if (typeof v === 'object') return form(v, key);
  return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`];
}).join('&').replace(/^&|&$/g, '');

export function createBilling(env, supabase, { fetchImpl = globalThis.fetch } = {}) {
  const key = env.STRIPE_SECRET_KEY;
  const enabled = !!key;
  const appUrl = (env.APP_URL || `http://localhost:${env.PORT || 8787}`).replace(/\/$/, '');

  async function stripe(path, params, method = 'POST') {
    if (!enabled) throw Object.assign(new Error('Payments are not configured on this server (STRIPE_SECRET_KEY is missing).'), { status: 503 });
    const r = await fetchImpl(`https://api.stripe.com/v1/${path}${method === 'GET' && params ? `?${form(params)}` : ''}`, { method, signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: method === 'GET' ? undefined : form(params || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`Stripe: ${d?.error?.message || r.status}`), { status: 502 });
    return d;
  }

  function priceFor(plan, period) {
    const id = env[`STRIPE_PRICE_${String(plan).toUpperCase()}_${String(period).toUpperCase()}`];
    if (!id) throw Object.assign(new Error(`No Stripe price configured for ${plan} (${period}).`), { status: 400 });
    return id;
  }

  async function customerFor(user) {
    const rows = supabase.admin ? await supabase.select(`billing_customers?user_id=eq.${user.id}&select=stripe_customer_id`).catch(() => []) : [];
    if (rows?.[0]?.stripe_customer_id) return rows[0].stripe_customer_id;
    const c = await stripe('customers', { email: user.email || undefined, metadata: { user_id: user.id } });
    if (supabase.admin) await supabase.insert('billing_customers', [{ user_id: user.id, stripe_customer_id: c.id }], { upsert: true, onConflict: 'user_id' });
    return c.id;
  }

  async function checkout(user, { plan, period = 'monthly' }) {
    if (!['plus', 'pro', 'ultimate'].includes(plan)) throw Object.assign(new Error('Unknown plan'), { status: 400 });
    if (!['monthly', 'annual'].includes(period)) throw Object.assign(new Error('Unknown billing period'), { status: 400 });
    const customer = await customerFor(user);
    const s = await stripe('checkout/sessions', {
      mode: 'subscription', customer, client_reference_id: user.id,
      line_items: { 0: { price: priceFor(plan, period), quantity: 1 } },
      success_url: `${appUrl}/#/billing?status=success`, cancel_url: `${appUrl}/#/pricing?status=cancelled`,
      allow_promotion_codes: 'true', subscription_data: { metadata: { user_id: user.id } },
    });
    return { url: s.url };
  }

  async function portal(user) {
    const customer = await customerFor(user);
    const s = await stripe('billing_portal/sessions', { customer, return_url: `${appUrl}/#/billing` });
    return { url: s.url };
  }

  async function invoices(user) {
    const customer = await customerFor(user);
    const d = await stripe('invoices', { customer, limit: 24 }, 'GET');
    return (d.data || []).map((i) => ({ id: i.id, number: i.number, amount: i.amount_paid, currency: i.currency, status: i.status, created: new Date(i.created * 1000).toISOString(), pdf: i.invoice_pdf, url: i.hosted_invoice_url }));
  }

  /** Verify the Stripe-Signature header (v1 HMAC-SHA256, 5-minute tolerance). */
  function verifySignature(raw, header, secret = env.STRIPE_WEBHOOK_SECRET, nowSec = Math.floor(Date.now() / 1000)) {
    if (!secret) throw Object.assign(new Error('STRIPE_WEBHOOK_SECRET is not configured.'), { status: 503 });
    const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
    const sigs = String(header || '').split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
    const t = Number(parts.t);
    if (!t || !sigs.length) throw Object.assign(new Error('Missing Stripe signature'), { status: 400 });
    if (Math.abs(nowSec - t) > 300) throw Object.assign(new Error('Stripe signature timestamp outside tolerance'), { status: 400 });
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
    if (!ok) throw Object.assign(new Error('Invalid Stripe signature'), { status: 400 });
    return JSON.parse(raw);
  }

  async function handleWebhook(raw, header) {
    const evt = verifySignature(raw, header);
    if (supabase.admin) await supabase.insert('billing_events', [{ id: evt.id, type: evt.type, payload: evt }], { upsert: true, onConflict: 'id' }).catch(() => {});
    if (/^customer\.subscription\.(created|updated|deleted)$/.test(evt.type)) {
      const sub = evt.data.object;
      const price = sub.items?.data?.[0]?.price?.id;
      const mapped = planForPrice(env, price) || { plan: 'free', period: null };
      let userId = sub.metadata?.user_id;
      if (!userId && supabase.admin) userId = (await supabase.select(`billing_customers?stripe_customer_id=eq.${sub.customer}&select=user_id`).catch(() => []))?.[0]?.user_id;
      if (userId && supabase.admin) {
        await supabase.insert('subscriptions', [{
          user_id: userId, stripe_subscription_id: sub.id, stripe_customer_id: sub.customer, plan: evt.type.endsWith('deleted') ? 'free' : mapped.plan,
          period: mapped.period, status: sub.status, cancel_at_period_end: !!sub.cancel_at_period_end,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : (sub.items?.data?.[0]?.current_period_end ? new Date(sub.items.data[0].current_period_end * 1000).toISOString() : null),
          updated_at: new Date().toISOString(),
        }], { upsert: true, onConflict: 'stripe_subscription_id' });
      }
      return { handled: true, type: evt.type, userId: userId || null };
    }
    return { handled: false, type: evt.type };
  }

  return { enabled, checkout, portal, invoices, handleWebhook, verifySignature, _form: form };
}
