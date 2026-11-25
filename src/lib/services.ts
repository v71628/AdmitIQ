// Client for the optional AdmitIQ server (server/server.mjs). Every feature has a
// non-AI / offline fallback, so the app is fully usable when this server is absent
// (e.g. on a static host or inside a sandboxed preview).

export interface ServerCaps {
  directory?: { colleges: boolean; highSchools: boolean; stats: boolean } | null;
  reviews?: boolean;
  ai: { provider: string; model: string; providers?: string[]; grounding?: boolean; streaming?: boolean; transcribe?: boolean } | null;
  research: { search: string | null; scorecard: boolean; grounding?: boolean; library?: boolean; embeddings?: boolean };
  billing?: boolean;
  supabase: { url: string; anonKey: string } | null;
}

let capsPromise: Promise<ServerCaps | null> | null = null;
export function serverCaps(): Promise<ServerCaps | null> {
  if (!capsPromise) {
    capsPromise = (async () => {
      // Only probe when served by server/server.mjs (it injects this meta tag); static hosts skip the request.
      if (typeof document !== 'undefined' && !document.querySelector('meta[name="admitiq-server"]')) return null;
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2500);
        const r = await fetch('/api/health', { signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) return null;
        return (await r.json()) as ServerCaps;
      } catch { return null; }
    })();
  }
  return capsPromise;
}

