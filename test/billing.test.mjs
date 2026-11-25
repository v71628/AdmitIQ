// Stripe checkout: trial days per plan and redirect URLs the hash router understands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBilling } from '../server/billing.mjs';

function setup(extraEnv = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: new URLSearchParams(opts.body || '') });
    const out = url.endsWith('/customers') ? { id: 'cus_1' } : { id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' };
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const env = { STRIPE_SECRET_KEY: 'sk_test_x', APP_URL: 'https://app.example/', STRIPE_PRICE_PRO_MONTHLY: 'price_pro', STRIPE_PRICE_PLUS_MONTHLY: 'price_plus', ...extraEnv };
  const supabase = { admin: false };
  return { billing: createBilling(env, supabase, { fetchImpl }), calls };
}

test('billing: Pro gets a 7-day trial by default, Plus none', async () => {
  const { billing, calls } = setup();
  assert.equal(billing.trialDays('pro'), 7);
  assert.equal(billing.trialDays('plus'), 0);
  await billing.checkout({ id: 'u1', email: 'a@b.c' }, { plan: 'pro' });
  const s = calls.find((c) => c.url.endsWith('/checkout/sessions')).body;
  assert.equal(s.get('subscription_data[trial_period_days]'), '7');
  assert.equal(s.get('subscription_data[metadata][user_id]'), 'u1');
  assert.equal(s.get('success_url'), 'https://app.example/#billing?status=success');
  assert.equal(s.get('cancel_url'), 'https://app.example/#pricing?status=cancelled');
  await billing.checkout({ id: 'u1' }, { plan: 'plus' });
  const p = calls.filter((c) => c.url.endsWith('/checkout/sessions'))[1].body;
  assert.equal(p.get('subscription_data[trial_period_days]'), null);
});

test('billing: trial length is configurable and can be turned off', () => {
  assert.equal(setup({ STRIPE_TRIAL_DAYS_PRO: '0' }).billing.trialDays('pro'), 0);
  assert.equal(setup({ STRIPE_TRIAL_DAYS_PRO: '14' }).billing.trialDays('pro'), 14);
  assert.equal(setup({ STRIPE_TRIAL_DAYS_ULTIMATE: '3' }).billing.trialDays('ultimate'), 3);
  assert.equal(setup({ STRIPE_TRIAL_DAYS_PRO: 'abc' }).billing.trialDays('pro'), 0);
});
