-- AdmitIQ V2 schema: research source library, national institution database, majors & careers,
-- AI conversations + usage, subscriptions, saved reports, ingestion bookkeeping.
-- Works on plain Postgres 15+ (Supabase). Vector search is added separately in 0003_pgvector.sql,
-- so this migration also runs where pgvector is not installed.

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

-- ---------- colleges: widen for the full IPEDS universe ----------
alter table colleges drop constraint if exists colleges_kind_check;
alter table colleges add constraint colleges_kind_check check (kind in (
  'Public', 'Private', 'Liberal arts', 'Community college', 'International',
  'Private nonprofit', 'Private for-profit', 'Technical', 'Specialized'));
alter table colleges add column if not exists unitid text unique;              -- IPEDS UNITID (U.S.)
alter table colleges add column if not exists control text;                    -- Public | Private nonprofit | Private for-profit
alter table colleges add column if not exists level text;                      -- Four-year | Two-year | Less than two-year
alter table colleges add column if not exists sector int;                      -- IPEDS sector code
alter table colleges add column if not exists degree_granting boolean;
alter table colleges add column if not exists highest_degree int;              -- IPEDS offering_highest_degree
alter table colleges add column if not exists carnegie_basic int;              -- IPEDS cc_basic_2021
alter table colleges add column if not exists locale int;                      -- NCES urban-centric locale code
alter table colleges add column if not exists region int;
alter table colleges add column if not exists zip text;
alter table colleges add column if not exists county text;
alter table colleges add column if not exists alias text;
alter table colleges add column if not exists hbcu boolean;
alter table colleges add column if not exists tribal_college boolean;
alter table colleges add column if not exists land_grant boolean;
alter table colleges add column if not exists medical_degree boolean;
alter table colleges add column if not exists religious_affiliation int;       -- IPEDS code; label in app
alter table colleges add column if not exists inst_size_category int;         -- IPEDS inst_size (1–5)
alter table colleges add column if not exists admissions_url text;
alter table colleges add column if not exists financial_aid_url text;
alter table colleges add column if not exists net_price_calculator_url text;
alter table colleges add column if not exists active boolean not null default true;
alter table colleges add column if not exists data_year int;                   -- IPEDS directory year the row came from
alter table colleges add column if not exists data_source text;                -- e.g. 'IPEDS via Urban Institute Education Data Portal'
create index if not exists colleges_state_idx on colleges (country, state);
create index if not exists colleges_control_level_idx on colleges (control, level);
create index if not exists colleges_name_trgm2 on colleges using gin (name gin_trgm_ops);

-- Statistics can cite records in the new source library.
alter table college_statistics add column if not exists library_source_id uuid;
create unique index if not exists college_statistics_upsert on college_statistics (college_id, field, reporting_year, library_source_id);

-- Discrepancies between sources are stored, never silently resolved.
create table if not exists data_conflicts (
  id uuid primary key default gen_random_uuid(),
  college_id text references colleges(id) on delete cascade,
  field text not null,
  observations jsonb not null,               -- [{ value, source_id, reporting_year, retrieved_at }]
  status text not null default 'open' check (status in ('open', 'explained', 'resolved')),
  note text,
  detected_at timestamptz not null default now()
);

-- ---------- source library ----------
do $$ begin
  create type source_verification as enum ('listed', 'link_ok', 'link_redirected', 'link_broken', 'content_extracted', 'verified', 'stale', 'rejected');
  create type extraction_status as enum ('not_started', 'queued', 'extracted', 'failed', 'skipped_robots', 'skipped_type');
exception when duplicate_object then null; end $$;

