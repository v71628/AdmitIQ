// Retrieval-augmented generation over the source library.
// Hybrid retrieval: pgvector similarity (OpenAI embeddings) + Postgres full-text, merged with
// reciprocal-rank fusion by the `search_sources` SQL function (supabase/migrations/0002_v2.sql).
// Citations returned to the client always point at real `sources.id` rows.

export function createRAG(env, supabase, router, { fetchImpl = globalThis.fetch } = {}) {
  const embedModel = env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'; // 1536 dims — must match the vector column
  const canEmbed = !!env.OPENAI_API_KEY;
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

  async function embed(texts) {
    if (!canEmbed) return null;
    const r = await fetchImpl(`${base}/embeddings`, { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: embedModel, input: texts }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`Embedding error: ${d?.error?.message || r.status}`), { status: 502 });
    return d.data.map((x) => x.embedding);
  }

  async function search(query, { limit = 8, category, collegeId, minTier } = {}) {
    if (!supabase.admin) throw Object.assign(new Error('The source library needs Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).'), { status: 503 });
    const vec = await embed([query]).then((v) => v?.[0] || null).catch(() => null);
    const rows = await supabase.rpc('search_sources', { query_text: query, query_embedding: vec, match_count: Math.min(limit, 20), filter_category: category || null, filter_college: collegeId || null, max_tier: minTier || 4 });
    return { results: rows || [], mode: vec ? 'hybrid (vector + full-text)' : 'full-text only (no embedding key)' };
  }

  /** Answer a question using only retrieved source records; returns text with [n] citations mapped to source ids. */
  async function answer(question, { user, collegeId, category } = {}) {
    const { results, mode } = await search(question, { limit: 8, collegeId, category });
    if (!results.length) return { text: null, citations: [], mode, note: 'No matching sources in the library yet. Run the ingestion pipeline (npm run ingest) to populate it.' };
    const ctx = results.map((s, i) => `[${i + 1}] ${s.title} — ${s.organization || ''} (${s.source_type}, tier ${s.reliability_tier}, data year ${s.data_year || 'n/a'}, last verified ${s.last_verified_at?.slice(0, 10) || 'never'})\nURL: ${s.url}\n${(s.excerpt || s.summary || '').slice(0, 1800)}`).join('\n\n');
    const out = await router.run({ task: 'research', user, messages: [
      { role: 'system', content: 'Answer ONLY from the numbered source records. Cite every factual sentence like [2]. Prefer tier 1 (official) sources. If records disagree, show both values with their years and sources instead of choosing one. If the records do not answer the question, say exactly what is missing. Never invent statistics.' },
      { role: 'user', content: `Question: ${question}\n\nSource records:\n${ctx}` },
    ] });
    const used = new Set([...out.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    return {
      text: out.text, mode, provider: out.provider, model: out.model,
      citations: results.map((s, i) => ({ n: i + 1, sourceId: s.id, title: s.title, url: s.url, organization: s.organization, tier: s.reliability_tier, dataYear: s.data_year, lastVerified: s.last_verified_at, used: used.has(i + 1) })),
      webCitations: out.citations,
    };
  }

  return { embed, search, answer, canEmbed, embedModel };
}
