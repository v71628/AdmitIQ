-- Semantic search over the source library with pgvector (enable "vector" in Supabase → Database → Extensions).
-- Embedding size must match OPENAI_EMBEDDING_MODEL (text-embedding-3-small = 1536).
create extension if not exists vector;

alter table source_chunks add column if not exists embedding vector(1536);
alter table source_chunks add column if not exists embedding_model text;
create index if not exists source_chunks_embedding_idx on source_chunks using hnsw (embedding vector_cosine_ops);

-- Hybrid retrieval: vector similarity over chunks + full-text over sources, merged by reciprocal-rank fusion.
-- Lower reliability tiers (1 = official) get a small boost. Broken/rejected sources are never returned.
drop function if exists search_sources(text, text, int, text, text, int);
create or replace function search_sources(query_text text, query_embedding vector(1536) default null, match_count int default 10,
  filter_category text default null, filter_college text default null, max_tier int default 4)
returns table (id uuid, title text, url text, organization text, category text, source_type text, reliability_tier smallint,
  data_year text, last_verified_at timestamptz, summary text, excerpt text, score double precision)
language sql stable as $$
  with eligible as (
    select s.* from sources s
    where s.verification not in ('link_broken', 'rejected')
      and (filter_category is null or s.category = filter_category)
      and (filter_college is null or s.college_id = filter_college)
      and s.reliability_tier <= max_tier
  ),
  fts as (
    select e.id, row_number() over (order by ts_rank_cd(e.search, websearch_to_tsquery('english', query_text)) desc) as r
    from eligible e where e.search @@ websearch_to_tsquery('english', query_text)
    limit 50
  ),
  vec as (
    select c.source_id as id, min(c.embedding <=> query_embedding) as dist
    from source_chunks c join eligible e on e.id = c.source_id
    where query_embedding is not null and c.embedding is not null
    group by c.source_id
    order by dist
    limit 50
  ),
  vec_ranked as (select id, dist, row_number() over (order by dist) as r from vec),
  best_chunk as (
    select distinct on (c.source_id) c.source_id, c.content
    from source_chunks c join vec_ranked v on v.id = c.source_id
    where c.embedding is not null
    order by c.source_id, c.embedding <=> query_embedding
  ),
  fused as (
    select coalesce(f.id, v.id) as id, coalesce(1.0 / (60 + f.r), 0) + coalesce(1.0 / (60 + v.r), 0) as rrf
    from fts f full outer join vec_ranked v on v.id = f.id
  )
  select e.id, e.title, e.url, e.organization, e.category, e.source_type, e.reliability_tier, e.data_year, e.last_verified_at, e.summary,
         left(coalesce(b.content, e.extracted_text, e.summary, ''), 2000) as excerpt,
         (fu.rrf * (1.0 + (4 - e.reliability_tier) * 0.1))::double precision as score
  from fused fu join eligible e on e.id = fu.id left join best_chunk b on b.source_id = e.id
  order by score desc
  limit least(match_count, 50);
$$;
