// Display copy for subscription plans. Enforcement lives on the server (server/plans.mjs);
// prices come from Stripe at runtime and are never hard-coded here.
// Every line here must describe something the app actually does for that plan.
export type PlanId = 'free' | 'plus' | 'pro' | 'ultimate';

export interface PlanCard { id: PlanId; name: string; tagline: string; units: number; highlight?: string; features: string[]; perks?: string[] }

export const PLAN_INFO: PlanCard[] = [
  { id: 'free', name: 'Free', tagline: 'Everything you need to start', units: 30,
    features: ['AI advisor: quick answers, deep analysis and research with sources', 'College search, profiles and side-by-side compare', 'College list builder with reach / target / likely sorting', 'Application tracker, deadlines and cost calculator', 'Rule-based admissions analysis'] },
  { id: 'plus', name: 'Plus', tagline: 'More AI every day, plus essay feedback', units: 150,
    features: ['Everything in Free', '5× the daily AI of Free', 'AI essay feedback in the Essay lab'] },
  { id: 'pro', name: 'Pro', tagline: 'The full admissions team in your pocket', units: 500,
    highlight: 'Pro-only AI tools',
    features: ['Everything in Plus', 'Admissions committee simulation: three AI readers debate your application for a specific college, vote, and tell you what would flip the decision', 'Full application review: paste your whole application and get a ranked fix list, reader by reader', '500 AI units a day: about 16× Free and over 3× Plus'],
    perks: ['Enough for ~250 deep analyses or ~80 committee runs a day', 'Cancel any time in the billing portal'] },
  { id: 'ultimate', name: 'Ultimate', tagline: 'For heavy, every-day use', units: 1500,
    features: ['Everything in Pro', '1,500 AI units a day: 3× Pro', 'Run committee simulations and full reviews on every school on your list'] },
];

export const TASK_UNIT_COSTS: { task: string; units: number; plan?: string }[] = [
  { task: 'Quick answer', units: 1 }, { task: 'Deep analysis', units: 2 }, { task: 'Research with sources', units: 3 },
  { task: 'Essay feedback', units: 3, plan: 'Plus' }, { task: 'Full application review', units: 4, plan: 'Pro' }, { task: 'Committee simulation', units: 6, plan: 'Pro' },
];

export function formatPrice(amount: number | null, currency: string) {
  if (amount === null) return null;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100); }
  catch { return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`; }
}