create table if not exists source_categories (
  slug text primary key,
  label text not null,
  sort_order int not null default 0
);
insert into source_categories (slug, label, sort_order) values
  ('college_admissions','College admissions',1),('admissions_statistics','Admissions statistics',2),('common_data_set','University Common Data Sets',3),
  ('academic_programs','College academic programs',4),('majors','University majors',5),('course_catalogs','University course catalogs',6),
  ('tuition_fees','Tuition and fees',7),('financial_aid','Financial aid',8),('scholarships','Scholarships',9),('graduation','Graduation statistics',10),
  ('retention','Retention rates',11),('employment_outcomes','Employment outcomes',12),('career_salaries','Career salaries',13),
  ('employment_projections','Employment projections',14),('demographics','Student demographics',15),('housing','Campus housing',16),
  ('rankings','College rankings and methodologies',17),('testing','Standardized testing',18),('essays','Admissions essays',19),
  ('extracurriculars','Extracurricular activities',20),('academic_research','Academic research',21),('student_life','Student life',22),
  ('affordability','College affordability',23),('career_development','Career development',24),('graduate_school','Graduate school',25),
  ('international_admissions','International admissions',26),('transfer_admissions','Transfer admissions',27),('community_colleges','Community colleges',28),
  ('technical_institutions','Technical institutions',29),('specialized_colleges','Specialized colleges',30),('major_admissions','Major-specific admissions',31),
  ('internships','Internship opportunities',32),('research_opportunities','Research opportunities',33),('application_policies','College application policies',34),
  ('early_decision','Early Decision and Early Action',35),('test_optional','Test-optional policies',36),('institutional_priorities','Institutional priorities',37),
  ('geographic_trends','Geographic admissions trends',38),('application_strategy','College application strategies',39),('higher_ed_research','Higher education research',40),
  ('institution_home','Official institution websites',0),('accessibility','Disability and accessibility services',41),('veterans','Military and veteran students',42),('athletics','Athletics',43)
on conflict (slug) do update set label = excluded.label, sort_order = excluded.sort_order;

create table if not exists sources (
  id uuid primary key default gen_random_uuid(),
  url text not null,                          -- as published
  url_normalized text not null unique,        -- dedupe key (scheme/host lower-cased, no fragment, no trailing slash)
  title text not null,
  organization text,
  publication_date date,
  last_modified timestamptz,                  -- from HTTP Last-Modified when the link checker sees one
  last_verified_at timestamptz,               -- last successful link check / extraction
  data_year text,                             -- e.g. '2023-24', '2025'
  category text not null references source_categories(slug),
  geographic_scope text,                      -- 'US', 'US-MA', 'International'…
  college_id text references colleges(id) on delete set null,
  major_cip text,
  career_soc text,
  source_type text not null check (source_type in ('official_institution_page', 'government_dataset', 'government_publication', 'common_data_set', 'institutional_research', 'peer_reviewed', 'research_org', 'publication', 'ranking_methodology', 'scholarship_program', 'other')),
  reliability_tier smallint not null check (reliability_tier between 1 and 4),
  extracted_text text,
  summary text,                               -- AI summaries are labeled via summary_is_ai
  summary_is_ai boolean not null default false,
  citation jsonb not null default '{}',       -- { publisher, title, url, accessed, year }
  verification source_verification not null default 'listed',
  extraction extraction_status not null default 'not_started',
  http_status int,
  stale_after date,                           -- freshness: when this record should be re-checked
  origin text not null,                       -- which pipeline created it, e.g. 'ipeds_directory:2023'
  origin_ref text,                            -- e.g. 'unitid=166027;field=url_netprice'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(organization, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'C') ||
    setweight(to_tsvector('english', left(coalesce(extracted_text, ''), 200000)), 'D')
  ) stored
);
create index if not exists sources_search_idx on sources using gin (search);
create index if not exists sources_category_idx on sources (category, reliability_tier);
create index if not exists sources_college_idx on sources (college_id);
create index if not exists sources_career_idx on sources (career_soc);
create index if not exists sources_verification_idx on sources (verification, stale_after);
create index if not exists sources_title_trgm on sources using gin (title gin_trgm_ops);

alter table college_statistics drop constraint if exists college_statistics_library_source_fk;
alter table college_statistics add constraint college_statistics_library_source_fk foreign key (library_source_id) references sources(id) on delete set null;

