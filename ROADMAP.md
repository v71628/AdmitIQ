# Roadmap — AdmitIQ V2

The phases from the V2 brief, with where each one stands. See FEATURE_STATUS.md for item-level detail.

| Phase | Scope | Status |
|---|---|---|
| 1 | Foundation and architecture: keep React/esbuild/Tailwind and the zero-dependency Node server, add server modules | ✅ |
| 2 | Auth, database, student profiles: migrations 0002/0003, RLS, plan lookup, data export | ✅ backend |
| 3 | Real AI providers: OpenAI, Gemini (grounded), Anthropic, router, streaming, verification, quotas | ✅ |
| 4 | Research infrastructure and 5,000+ sources: pipeline producing 37,355 tier-1 records, link check, extraction, embeddings, hybrid RAG | ✅ code · **run `npm run ingest` to load** |
| 5 | College database: 6,163 IPEDS institutions plus ≈63k statistics | ✅ code · load with phase 4 |
| 6 | Majors and careers: 2,028 CIP majors, 343 BLS careers, completions | ✅ code · crosswalk ⬜ |
| 7 | Admissions evaluation engine (AI layer on top of the v1 rules) | 🟡 backend routing; prompts and UI next |
| 8 | Committee simulation | 🟡 backend routing and gating; prompts and UI next |
| 9 | Search across the full database, natural-language search, list builder | ⬜ next |
| 10 | Comparisons and graphs with the new data | ⬜ |
| 11 | Essay lab AI (routes to `essay`, version history already exists) | 🟡 |
| 12 | Dashboard and application tracking | ⬜ |
| 13 | Subscriptions and billing | ✅ backend · pricing and billing UI ⬜ |
| 14 | UI redesign and animations | ⬜ needs a working build |
| 15 | Testing, optimization, deployment readiness | 🟡 server and DB tested; UI tests ⬜ |

## Next session (with npm available)

1. `npm install && npm run build && npm test`. Confirm v1 still builds with the new `services.ts`.
2. Apply the migrations to Supabase, then run `npm run ingest` and `npm run sources:verify -- --limit=40000`. Check the counts in the admin view.
3. Point college search at the database: the `colleges` and `college_statistics` tables in place of the 38 bundled colleges.
4. Build the source library page, the advisor chat with streaming and citations, the pricing and billing pages, and the admin page, all on the client APIs that already exist.
5. Write prompts for the committee simulation and AI profile evaluation. Every score must be labeled measured, rule-based or AI estimate.
6. Redesign and animate the UI, with Framer Motion and Recharts if the bundle budget allows, respecting reduced-motion.
