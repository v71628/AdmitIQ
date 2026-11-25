# Feature status — AdmitIQ V2

Updated 24 Nov 2026. Legend: ✅ done and tested · 🟡 partial · ⛔ blocked (reason given) · ⬜ not started.
"Tested" means automated tests in this repo pass (`npm test`, `npm run db:test`). It does **not** mean the feature was exercised with real API keys or a real Supabase project, because none were available during development.

## New pages (second pass)

Built, bundled and checked in a real browser against mock AI, Supabase and Stripe servers, at desktop and phone widths:
- **AI advisor** (`#advisor`): streaming answers with three modes (quick, deep analysis, research with web citations). Conversations are saved in the browser, with folders, rename, search, saved answers and Markdown export. A profile-context toggle controls what's shared, and every answer shows which provider and model wrote it.
- **Source library** (`#library`): real counts from the database, search and category filters, reliability tier, data year and freshness on every record, and "answer from these sources" with citations to real records.
- **Plans & billing** (`#pricing`): four tiers, with prices read live from Stripe (never hard-coded), checkout, the billing portal, invoices and today's AI usage meter.
- **Admin** (`#admin`): real database counts, AI provider health, usage and cost by provider, task and model, routing, and recent errors. Restricted to `ADMIN_EMAILS`.

Each page explains itself when its service isn't configured. None shows fake data.

## 1–2 · Stack and AI system
| Item | Status | Notes |
|---|---|---|
| Keep the existing stack (React 19 + TypeScript + Tailwind v4 + esbuild, zero-dependency Node server) | ✅ | Already suitable; moving to Next.js would be a rewrite with no benefit to users |
| Multi-provider router: OpenAI (primary), Gemini with Google Search grounding, optional Anthropic, legacy | ✅ | `server/ai/router.mjs`; 12 unit tests |
| Model IDs from env, auto-discovery when blank | ✅ | Nothing pinned to a model that might be retired |
| Task routing and cost-aware tiers, long-prompt escalation | ✅ | |
| Retries, backoff, Retry-After, fallbacks, provider health | ✅ | |
| Token, cost and usage tracking (in memory and `ai_usage`) | ✅ | Cost requires `AI_PRICING_JSON`; otherwise reported as "unpriced" |
| Daily per-plan units, plan feature gates, monthly budget cap | ✅ | `server/plans.mjs` |
| Streaming (SSE) for OpenAI, Anthropic and Gemini | ✅ | `/api/ai/stream`; end-to-end test |
| Independent verification by a second provider | ✅ | `/api/ai/verify`, `verify:true` on research |
| Admin AI configuration UI | ⬜ | Configuration is through env for now; status is in `/api/admin/status` |
| `.env.example` + ENVIRONMENT_VARIABLES.md | ✅ | |

## 3 · Research database (5,000+ sources)
| Item | Status | Notes |
|---|---|---|
| Schema with every requested field, 43 categories, 4 reliability tiers, freshness | ✅ | `0002_v2.sql`; tested on Postgres 16 |
| Ingestion pipeline producing **37,001 unique tier-1 sources** from the directory, plus BLS and dataset sources | ✅ code · ⛔ **load** | Counts measured live (DATA_SOURCES.md). **Loading needs your Supabase service key**, so run `npm run ingest` |
| Link verification, extraction, chunking, embeddings | ✅ code | `npm run sources:verify [--extract] [--embed]`. Not run against the live web from here |
| Hybrid RAG (pgvector + full-text, reciprocal-rank fusion, tier boost) | ✅ SQL · 🟡 | Full-text version tested; the pgvector version (`0003`) needs the extension on Supabase |
| RAG answers citing real `sources.id` rows | ✅ | `/api/library/answer` |
| Discrepancies stored, not hidden | ✅ schema + `findConflicts()` | Shown in the UI: ⬜ |
| Source library UI (search, filters, citation previews, counts) | ✅ | `#library` |
| Tier 2–4 collection, Common Data Sets | ⬜ | Deliberately not bulk-scraped; see DATA_SOURCES.md |