-- Text chunks for retrieval (embeddings are added by 0003_pgvector.sql).
create table if not exists source_chunks (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sources(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  token_estimate int,
  search tsvector generated always as (to_tsvector('english', content)) stored,
  unique (source_id, chunk_index)
);
create index if not exists source_chunks_search_idx on source_chunks using gin (search);

create or replace view sources_freshness with (security_invoker = true) as
  select id, url, title, category, reliability_tier, verification, last_verified_at, stale_after,
         case when verification in ('link_broken', 'rejected') then 'broken'
              when stale_after is not null and stale_after < current_date then 'stale'
              when last_verified_at is null then 'unchecked'
              when last_verified_at > now() - interval '180 days' then 'fresh'
              else 'aging' end as freshness
  from sources;

-- ---------- majors & careers ----------
create table if not exists majors (
  cip_code text primary key,                  -- CIP 2020, e.g. '11.0701'
  title text not null,
  family_code text,                           -- 2-digit CIP family, e.g. '11'
  family_title text,
  definition text,                            -- NCES CIP definition
  typical_coursework text[] not null default '{}',
  skills text[] not null default '{}',
  difficulty text,                            -- labeled as editorial/AI interpretation in the app
  related_cips text[] not null default '{}',
  ai_impact text,                             -- labeled AI interpretation, never presented as data
  source_id uuid references sources(id),
  updated_at timestamptz not null default now()
);
create index if not exists majors_title_trgm on majors using gin (title gin_trgm_ops);

create table if not exists careers (
  occupation_code text primary key,           -- BLS OOH code, e.g. 'B047'
  title text not null,
  soc_codes text[] not null default '{}',
  description text,
  ooh_url text not null,
  median_pay_annual numeric, median_pay_hourly numeric, pay_year text,
  entry_education text, work_experience text, on_the_job_training text,
  employment numeric, employment_year text,
  projected_change_pct numeric, projection_period text, outlook_label text,
  annual_openings numeric,
  source_id uuid references sources(id),
  data_published date,
  updated_at timestamptz not null default now()
);
create index if not exists careers_title_trgm on careers using gin (title gin_trgm_ops);

create table if not exists major_careers (
  cip_code text not null references majors(cip_code) on delete cascade,
  occupation_code text not null references careers(occupation_code) on delete cascade,
  basis text not null default 'nces_cip_soc_crosswalk',
  primary key (cip_code, occupation_code)
);

-- Completions by program (IPEDS) — which colleges actually award degrees in a major.
create table if not exists college_majors (
  college_id text not null references colleges(id) on delete cascade,
  cip_code text not null,
  award_level int not null,                   -- IPEDS award level
  completions int,
  data_year int not null,
  source_id uuid references sources(id),
  primary key (college_id, cip_code, award_level, data_year)
);
create index if not exists college_majors_cip_idx on college_majors (cip_code, completions desc);

-- ---------- ingestion bookkeeping ----------
create table if not exists ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  pipeline text not null,                     -- 'ipeds_directory', 'ipeds_stats', 'bls_ooh', 'link_check', 'extract', 'embed'
  params jsonb not null default '{}',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  fetched int not null default 0, inserted int not null default 0, updated int not null default 0, rejected int not null default 0,
  notes text
);
create table if not exists ingestion_errors (
  id bigint generated always as identity primary key,
  run_id uuid references ingestion_runs(id) on delete cascade,
  ref text, reason text not null, detail jsonb,
  created_at timestamptz not null default now()
);

-- ---------- AI conversations ----------
create table if not exists conversation_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) <= 80),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create table if not exists ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  folder_id uuid references conversation_folders(id) on delete set null,
  title text not null default 'New conversation' check (char_length(title) <= 160),
  context jsonb not null default '{}',        -- which profile parts / colleges the user allowed in this chat
  pinned boolean not null default false,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_conversations_user_idx on ai_conversations (user_id, updated_at desc);
