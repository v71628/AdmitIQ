// Subscription plans, feature gates and AI usage units. Shared by the server (enforcement)
// and mirrored in src/lib/plans.ts (display). Prices live in Stripe, not here.

export const PLANS = ['anonymous', 'free', 'plus', 'pro', 'ultimate'];

// Daily AI usage units per plan (override with AI_DAILY_UNITS_JSON).
export const PLAN_UNITS = { anonymous: 10, free: 30, plus: 150, pro: 500, ultimate: 1500 };

// How many units each AI task costs.
export const TASK_UNITS = { chat: 1, analysis: 2, essay: 3, research: 3, verify: 1, long_document: 4, simulation: 6 };

// Lowest plan that unlocks each AI task.
const TASK_MIN_PLAN = { chat: 'anonymous', analysis: 'free', research: 'free', verify: 'free', essay: 'plus', long_document: 'pro', simulation: 'pro' };

// Product features (non-AI) by lowest plan. The app shows these; the server enforces the AI ones.
export const FEATURES = {
  basic_search: 'anonymous', profile: 'anonymous', compare_3: 'anonymous', basic_ai: 'anonymous',
  compare_10: 'plus', advanced_profile_analysis: 'plus', analytics_intermediate: 'plus', personalized_recommendations: 'plus', essay_ai_feedback: 'plus',
  committee_simulation: 'pro', essay_lab_full: 'pro', college_reports: 'pro', analytics_full: 'pro', deep_research: 'pro',
  priority_limits: 'ultimate', application_planning_suite: 'ultimate',
};

export const rankOf = (plan) => Math.max(0, PLANS.indexOf(plan || 'anonymous'));
export const planAllows = (plan, task) => rankOf(plan) >= rankOf(TASK_MIN_PLAN[task] || 'anonymous');
export const featureAllowed = (plan, feature) => rankOf(plan) >= rankOf(FEATURES[feature] || 'ultimate');

/** Map a Stripe price id to a plan using STRIPE_PRICE_<PLAN>_<MONTHLY|ANNUAL> env vars. */
export function planForPrice(env, priceId) {
  for (const plan of ['plus', 'pro', 'ultimate']) for (const period of ['MONTHLY', 'ANNUAL'])
    if (env[`STRIPE_PRICE_${plan.toUpperCase()}_${period}`] === priceId) return { plan, period: period.toLowerCase() };
  return null;
}
