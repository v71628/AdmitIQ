# AI architecture

AdmitIQ uses real AI providers through one server-side router (`server/ai/router.mjs`). The browser never sees an API key. If no provider is configured, AI features say so. They never return simulated answers.

## Providers

| Provider | Role | Required? | Env |
|---|---|---|---|
| **OpenAI** | Primary student-facing model: chat, profile analysis, college lists, comparisons, essay feedback, admissions simulations | Recommended | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_MODEL_FAST`, `OPENAI_MODEL_REASONING` |
| **Google Gemini** | Research with **Google Search grounding**: current deadlines, policies, tuition and programs, with real web citations | Optional | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_RESEARCH_MODEL` |
| **Anthropic Claude** | Optional long-document analysis, application reviews, essay critiques, independent verification | Optional | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| Legacy (`AI_PROVIDER`) | v1 single-provider setups (Groq, Ollama, OpenRouter, any OpenAI-compatible server) | Optional | `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` |

**Model IDs are never hard-coded.** If a model variable is blank, the router asks that provider's `/models` endpoint and picks the newest stable model for the tier:
- OpenAI: `gpt-N-mini` for fast, `gpt-N` for main, `gpt-N-pro` / `oN` for reasoning.
- Anthropic: Haiku for fast, Sonnet for main, Opus for reasoning.
- Gemini: Flash for grounded research, Pro for main.

Preview, audio, realtime and image models are skipped. If a model disappears (a 404 or a "model not found" error), the router drops the cached list and tries the next route.

## Routing

Each request names a **task**. The first configured, healthy entry in that task's route is used, and the rest are fallbacks:

| Task | Route (default) | Units |
|---|---|---|
| `chat` | openai:fast → gemini:fast → anthropic:fast → legacy | 1 |
| `analysis` | openai:main → anthropic:main → gemini:main → legacy | 2 |
| `essay` | openai:main → anthropic:main → legacy → gemini:main | 3 |
| `simulation` | openai:reasoning → openai:main → anthropic:main → legacy | 6 |
| `research` | **gemini:grounded** → openai:main → anthropic:main → legacy | 3 |
| `long_document` | anthropic:main → openai:main → gemini:main → legacy | 4 |
| `verify` | anthropic:main → gemini:main → openai:main (never the provider that wrote the answer) | 1 |

- A `chat` prompt longer than `AI_ESCALATE_CHARS` (16,000 by default) moves from the fast tier to the main tier, so cheap models aren't given jobs they can't do.
- Any route can be overridden, for example `AI_ROUTE_ESSAY=anthropic:main,openai:main`.
- Research answers from a provider other than Gemini come back with `grounded: false`, and the UI must label them as not web-grounded.

## Reliability

- **Retries.** Errors 408, 409, 425, 429 and 5xx are retried up to `AI_MAX_RETRIES` times (2 by default) with exponential backoff, honoring `Retry-After` up to 8 seconds.
- **Fallbacks.** After the retries run out, the next provider in the route is tried. A 401 or 403 marks the provider down for 10 minutes; repeated 5xx errors mark it down for 30 seconds. Healthy providers are tried first, but a provider marked down is never removed entirely.
- **Streaming** (`POST /api/ai/stream`, Server-Sent Events) works with OpenAI, OpenAI-compatible servers, Anthropic and Gemini. It falls back to another provider only if no text has been sent yet; if a stream breaks midway, the client gets the partial text and an error event.
- **Timeouts.** `AI_TIMEOUT_MS` (90 seconds by default) per call.

## Cost and usage controls

- Every call records provider, model, task, input and output tokens, latency and success. Records stay in memory for the admin view, and are written to `ai_usage` in Supabase when `SUPABASE_SERVICE_ROLE_KEY` is set.
- **Cost** = tokens × the price in `AI_PRICING_JSON` (USD per 1M tokens). Prices are not built in because they change; models without a price are reported as "unpriced", not as $0.
- `AI_MONTHLY_BUDGET_USD` stops every task except basic chat once the month's priced spend reaches the cap.
- **Per-user daily units.** Each plan gets a daily allowance (see `server/plans.mjs`, overridable with `AI_DAILY_UNITS_JSON`). Signed-in users are counted by user id and anonymous users by IP. Going over returns `429 {code:"quota"}`.
- **Feature gating.** `simulation` and `long_document` need Pro; `essay` needs Plus. A request below the required plan returns `402 {code:"plan_required"}`.
- The per-IP request rate limit (`RATE_LIMIT_PER_MIN`) applies before any of this.

## Research and RAG

`POST /api/research` runs these steps in order, and reports each one in `steps[]`:
1. Official College Scorecard values for the named colleges, if a key is set.
2. A web search (Tavily or Brave) with official domains ranked first, plus robots.txt-aware page reads.
3. The **AdmitIQ source library**: hybrid retrieval through `search_sources()`, which combines pgvector similarity over chunks with Postgres full-text search using reciprocal-rank fusion and a boost for tier-1 sources.
4. **Gemini with Google Search grounding**. Its `groundingChunks` become cited findings.
5. A summary that may cite only the numbered findings, and must state conflicts and gaps.
6. Optional **independent verification** (`verify: true`): a second provider checks the summary against the findings and returns `supported`, `partially_supported` or `unsupported`, with the specific issues.

`POST /api/library/answer` is pure RAG over the source library. Its citations carry `sourceId`, a real `sources.id`, plus URL, reliability tier, data year and last-verified date.

## API

| Route | Purpose |
|---|---|
| `POST /api/ai` | `{task, messages, json?}` → `{text, provider, model, citations, grounded, usage, remaining}` |
| `POST /api/ai/stream` | SSE events: `delta {text}` … then `done {provider, model, usage, remaining}` or `error` |
| `POST /api/ai/verify` | `{question, answer, sources, usedProvider}` → verdict |
| `POST /api/library/search` · `/answer` · `/stats` | Source library |
| `POST /api/me/usage` | The caller's plan, daily limit and units used |
| `POST /api/admin/status` | Provider health, routes, usage and cost (24 hours and 30 days), database counts. Restricted to `ADMIN_EMAILS` |
| `GET /api/health` | Which capabilities are configured. Contains no secrets |

## Tests

`npm test` runs mocked-provider unit tests for routing, discovery, retries, fallbacks, Gemini grounding, Anthropic and OpenAI formats, streaming, quotas, gating and verification. It also runs an end-to-end test that boots the real server against local mock AI, Supabase and Stripe services. These tests use no real API keys.