## 4 · College database
| Item | Status | Notes |
|---|---|---|
| 6,163 U.S. institutions (IPEDS), all types incl. HBCUs, tribal, community and for-profit | ✅ code · ⛔ load | `npm run ingest` |
| Admissions, test scores, tuition, room & board, retention, ratio, enrollment, graduation, net price | ✅ code | ≈63,100 values with year and source |
| Deadlines, ED/EA, application platforms | ⬜ | Not in federal data; needs grounded research plus verification |
| International institutions beyond the existing hand-curated set | ⬜ | Planned sources in DATA_SOURCES.md |
| Rankings with source and year | ⬜ | |

## 5 · Majors and careers
| Item | Status | Notes |
|---|---|---|
| 2,028 majors (CIP 2020) with official definitions | ✅ code | Verified live |
| 343 careers (BLS OOH): pay, education, outlook 2025–2035, openings | ✅ code | Verified live. If bls.gov blocks scripts: `--bls-file` |
| Which colleges award each major (IPEDS completions) | ✅ code | `--only=completions` (large) |
| Major → career links | ⬜ | Needs the NCES CIP–SOC crosswalk (xlsx) |
| Major and career explorer UI | ⬜ | |
| Coursework, skills, difficulty, AI-impact fields | 🟡 schema only | Must be labeled AI interpretation when generated |

## 6–8 · Admissions engine, committee simulation, AI advisor
| Item | Status | Notes |
|---|---|---|
| Rule-based, explainable admissions analysis (v1) | ✅ existing | `src/lib/analysis.ts`; no probabilities |
| AI-assisted evaluation and committee simulation backend | 🟡 | Tasks `analysis` and `simulation` (Pro) routed and gated; `admissions_evaluations` table. Prompts and UI ⬜ |
| Persistent conversations, folders, memory controls | 🟡 schema | `ai_conversations`, `ai_messages`, `conversation_folders`, `ai_memory_settings` with RLS. UI ⬜ |
| Streaming, citations, conversation history in the advisor | ✅ | `#advisor` (history is stored in the browser; syncing it to Supabase tables is ⬜) |

## 9–14 · Search, list builder, comparison, essay lab, careers, analytics
| Item | Status | Notes |
|---|---|---|
| v1 features (25+ filters, list builder, 2–10 comparisons, radar charts, essay lab, cost calculator, tracker) | ✅ existing | Unchanged and still working |
| Search across 6,000+ colleges | 🟡 | Server directory search exists (`/api/colleges/search`); querying the database ⬜ |
| Natural-language search | ⬜ | |
| Analytics depth setting, new charts | ⬜ | |

## 15–16 · Auth and billing
| Item | Status | Notes |
|---|---|---|
| Supabase Auth: sign up/in, magic link, reset, deletion, export | ✅ existing + `export_my_data()` | |
| Google login | ⬜ | Supabase setting plus a button |
| Server verifies the user token and looks up the plan | ✅ | Cached for 60 s |
| Stripe checkout, portal, invoices, signed webhooks, plan sync | ✅ backend | Signature verification tested. Says "not configured" without keys |
| Pricing and billing pages | ✅ | `#pricing`, with live Stripe prices |

## 17–19 · Dashboard, design, animation
⬜ for V2. The v1 dashboard and design remain. These phases need a working build (see the top of this file).

## 20–22 · Database, admin, security
| Item | Status | Notes |
|---|---|---|
| All requested tables, indexes, RLS, migrations | ✅ | Tested: idempotent, RLS blocks access across users, ai_messages ownership check |
| Admin stats (users, plans, colleges, majors, careers, verified sources, failed ingestion, AI usage and cost) | ✅ | `#admin` |
| Server-only secrets, validated inputs, rate limits, quotas, CSP | ✅ | `/api/health` exposes no secrets (tested) |

## 23 · Testing
`npm test`: 23 tests passing (router, end-to-end server, ingestion transforms). `npm run db:test`: migration checks passing. Browser and visual tests of the UI weren't possible in this environment.
