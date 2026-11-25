# Environment variables

Everything is optional. Without any variables set, AdmitIQ runs in local mode and every non-AI feature works. Copy `.env.example` to `.env`.

**Secrets** (marked 🔒) are read only by `server/*.mjs` and `scripts/ingest/*.mjs`. They must never appear in `src/` or in any variable prefixed `NEXT_PUBLIC_`.

## Server

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `APP_URL` | `http://localhost:PORT` | Public URL, used for Stripe redirect URLs |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for rate limiting when the server runs behind a proxy |
| `RATE_LIMIT_PER_MIN` | `20` | Requests per minute per IP on AI and research routes |
| `ADMITIQ_CONTACT` | – | Contact address placed in the research and ingestion User-Agent |

## AI

| Variable | Purpose |
|---|---|
| 🔒 `OPENAI_API_KEY` | Enables OpenAI, the primary provider |
| `OPENAI_MODEL`, `OPENAI_MODEL_FAST`, `OPENAI_MODEL_REASONING` | Model IDs per tier. Leave blank to auto-select the newest from `/v1/models` |
| `OPENAI_EMBEDDING_MODEL` | Default `text-embedding-3-small` (1,536 dimensions, which must match `0003_pgvector.sql`) |
| `OPENAI_BASE_URL` | Override for proxies or Azure-compatible gateways |
| 🔒 `GEMINI_API_KEY` | Enables Gemini and Google Search grounding for research |
| `GEMINI_MODEL`, `GEMINI_MODEL_FAST`, `GEMINI_RESEARCH_MODEL` | Model IDs. Leave blank to auto-select |
| 🔒 `ANTHROPIC_API_KEY` | Optional Claude provider |
| `ANTHROPIC_MODEL`, `ANTHROPIC_MODEL_FAST`, `ANTHROPIC_MODEL_REASONING` | Model IDs. Leave blank to auto-select |
| `AI_PROVIDER`, 🔒 `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` | Legacy single-provider configuration from v1 |
| `AI_ROUTE_<TASK>` | Override a task's route, e.g. `AI_ROUTE_RESEARCH=gemini:grounded,openai:main` |
| `AI_PRICING_JSON` | `{"model-id":{"input":USD_per_1M,"output":USD_per_1M}}` for cost tracking |
| `AI_MONTHLY_BUDGET_USD` | Monthly spending cap. Every task except chat pauses once it's reached |
| `AI_DAILY_UNITS_JSON` | Daily units per plan, overriding `server/plans.mjs` |
| `AI_LOCAL_PLAN` | Plan given to everyone when Supabase isn't configured (default `ultimate`, for single-user installs) |
| `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_ESCALATE_CHARS` | Reliability tuning |
| `AI_USAGE_LOG` | Set to `false` to stop writing `ai_usage` rows to Supabase |
| `AI_TRANSCRIBE_MODEL` | Speech-to-text model (OpenAI or Groq) |

## Data and research

| Variable | Purpose |
|---|---|
| 🔒 `SCORECARD_API_KEY` | College Scorecard API key (free at api.data.gov) |
| `SEARCH_PROVIDER`, 🔒 `SEARCH_API_KEY` | `tavily` or `brave` web search for the Research center |
| `URBAN_BASE` | Urban Institute Education Data Portal base URL |
| `DIRECTORY_YEARS` | IPEDS directory years to try, newest first (default `2024,2023,2022`). Years that are only partly loaded are skipped automatically |
| `IPEDS_YEARS` | Years to try for the IPEDS statistics datasets |

## Supabase

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | Public key. Safe in the browser because row-level security protects the data |
| 🔒 `SUPABASE_SERVICE_ROLE_KEY` | **Server only.** Bypasses row-level security. Used for usage logging, plan lookup, the source library, ingestion and billing writes |
| `REQUIRE_AUTH` | `true` rejects anonymous AI and research calls |
| `ADMIN_EMAILS` | Comma-separated list of accounts allowed to use `/api/admin/status` |

## Stripe

| Variable | Purpose |
|---|---|
| 🔒 `STRIPE_SECRET_KEY` | Enables checkout, the billing portal and invoices |
| 🔒 `STRIPE_WEBHOOK_SECRET` | Verifies `POST /api/billing/webhook` (HMAC-SHA256, 5-minute tolerance) |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Publishable key. Not secret |
| `STRIPE_PRICE_{PLUS,PRO,ULTIMATE}_{MONTHLY,ANNUAL}` | Stripe Price IDs for each plan and billing period |
| `STRIPE_TRIAL_DAYS_{PLUS,PRO,ULTIMATE}` | Free-trial days added at checkout. Pro defaults to `7`; Plus and Ultimate default to none. Set `0` to turn a trial off |

`SEARCH_API_KEY` in the original brief is the same `SEARCH_API_KEY` listed above.
