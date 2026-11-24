#!/usr/bin/env bash
# Applies supabase/migrations/0001 + 0002 to a throwaway local Postgres with a stub "auth" schema,
# then checks idempotency, search and row-level security. Needs Postgres 15+ binaries on PATH.
# (0003_pgvector.sql needs the pgvector extension and is applied on Supabase.)
set -euo pipefail
DIR=$(mktemp -d); PORT=${PGPORT_TEST:-55432}
initdb -D "$DIR" -A trust >/dev/null
pg_ctl -D "$DIR" -o "-k $DIR -p $PORT" -l "$DIR/log" start >/dev/null
trap 'pg_ctl -D "$DIR" stop >/dev/null; rm -rf "$DIR"' EXIT
P="psql -h $DIR -p $PORT -d postgres -v ON_ERROR_STOP=1 -qAt"
$P <<'SQL'
create role anon; create role authenticated; create role service_role;
create schema auth; create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
SQL
$P -f supabase/migrations/0001_init.sql -f supabase/migrations/0002_v2.sql >/dev/null 2>&1
$P -f supabase/migrations/0002_v2.sql >/dev/null 2>&1 && echo "✓ 0002 is idempotent"
$P <<'SQL'
insert into colleges (id, name, short_name, kind) values ('166027', 'Harvard University', 'Harvard', 'Private nonprofit');
insert into sources (url, url_normalized, title, category, college_id, source_type, reliability_tier, origin) values
  ('https://college.harvard.edu/financial-aid/net-price-calculator', 'https://college.harvard.edu/financial-aid/net-price-calculator', 'Harvard University — Net price calculator', 'affordability', '166027', 'official_institution_page', 1, 'test');
insert into auth.users values ('00000000-0000-0000-0000-000000000001', 'a@x'), ('00000000-0000-0000-0000-000000000002', 'b@x');
insert into ai_conversations (user_id, title) values ('00000000-0000-0000-0000-000000000001', 'mine');
grant usage on schema public to authenticated; grant select, insert on all tables in schema public to authenticated;
SQL
[ "$($P -c "select count(*) from search_sources('net price calculator')")" = 1 ] && echo "✓ search_sources finds the record"
[ "$($P -c "select total from source_library_stats()")" = 1 ] && echo "✓ source_library_stats counts it"
[ "$($P -c "set role authenticated; select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false); select count(*) from ai_conversations" | tail -1)" = 0 ] && echo "✓ RLS hides other users' conversations"
echo "All migration checks passed."
