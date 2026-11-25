// Display copy for subscription plans. Enforcement lives on the server (server/plans.mjs);
// prices come from Stripe at runtime and are never hard-coded here.
export type PlanId = 'free' | 'plus' | 'pro' | 'ultimate';

export const PLAN_INFO: { id: PlanId; name: string; tagline: string; units: number; features: string[] }[] = [
  { id: 'free', name: 'Free', tagline: 'Everything you need to start', units: 30, features: ['College search and profiles', 'Student profile and GPA tools', 'Compare up to 3 colleges', 'Basic AI advisor (quick answers)', 'Rule-based admissions analysis', 'Application tracker and cost calculator'] },
  { id: 'plus', name: 'Plus', tagline: 'Deeper analysis and more AI', units: 150, features: ['Everything in Free', 'Compare up to 10 colleges', 'Deep-analysis AI mode', 'AI essay feedback', 'Personalized recommendations', 'Intermediate analytics'] },
  { id: 'pro', name: 'Pro', tagline: 'For serious applicants', units: 500, features: ['Everything in Plus', 'Admissions committee simulation', 'Full essay lab with AI deep reads', 'Detailed college reports', 'Research with web sources', 'Full analytics'] },
  { id: 'ultimate', name: 'Ultimate', tagline: 'Highest limits and every tool', units: 1500, features: ['Everything in Pro', 'Highest AI usage limits', 'Long-document application reviews', 'Extensive application planning', 'Priority access to new tools'] },
];

export const TASK_UNIT_COSTS: { task: string; units: number }[] = [
  { task: 'Quick answer', units: 1 }, { task: 'Deep analysis', units: 2 }, { task: 'Essay feedback', units: 3 },
  { task: 'Research with sources', units: 3 }, { task: 'Long document review', units: 4 }, { task: 'Committee simulation', units: 6 },
];

export function formatPrice(amount: number | null, currency: string) {
  if (amount === null) return null;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100); }
  catch { return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`; }
}
