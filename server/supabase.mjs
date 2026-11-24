// Minimal Supabase REST helpers (PostgREST + Auth), zero dependencies.
// The service-role key is used ONLY here on the server. It bypasses row-level security, so every
// query built here filters by the verified user id explicitly.

export function createSupabase(env, { fetchImpl = globalThis.fetch } = {}) {
  const url = env.SUPABASE_URL?.replace(/\/$/, '');
  const anon = env.SUPABASE_ANON_KEY;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  const enabled = !!(url && anon);
  const admin = !!(url && service);

  async function rest(path, { method = 'GET', body, headers = {}, prefer } = {}) {
    if (!admin) throw Object.assign(new Error('SUPABASE_SERVICE_ROLE_KEY is not configured on the server.'), { status: 503 });
    const r = await fetchImpl(`${url}/rest/v1/${path}`, { method, signal: AbortSignal.timeout(20_000), headers: { apikey: service, authorization: `Bearer ${service}`, 'content-type': 'application/json', ...(prefer ? { prefer } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) throw Object.assign(new Error(`Supabase ${method} ${path.split('?')[0]}: ${data?.message || r.status}`), { status: 502 });
    return data;
  }

  /** Verify a user's access token with Supabase Auth. Returns { id, email } or null. */
  async function getUser(token) {
    if (!enabled || !token) return null;
    const r = await fetchImpl(`${url}/auth/v1/user`, { signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${token}`, apikey: anon } });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id ? { id: u.id, email: u.email || null } : null;
  }

  /** Current plan from the subscriptions table (written only by the Stripe webhook). */
  async function planFor(userId) {
    if (!admin || !userId) return 'free';
    const rows = await rest(`subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=plan,status,current_period_end&order=updated_at.desc&limit=1`).catch(() => []);
    const s = rows?.[0];
    if (!s || !['active', 'trialing', 'past_due'].includes(s.status)) return 'free';
    if (s.current_period_end && new Date(s.current_period_end).getTime() < Date.now() - 3 * 864e5) return 'free';
    return s.plan || 'free';
  }

  const insert = (table, rows, { upsert = false, onConflict } = {}) =>
    rest(`${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`, { method: 'POST', body: rows, prefer: `${upsert ? 'resolution=merge-duplicates,' : ''}return=minimal` });
  const select = (pathAndQuery) => rest(pathAndQuery);
  const rpc = (fn, args) => rest(`rpc/${fn}`, { method: 'POST', body: args });
  const update = (table, filter, patch) => rest(`${table}?${filter}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });

  return { enabled, admin, getUser, planFor, insert, select, rpc, update, rest };
}
