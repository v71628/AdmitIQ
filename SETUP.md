# Setup

## 1. Run locally (no keys needed)

```bash
npm install
npm run build
npm start          # http://localhost:8787
npm test           # server, AI router and ingestion tests (no network, no keys)
```

## 2. Turn on AI

Add these to `.env` (see ENVIRONMENT_VARIABLES.md):

```bash
OPENAI_API_KEY=sk-...          # primary
GEMINI_API_KEY=...             # research with Google Search grounding
ANTHROPIC_API_KEY=...          # optional
# Model IDs are optional. Blank means the newest model is picked automatically.
AI_PRICING_JSON={"<model-id>":{"input":<usd per 1M>,"output":<usd per 1M>}}   # optional, enables cost tracking
```

Then check: `curl -s localhost:8787/api/health | jq .ai`

## 3. Supabase

1. Create a project. In **Database → Extensions**, enable `vector`.
2. Run the migrations in order in the SQL editor, or with `supabase db push`:
   `supabase/migrations/0001_init.sql`, then `0002_v2.sql`, then `0003_pgvector.sql`.
3. Add `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to `.env`. The service role key is **server only**.
4. Set `ADMIN_EMAILS=you@example.com` to unlock `/api/admin/status`.

To test the migrations locally (needs Postgres 15+ binaries): `npm run db:test`

## 4. Load the data (6,163 colleges, ≈37,000 sources, 2,028 majors, 343 careers)

```bash
npm run ingest:dry                    # fetch and count only; writes data/ingest/*.ndjson
npm run ingest                        # load into Supabase (≈10–20 min)
npm run ingest -- --only=completions  # optional: which colleges award each major (large)
npm run sources:verify -- --limit=40000 --concurrency=12   # link-check (hours; polite, 1 req/s per host)
npm run sources:verify -- --extract --embed --limit=5000   # page text + embeddings for semantic search
```

If bls.gov or nces.ed.gov block the script (HTTP 403), open the file in a browser, save it, and pass it in:
`npm run ingest -- --only=bls --bls-file=~/Downloads/xml-compilation.xml`
`npm run ingest -- --only=cip --cip-file=~/Downloads/CIPCode2020.csv`

The final report prints the real counts. The admin dashboard reads them from `source_library_stats()` and `admin_dashboard_stats()`.

## 5. Stripe

1. Create Products and Prices for Plus, Pro and Ultimate, monthly and annual. Put the price IDs in `STRIPE_PRICE_*`.
2. Add `STRIPE_SECRET_KEY`. Add a webhook endpoint at `https://YOUR_APP/api/billing/webhook` for the `customer.subscription.*` events, and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Local testing: `stripe listen --forward-to localhost:8787/api/billing/webhook`

## 6. Deploy

The server is one zero-dependency Node process (`npm start`), so it runs anywhere Node 18+ runs. `render.yaml` and the `Dockerfile` are included. On Vercel, run it as a Node server rather than as static hosting, because the API routes need the server. Set `TRUST_PROXY=true` behind a proxy.