create table if not exists ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references ai_conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  citations jsonb not null default '[]',      -- [{ n, sourceId?, url, title, tier }]
  blocks jsonb,                               -- structured parts: tables, charts (data + provenance)
  provider text, model text, input_tokens int, output_tokens int,
  saved boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ai_messages_conv_idx on ai_messages (conversation_id, created_at);
create table if not exists ai_memory_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  save_history boolean not null default true,
  use_profile boolean not null default true,
  use_financial boolean not null default false,
  use_essays boolean not null default false,
  use_past_conversations boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------- AI usage (written by the server with the service role) ----------
create table if not exists ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete set null,
  task text not null, provider text not null, model text, tier text,
  input_tokens int not null default 0, output_tokens int not null default 0,
  cost_usd numeric(12, 6), latency_ms int, ok boolean not null default true, status int, streamed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_time_idx on ai_usage (created_at desc);
create index if not exists ai_usage_user_idx on ai_usage (user_id, created_at desc);

-- ---------- evaluations, simulations, reports ----------
create table if not exists admissions_evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  college_id text references colleges(id),
  kind text not null check (kind in ('profile', 'college', 'committee_simulation')),
  scores jsonb not null,                      -- per-dimension { score, basis: 'measured'|'rule'|'ai_estimate', explanation }
  report jsonb not null,
  inputs_hash text,                           -- re-run detection
  provider text, model text,
  created_at timestamptz not null default now()
);
create table if not exists saved_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null, title text not null, body jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------- billing (written only by the server's Stripe webhook) ----------
create table if not exists billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists subscriptions (
  stripe_subscription_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  plan text not null check (plan in ('free', 'plus', 'pro', 'ultimate')),
  period text check (period in ('monthly', 'annual')),
  status text not null,
  cancel_at_period_end boolean not null default false,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_user_idx on subscriptions (user_id, updated_at desc);
create table if not exists billing_events (
  id text primary key, type text not null, payload jsonb not null, received_at timestamptz not null default now()
);

-- ---------- row-level security ----------
do $$
declare t text;
begin
  foreach t in array array['conversation_folders','ai_conversations','ai_messages','ai_memory_settings','admissions_evaluations','saved_reports'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists own_rows on %I', t);
    execute format('create policy own_rows on %I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
  -- Public reference data: read-only for everyone, writes only via the service role.
  foreach t in array array['sources','source_chunks','source_categories','majors','careers','major_careers','college_majors','data_conflicts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists public_read on %I', t);
    execute format('create policy public_read on %I for select to anon, authenticated using (true)', t);
  end loop;
  -- Users may read (never write) their own usage and billing rows.
  foreach t in array array['ai_usage','subscriptions','billing_customers'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists own_read on %I', t);
    execute format('create policy own_read on %I for select to authenticated using (user_id = auth.uid())', t);
  end loop;
  foreach t in array array['billing_events','ingestion_runs','ingestion_errors'] loop
    execute format('alter table %I enable row level security', t);   -- no policies: service role only
  end loop;
end $$;

-- Messages must belong to a conversation the user owns.
drop policy if exists own_rows on ai_messages;
create policy own_rows on ai_messages for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from ai_conversations c where c.id = conversation_id and c.user_id = auth.uid()));

-- ---------- search (full-text version; 0003_pgvector.sql replaces it with hybrid search) ----------
create or replace function search_sources(query_text text, query_embedding text default null, match_count int default 10,
  filter_category text default null, filter_college text default null, max_tier int default 4)
returns table (id uuid, title text, url text, organization text, category text, source_type text, reliability_tier smallint,
  data_year text, last_verified_at timestamptz, summary text, excerpt text, score double precision)
language sql stable as $$
  select s.id, s.title, s.url, s.organization, s.category, s.source_type, s.reliability_tier, s.data_year, s.last_verified_at, s.summary,
         left(coalesce(s.extracted_text, s.summary, ''), 2000) as excerpt,
         (ts_rank_cd(s.search, websearch_to_tsquery('english', query_text)) / s.reliability_tier)::double precision as score
  from sources s
  where s.search @@ websearch_to_tsquery('english', query_text)
    and s.verification not in ('link_broken', 'rejected')
    and (filter_category is null or s.category = filter_category)
    and (filter_college is null or s.college_id = filter_college)
    and s.reliability_tier <= max_tier
  order by score desc
  limit least(match_count, 50);
$$;

-- Real counts for the admin dashboard and the library header. Placeholder/rejected rows are excluded.
create or replace function source_library_stats()
returns table (total bigint, verified bigint, link_ok bigint, listed bigint, broken bigint, stale bigint, with_text bigint,
  by_tier jsonb, by_category jsonb, last_ingested timestamptz)
language sql stable as $$
  select count(*) filter (where verification <> 'rejected'),
         count(*) filter (where verification in ('verified', 'content_extracted', 'link_ok', 'link_redirected')),
         count(*) filter (where verification in ('link_ok', 'link_redirected')),
         count(*) filter (where verification = 'listed'),
         count(*) filter (where verification = 'link_broken'),
         count(*) filter (where verification = 'stale' or (stale_after is not null and stale_after < current_date)),
         count(*) filter (where extracted_text is not null),
         (select jsonb_object_agg(t, n) from (select reliability_tier::text t, count(*) n from sources where verification <> 'rejected' group by 1) x),
         (select jsonb_object_agg(c, n) from (select category c, count(*) n from sources where verification <> 'rejected' group by 1) y),
         max(updated_at)
  from sources;
$$;

create or replace function admin_dashboard_stats()
returns table (users bigint, active_users_30d bigint, subscriptions jsonb, colleges bigint, colleges_active bigint, majors bigint, careers bigint,
  sources_total bigint, sources_verified bigint, sources_stale bigint, failed_ingestion_7d bigint, ai_requests_30d bigint, ai_cost_30d numeric)
language sql stable security definer set search_path = public, auth as $$
  select (select count(*) from auth.users),
         (select count(distinct user_id) from ai_usage where created_at > now() - interval '30 days'),
         (select coalesce(jsonb_object_agg(plan, n), '{}') from (select plan, count(*) n from subscriptions where status in ('active','trialing','past_due') group by plan) s),
         (select count(*) from colleges), (select count(*) from colleges where active),
         (select count(*) from majors), (select count(*) from careers),
         (select count(*) from sources where verification <> 'rejected'),
         (select count(*) from sources where verification in ('verified', 'content_extracted', 'link_ok', 'link_redirected')),
         (select count(*) from sources where verification = 'stale' or (stale_after is not null and stale_after < current_date)),
         (select count(*) from ingestion_errors where created_at > now() - interval '7 days'),
         (select count(*) from ai_usage where created_at > now() - interval '30 days'),
         (select coalesce(sum(cost_usd), 0) from ai_usage where created_at > now() - interval '30 days');
$$;
revoke all on function admin_dashboard_stats() from public, anon, authenticated;

-- Account deletion & data export helpers (called by the server for the signed-in user only).
create or replace function export_my_data()
returns jsonb language sql stable security invoker as $$
  select jsonb_build_object(
    'profile', (select to_jsonb(p) from student_profiles p where p.user_id = auth.uid()),
    'activities', (select coalesce(jsonb_agg(a), '[]') from activities a where a.user_id = auth.uid()),
    'college_list', (select coalesce(jsonb_agg(l), '[]') from college_lists l where l.user_id = auth.uid()),
    'essays', (select coalesce(jsonb_agg(e), '[]') from essays e where e.user_id = auth.uid()),
    'applications', (select coalesce(jsonb_agg(x), '[]') from applications x where x.user_id = auth.uid()),
    'conversations', (select coalesce(jsonb_agg(c), '[]') from ai_conversations c where c.user_id = auth.uid()),
    'messages', (select coalesce(jsonb_agg(m), '[]') from ai_messages m where m.user_id = auth.uid()),
    'evaluations', (select coalesce(jsonb_agg(v), '[]') from admissions_evaluations v where v.user_id = auth.uid()),
    'exported_at', now());
$$;