/** Error from the AdmitIQ server. `code` is 'quota' | 'plan_required' | 'budget' | 'unconfigured' when relevant. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}
async function post<T>(path: string, body: unknown, token: string | undefined = session?.access_token): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError((data as { error?: string }).error || `Request failed (${r.status})`, r.status, (data as { code?: string }).code);
  return data as T;
}

export type AITask = 'chat' | 'analysis' | 'essay' | 'simulation' | 'research' | 'long_document' | 'verify';
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface WebCitation { index: number; title: string; url: string }
export interface AIReply { text: string; provider: string; model: string; citations: WebCitation[]; grounded: boolean; usage: { input: number; output: number }; remaining: Usage }
export interface Usage { plan: string; limit: number; used: number }

/** Stream an AI reply over Server-Sent Events. Calls onDelta for each text chunk; resolves with provider/model/usage. */
async function stream(messages: ChatMessage[], task: AITask, onDelta: (text: string) => void, signal?: AbortSignal) {
  const r = await fetch('/api/ai/stream', { method: 'POST', signal, headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.access_token}` } : {}) }, body: JSON.stringify({ messages, task }) });
  if (!r.ok || !r.body) { const d = await r.json().catch(() => ({})); throw new ApiError((d as { error?: string }).error || `Request failed (${r.status})`, r.status, (d as { code?: string }).code); }
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '', done: { provider: string; model: string; usage: { input: number; output: number }; remaining: Usage } | null = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!ev || !data) continue;
      const j = JSON.parse(data);
      if (ev === 'delta') onDelta(j.text);
      else if (ev === 'done') done = j;
      else if (ev === 'error') throw new ApiError(j.error, j.status || 500);
    }
  }
  if (!done) throw new ApiError('The AI response ended unexpectedly.', 502);
  return done;
}

export const ai = {
  chat: (messages: ChatMessage[], json = false, task: AITask = 'chat') => post<AIReply>('/api/ai', { messages, json, task }),
  run: (task: AITask, messages: ChatMessage[], json = false) => post<AIReply>('/api/ai', { messages, json, task }),
  stream,
  verify: (question: string, answer: string, sources: { title?: string; url?: string; text?: string }[], usedProvider?: string) => post<{ verdict: string; issues: { claim: string; problem: string }[]; notes: string; provider: string; model: string }>('/api/ai/verify', { question, answer, sources, usedProvider }),
  usage: () => post<Usage & { signedIn: boolean }>('/api/me/usage', {}),
  async essay(text: string, prompt: string, mode: string) {
    const sys = `You are a careful college essay reviewer. Evaluate the student's essay on these 12 criteria, each scored 1-10: Authenticity, Personal voice, Specificity, Storytelling, Reflection, Emotional resonance, Structure, Clarity, Originality, Prompt fulfillment, Depth, Memorability.
Rules: Never rewrite the essay in your own voice. Never invent experiences, awards, hardships or details. Quote the student's own words when pointing at problems. Feedback mode: ${mode}.
Return JSON: {"scores":{criterion:number},"overall":string,"strengths":[string],"weaknesses":[string],"line_feedback":[{"quote":string,"comment":string}],"suggestions":[string]}`;
    const r = await this.chat([{ role: 'system', content: sys }, { role: 'user', content: `PROMPT:\n${prompt || '(not provided)'}\n\nESSAY:\n${text}` }], true, 'essay');
    return JSON.parse(r.text.replace(/^```json\s*|```$/g, '')) as { scores: Record<string, number>; overall: string; strengths: string[]; weaknesses: string[]; line_feedback: { quote: string; comment: string }[]; suggestions: string[] };
  },
};

export interface ResearchResult {
  question: string;
  steps: { label: string; status: 'done' | 'skipped' | 'error'; detail: string }[];
  findings: { claim: string; value?: string; source: string; url: string; retrieved: string; reportingYear?: string; confidence: 'High' | 'Medium' | 'Low'; official: boolean }[];
  summary: string | null;
  grounded?: { text: string; citations: WebCitation[]; queries: string[]; model: string } | null;
  verification?: { verdict: string; issues: { claim: string; problem: string }[]; notes: string; provider: string } | null;
  conflicts: string[];
  uncertainty: string[];
}
export interface LibrarySource { id: string; title: string; url: string; organization: string | null; category: string; source_type: string; reliability_tier: 1 | 2 | 3 | 4; data_year: string | null; last_verified_at: string | null; summary: string | null; excerpt: string; score: number }
export const library = {
  search: (q: string, opts: { category?: string; collegeId?: string; limit?: number } = {}) => post<{ results: LibrarySource[]; mode: string }>('/api/library/search', { q, ...opts }),
  answer: (q: string, opts: { category?: string; collegeId?: string } = {}) => post<{ text: string | null; mode: string; note?: string; citations: { n: number; sourceId: string; title: string; url: string; organization: string | null; tier: number; dataYear: string | null; lastVerified: string | null; used: boolean }[] }>('/api/library/answer', { q, ...opts }),
  stats: () => post<{ configured: boolean; total?: number; verified?: number; link_ok?: number; listed?: number; broken?: number; stale?: number; with_text?: number; by_tier?: Record<string, number>; by_category?: Record<string, number>; last_ingested?: string }>('/api/library/stats', {}),
};
export interface PlanPrice { amount: number | null; currency: string; interval: string | null; intervalCount: number }
export const billing = {
  prices: () => post<{ configured: boolean; plans: Partial<Record<'plus' | 'pro' | 'ultimate', Partial<Record<'monthly' | 'annual', PlanPrice>>>>; trials?: Partial<Record<'plus' | 'pro' | 'ultimate', number>> }>('/api/billing/prices', {}),
  checkout: (plan: 'plus' | 'pro' | 'ultimate', period: 'monthly' | 'annual') => post<{ url: string }>('/api/billing/checkout', { plan, period }),
  portal: () => post<{ url: string }>('/api/billing/portal', {}),
  invoices: () => post<{ invoices: { id: string; number: string; amount: number; currency: string; status: string; created: string; pdf: string; url: string }[] }>('/api/billing/invoices', {}),
};
export const admin = { status: () => post<Record<string, unknown>>('/api/admin/status', {}) };
export interface DirCollege { unitid: string; name: string; city: string; state: string; control: string; web: string; lat: number | null; lon: number | null; level: string }
export interface HighSchool { id: string; name: string; city: string; state: string; charter: boolean; enrollment: number | null }
export interface WebReviews { themes: { label: string; tone: 'positive' | 'mixed' | 'negative'; summary: string; sources: number[] }[]; summary: string | null; sources: { title: string; url: string; domain: string; snippet: string }[]; retrieved?: string; note: string }
export const directory = {
  searchColleges: (q: string, state = '') => post<{ results: DirCollege[]; total: number; year: string; source: string }>('/api/colleges/search', { q, state }),
  collegeDetail: (unitid: string) => post<{ directory: DirCollege | null; stats: Record<string, number | number[] | string | null> | null; retrieved?: string; url?: string; note?: string }>('/api/colleges/detail', { unitid }),
  highSchools: (state: string, q: string) => post<{ results: HighSchool[]; total: number; year: string; source: string }>('/api/highschools', { state, q }),
  reviews: (name: string) => post<WebReviews>('/api/reviews', { name }),
};

export const research = {
  ask: (question: string, collegeIds: string[], verify = false) => post<ResearchResult>('/api/research', { question, collegeIds, verify }),
  scorecard: (name: string) => post<{ results: Record<string, unknown>[]; retrieved: string; url: string }>('/api/scorecard', { name }),
};

// ---- Supabase (REST, no SDK) ----
const SESSION_KEY = 'admitiq:session';
export interface Session { access_token: string; refresh_token: string; user: { id: string; email: string }; expires_at: number }
let session: Session | null = (() => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } })();
const saveSession = (s: Session | null) => { session = s; try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ } };

async function sb(cfg: { url: string; anonKey: string }, path: string, init: RequestInit & { auth?: boolean } = {}) {
  const r = await fetch(`${cfg.url}${path}`, { ...init, headers: { apikey: cfg.anonKey, 'content-type': 'application/json', ...(init.auth && session ? { authorization: `Bearer ${session.access_token}` } : {}), ...(init.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.msg || data.error_description || data.message || `Supabase error ${r.status}`);
  return data;
}

function decodeJwt(t: string): { sub?: string; email?: string; exp?: number } {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; }
}

// Supabase email links (magic link, signup confirmation, password recovery) return to the app with
// tokens in the URL hash. Capture them before the hash router sees them, then clean the URL.
export function captureAuthRedirect(): { type: string; error?: string } | null {
  if (typeof location === 'undefined') return null;
  const h = location.hash.replace(/^#/, '');
  if (!/(^|&)(access_token|error_description)=/.test(h)) return null;
  const q = new URLSearchParams(h);
  if (q.get('error_description')) { history.replaceState(null, '', location.pathname + '#login'); return { type: 'error', error: q.get('error_description')! }; }
  const access = q.get('access_token')!, claims = decodeJwt(access);
  saveSession({ access_token: access, refresh_token: q.get('refresh_token') || '', expires_at: Number(q.get('expires_at')) || claims.exp || Date.now() / 1000 + Number(q.get('expires_in') || 3600), user: { id: claims.sub || '', email: claims.email || '' } });
  const type = q.get('type') || 'magiclink';
  history.replaceState(null, '', location.pathname + (type === 'recovery' ? '#reset-password' : '#dashboard'));
  try { sessionStorage.setItem('admitiq:justSignedIn', '1'); } catch { /* ignore */ }
  return { type };
}

export const auth = {
  current: () => session,
  async requestPasswordReset(cfg: { url: string; anonKey: string }, email: string) {
    await sb(cfg, `/auth/v1/recover?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`, { method: 'POST', body: JSON.stringify({ email }) });
  },
  async updatePassword(cfg: { url: string; anonKey: string }, password: string) {
    await sb(cfg, '/auth/v1/user', { method: 'PUT', auth: true, body: JSON.stringify({ password }) });
  },
  async deleteAccount(cfg: { url: string; anonKey: string }) {
    await this.refresh(cfg);
    await sb(cfg, '/rest/v1/rpc/delete_my_account', { method: 'POST', auth: true, body: '{}' });
    saveSession(null);
  },
  async signUp(cfg: { url: string; anonKey: string }, email: string, password: string) {
    const d = await sb(cfg, `/auth/v1/signup?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`, { method: 'POST', body: JSON.stringify({ email, password }) });
    if (d.access_token) saveSession({ ...d, expires_at: Date.now() / 1000 + d.expires_in });
    return d.access_token ? 'signed-in' : 'confirm-email';
  },
  async signIn(cfg: { url: string; anonKey: string }, email: string, password: string) {
    const d = await sb(cfg, '/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) });
    saveSession({ ...d, expires_at: Date.now() / 1000 + d.expires_in });
  },
  async magicLink(cfg: { url: string; anonKey: string }, email: string) {
    await sb(cfg, `/auth/v1/otp?redirect_to=${encodeURIComponent(location.origin + location.pathname)}`, { method: 'POST', body: JSON.stringify({ email, create_user: true }) });
  },
  async refresh(cfg: { url: string; anonKey: string }) {
    if (!session) return;
    if (session.expires_at - 60 > Date.now() / 1000) return;
    const d = await sb(cfg, '/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) });
    saveSession({ ...d, expires_at: Date.now() / 1000 + d.expires_in });
  },
  async signOut(cfg: { url: string; anonKey: string } | null) {
    try { if (cfg && session) await sb(cfg, '/auth/v1/logout', { method: 'POST', auth: true }); } catch { /* ignore */ }
    saveSession(null);
  },
  // Server-side the RPC functions write to normalized tables under row-level security (see supabase/migrations).
  async push(cfg: { url: string; anonKey: string }, state: unknown) { await this.refresh(cfg); return sb(cfg, '/rest/v1/rpc/sync_state', { method: 'POST', auth: true, body: JSON.stringify({ payload: state }) }); },
  async pull(cfg: { url: string; anonKey: string }) { await this.refresh(cfg); return sb(cfg, '/rest/v1/rpc/load_state', { method: 'POST', auth: true, body: '{}' }); },
  // Anonymous experience submissions: inserted without any user id (the table has none); shown only after moderation.
  async submitExperience(cfg: { url: string; anonKey: string }, e: { collegeId: string; relation: string; year: string; ratings: Record<string, number>; positives: string; concerns: string }) {
    await this.refresh(cfg);
    const r = await fetch(`${cfg.url}/rest/v1/student_experience_submissions`, { method: 'POST', headers: { apikey: cfg.anonKey, authorization: `Bearer ${session?.access_token}`, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ college_id: e.collegeId, relation: e.relation, year: Number(e.year) || null, ratings: e.ratings, positives: e.positives, concerns: e.concerns, consent: true }) });
    if (!r.ok) throw new Error(`Could not submit (${r.status})`);
  },
  async approvedExperiences(cfg: { url: string; anonKey: string }, collegeId: string) {
    const r = await fetch(`${cfg.url}/rest/v1/student_experience_submissions?college_id=eq.${encodeURIComponent(collegeId)}&select=id,relation,year,ratings,positives,concerns,created_at&order=created_at.desc&limit=200`, { headers: { apikey: cfg.anonKey } });
    if (!r.ok) return [];
    return (await r.json()) as { id: string; relation: string; year: number | null; ratings: Record<string, number>; positives: string; concerns: string; created_at: string }[];
  },
  async deleteAccountData(cfg: { url: string; anonKey: string }) { await this.refresh(cfg); return sb(cfg, '/rest/v1/rpc/delete_my_data', { method: 'POST', auth: true, body: '{}' }); },
};
