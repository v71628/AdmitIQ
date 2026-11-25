# AdmitIQ

**Your college strategy, backed by data.**

AdmitIQ is a college admissions intelligence platform for high-school students: build a profile, search and compare colleges, see honest admissions estimates, model real costs, get essay feedback that keeps your voice, find scholarships, and track every application — in one place.

It is designed to be **free to run**: every core feature works in the browser with no account, no server and no paid API. AI, live federal data, web research and cloud sync are optional add-ons you switch on with environment variables.

---

## V2 (in progress)

V2 adds a multi-provider AI router (OpenAI as primary, Gemini with Google Search grounding, optional Claude), streaming, verification, quotas and cost tracking. It also adds a Supabase schema for a 37,000-record official source library with hybrid pgvector RAG, plus ingestion of all 6,163 IPEDS institutions, 2,028 CIP majors and 343 BLS careers, and Stripe billing.

- **[FEATURE_STATUS.md](FEATURE_STATUS.md)**: what is done, partial or blocked. Read this first.
- [SETUP.md](SETUP.md) · [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) · [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) · [DATA_SOURCES.md](DATA_SOURCES.md) · [ROADMAP.md](ROADMAP.md)

---

## Quick start

```bash
npm install
npm run build        # → dist/
npm start            # → http://localhost:8787
```

That's it — the app runs in **local mode** (data saved in your browser).

To turn on AI, official college data or accounts, run the setup wizard. It asks for each key, **tests it live**, and writes `.env`:

```bash
npm run setup
```

(Or copy `.env.example` to `.env` and edit it by hand.)

Requirements: Node 18.17+ (Node 22 recommended).

| Script | What it does |
|---|---|
| `npm run build` | Bundles the React/TypeScript app with esbuild and compiles Tailwind v4 → `dist/` |
| `npm run build:single` | Also writes `dist/admitiq.html`, a single self-contained file (for static previews) |
| `npm start` | Runs `server/server.mjs` (static hosting + optional API proxy) |
| `npm run setup` | Interactive wizard: connect an AI provider, Scorecard key, Supabase; tests keys and writes `.env` |
| `npm run dev` | Unminified build with inline sourcemaps, then start |
| `npm run typecheck` | Strict TypeScript check of all source |
| `npm run seed` | Regenerates `supabase/seed.sql` from `src/data` |
| `npm run sync:scorecard` | Pulls official College Scorecard values → `src/data/verified.json` (marks fields **Verified**) |

---

## Features (completed)

**Pages:** landing · sign-in/sign-up · onboarding · dashboard · profile · college search · college profile · compare · college list · admissions analysis · essay lab · cost calculator · scholarships · application tracker · AI strategist · research center · student experiences · settings · data & privacy.

**Profile system** — gradual, autosaving, every field optional, Zod-validated
- Academics: GPA (any scale), weighted/unweighted, class rank, trend, SAT/ACT with section scores and dates (validated: SAT steps of 10, sections must sum), planned tests, academic awards.
- Transcript editor by year and term with course level and subject; **three GPA methods** (unweighted 4.0, weighted 5.0-cap, UC-style capped estimate) with the methodology explained; GPA-by-semester trend chart.
- Unlimited activities with all Common App fields; reorderable; strength/leadership/impact/depth-vs-breadth analysis; **description helper** that only removes filler from the student's own words (never adds facts), before/after view, 150/50/100 character counters.
- Personal preferences (setting, region, size, distance, research/internship priorities…). No sensitive characteristics are collected or inferred.
- Private, optional financial profile; excluded from AI requests unless the student opts in.

**College database & search** — 38 institutions (public, private, liberal arts, community colleges, Canada/UK), autocomplete with keyboard navigation, 25+ filters, 10 sort orders, saved searches, compare tray, mobile filter sheet.

**Every statistic shows its provenance**: status (Verified / Unverified / Estimated / Self-reported / AI interpretation / Unavailable), source, link, reporting year, collection date, confidence, and multi-source flag. Missing data says *Unavailable* — it is never guessed. A full **source registry** lists every value.

**Comparison engine** — 2–10 colleges, 32 metrics in 5 categories, toggle categories/metrics, reorder columns, best-value highlighting, radar chart (normalized, hover for raw values), SAT range chart, cost breakdown, net price, graduation/retention and earnings charts; export CSV, copy Markdown table, print.

**Admissions analysis** — per college: competitiveness category, estimated Reach/Target/Likely, strengths, weaknesses, missing info, improvements, strategy, suggested round (with ED caveats), testing recommendation from published policy, major-specific notes (e.g. capacity-limited CS programs). **No probabilities** — the page explains why and documents the exact rules.

**College list builder** — auto-suggested balanced list with fit scores and reasons, Reach/Target/Likely + custom categories, favorites, notes, mismatch flags, tracker status and deadlines, CSV export.

**Essay lab** — paste or upload (.txt, .md, **.docx** parsed in-browser), prompt + word limit + college context, five feedback modes (minimal, structural, deep, grammar-only, brainstorming).
- 12-category rubric with an explanation of what each proxy measures, clearly labeled as feedback — not admissions scores.
- Line-by-line notes, cliché and generic-language detection, repetition, weak transitions, long sentences, passive voice, hedges, reflection gaps, red flags (over limit, wrong college named in "Why us", disciplinary topics).
- Suggested edits (grammar, filler, wordiness) with **accept/reject per edit** and "accept all grammar"; highlights view.
- Version history, restore, **word-level draft diff**, comments anchored to selected text, progress charts across drafts.
- Brainstorming questions generated only from the student's own words. Nothing is rewritten in an artificial voice or invented.
- Optional "AI deep read" via the server (rubric JSON, quotes the student's words, labeled *AI interpretation*).

**AI strategist** — answers the 10 core questions (fit, improvements, strongest activities, majors, testing, affordability, career programs, prioritizing, weaknesses, senior-year plan) and per-college questions using the student's actual profile, tagging every block as *Data*, *Opinion*, *From your profile* or *Missing info*, with source links. Works offline; with an AI provider it adds an open-ended answer grounded in the rule-based analysis.

**Cost calculator** — residency (auto from home state), on campus / at home / off campus, transport/books/personal, need-based grants, merit, outside scholarships, loans, annual increase; per-year breakdown, net price vs sticker vs average net, four-year totals, living/residency scenarios, aid scenarios, budget flags, links to every official net price calculator. Never guarantees aid.

**Scholarship finder** — 16 established national/state programs with official links, profile-based match reasons, filters, saved list, user-tracked scholarships (https links only), scam warning signs. No invented scholarships; deadlines shown as "typical cycle — verify".

**Application tracker** — per-application round, deadline (pre-filled from typical dates for your class year), 9 statuses, 7 checklist items, submission/decision dates and result; completion percentages; deadline alerts; month calendar; timeline with a "today" marker; prioritized tasks with reminders; **.ics export** with 3-day alarms for any calendar app.

**Research center** — research workflow (identify → official sources → search → robots-aware retrieval → cross-check → cited summary → uncertainty), offline fallback to stored data, source registry, methodology and data-label legend.

**Student experiences** — anonymous, consent-required submissions (emails, phone numbers, links and @handles auto-removed); themes, averages, sample size and date range; refuses to summarize below 3 submissions; never scrapes forums. With Supabase, submissions go to a moderated table and only approved ones are shown.

**Voice** — a voice assistant on every page (floating mic) and a ⌘K / Ctrl-K / `/` command palette that share one command engine: "compare Purdue and Michigan", "add Georgia Tech to my list as a reach", "remind me to email Ms. Lee Friday", "what's my next deadline?", "what is early decision?", "read my essay", "practice an interview for Duke", "find engineering schools in California"; anything else goes to the strategist and is answered out loud. Essay dictation (inserts at the cursor) and read-aloud; strategist voice questions with spoken answers. Speech recognition uses the browser's Web Speech API (Chrome, Edge, Safari); other browsers record audio and transcribe it through the server's `/api/transcribe` (Groq or OpenAI Whisper). Speech output uses the device's built-in voices.

**Interview coach** — practice interviews with spoken questions (12-question bank, college-specific "why us" questions). Each answer gets a practice score with length, words-per-minute pace, filler-word counts ("um", "like", "you know"…, with legitimate "I'd like to" excluded), concrete details, story structure, and whether "why us" answers name something specific to the school. Optional AI coaching per answer, retry, session summary and a progress chart. Only transcripts and scores are kept, never recordings.

**What-if simulator** — sliders for SAT, GPA and advanced courses plus a submit-scores toggle; every college estimate on your list recalculates live, with changes highlighted. Never touches your saved profile.

**Aid offer comparer** — enter each award letter; AdmitIQ separates grants and scholarships from work-study, student loans, Parent PLUS and private loans, then shows true net price, the share paid from savings, 4-year cost (accounting for non-renewable scholarships), debt at graduation, an estimated monthly payment, best-value badges, warning flags and a stacked "what this offer is really made of" chart.

**Your next 7 days** — an automatically prioritized plan on the dashboard built from deadlines, open checklist items, tasks, missing supplements, interview prep, upcoming decisions, aid offers to enter and list balance; every item links to where you fix it.

**Glossary & tap-to-explain** — 42 plain-language admissions and financial-aid terms; underlined terms across the app open a definition (with read-aloud).

**Dashboard** — stat counters, profile strength, SAT vs ranges, acceptance rates, net price vs budget, list balance donut, activity strength, application completion, admissions picture, academic trend, essay scores over drafts, deadline timeline, next tasks. Every chart has a title, description, legend, tooltips and a source line.

**Design & UX** — light/dark/system themes, Inter type, tabular numerals, animated counters/charts/rings, skeletons, toasts, accessible modals and confirms, staggered page transitions, reduced-motion support (system setting + in-app toggle), keyboard-navigable tabs and autocomplete, labelled controls, 44px touch targets, intentional mobile layout (bottom tab bar, filter sheet, stacked layouts).

**Data & privacy** — JSON export/import (Zod-validated), demo student (clearly labelled fictional), delete-everything, cloud upload/download/delete when signed in.

**Accounts (with Supabase)** — email + password, magic link, email confirmation and password-reset links (tokens captured from the redirect URL), forgot-password, newest-wins reconcile on sign-in, automatic background sync after edits (never uploads demo data), sync status in the sidebar, and full account deletion (login + all data).

**Reminders** — opt-in browser notifications 14/7/3/1 days before deadlines and for tasks marked "Remind me" (while AdmitIQ is open), plus `.ics` calendar export for reminders when it's closed.

---

## Architecture

```
src/
  main.tsx, App.tsx          hash router, app shell, sidebar + mobile tab bar, theme
  components/                ui.tsx (design system), charts.tsx (SVG/HTML charts), forms.tsx, loader.tsx
  pages/                     one file per page
  lib/                       ← pure logic, no UI
    types.ts                 Zod schemas + types
    store.ts                 local-first state (useSyncExternalStore + localStorage, flush on hide)
    analysis.ts              admissions assessment, fit scoring, list recommendations
    essay.ts                 essay engine (rubric proxies, edits, diff)
    activities.ts gpa.ts cost.ts apps.ts geo.ts strategist.ts format.ts docx.ts
    services.ts              API client: AI, research, Supabase auth/sync (REST, no SDK)
  data/                      colleges.ts (+ provenance), scholarships.ts, demo.ts, verified.json
server/server.mjs            zero-dependency Node server (static + /api/*)
supabase/migrations/         schema, RLS policies, RPCs
supabase/seed.sql            generated reference data
scripts/                     build, seed generator, Scorecard sync
```

**Layers:** UI (pages/components) → data layer (`lib/store`, `data/`) → services (`lib/services` → `server/` API routes) → AI service (provider adapters in the server) → research service (`/api/research`) → database logic (SQL RPCs) → authentication (Supabase GoTrue via REST) → analytics (pure functions in `lib/`).

**Stack:** React 19 · TypeScript · Tailwind CSS v4 · Zod · esbuild · Node (server) · Supabase (Postgres + Auth). Charts and animations are hand-built (SVG + CSS) — see *Known limitations* for why the stack differs from Next.js/shadcn/Recharts/Framer Motion.

---

## Data: where numbers come from

The bundled dataset (`src/data/colleges.ts`) contains approximate values recalled from College Scorecard/IPEDS and institutional Common Data Sets (≈2022–25 reporting). **They are labelled "Unverified (recall)" everywhere** with a confidence level, and fields the author wasn't reasonably sure about are `null` → "Unavailable".

To replace them with **verified** official data:

```bash
SCORECARD_API_KEY=your_key npm run sync:scorecard   # free key: https://api.data.gov/signup
npm run build
```

This writes `src/data/verified.json` (value + retrieval date + source URL per field). Those fields then render as **Verified** with High confidence. Re-run each year.

Source priority used by the research pipeline: official admissions sites → Common Data Sets → official cost/aid pages → College Scorecard → IPEDS → outcome reports → government databases → reputable research orgs → public student discussions (anecdotal only, never for statistics).

---

### Every U.S. college and public high school

When AdmitIQ runs with its server (any deploy below), it reads two free federal datasets through the
[Urban Institute Education Data Portal](https://educationdata.urban.org/) (ODC-By licence, no key needed):

- **NCES IPEDS directory**: every degree-granting U.S. college (about 6,000). Search it on the College search page and add any school to your list. With a free `SCORECARD_API_KEY`, official admissions, cost and outcome figures load from College Scorecard; without one, AdmitIQ shows only the directory facts and says so.
- **NCES Common Core of Data**: every U.S. public high school, used for the high-school autocomplete in your profile. Private schools can be typed freely.

Endpoints: `POST /api/colleges/search {q, state}`, `/api/colleges/detail {unitid}`, `/api/highschools {state, q}`.
Settings: `URBAN_BASE` (override the API base), `DIRECTORY_YEARS` (default `2023,2022,2021`, tried newest first).

### What students say online

`POST /api/reviews {name}` runs three web searches (needs `SEARCH_PROVIDER` + `SEARCH_API_KEY`, Tavily or Brave free tiers),
then, if AI is configured, groups the snippets into cited themes. Every theme links its sources; usernames are not shown;
results are labelled as anecdotes and cached for 7 days. AdmitIQ uses search APIs and never scrapes review sites.

## External services (all optional) and what they cost

| Service | Enables | Cost |
|---|---|---|
| *(none)* | Everything except open-ended AI answers, AI essay deep read, live research and sync | Free |
| **College Scorecard API** | Live official lookups, `sync:scorecard` verified data | Free key (api.data.gov), rate-limited |
| **Groq** (`AI_PROVIDER=groq`) — *recommended free option* | AI strategist + essay deep read | Free tier with rate limits; Groq states it doesn't train on your data |
| **Ollama** (`AI_PROVIDER=ollama`) | Same, fully local and private | Free (your hardware) |
| **Google Gemini / OpenRouter free models** | Same, hosted | Free tiers with rate limits. ⚠ Gemini's free tier lists prompts as used to improve Google's products — think twice before sending student essays |
| **OpenAI / Anthropic** | Same, hosted | Paid, usage-based |
| **Tavily / Brave Search** | Web search in the Research center | Own pricing/free allowance — check current terms |
| **Supabase** | Accounts, cross-device sync, moderated community data | Free tier (projects may pause when inactive — check current limits) |

AdmitIQ never claims a paid feature is free; the in-app Settings page shows what's enabled.

### AI provider setup

```env
AI_PROVIDER=ollama            # or groq | gemini | openrouter | openai | anthropic | openai-compatible
AI_API_KEY=                   # not needed for ollama
AI_MODEL=                     # optional; leave blank and the server picks an available model automatically
AI_BASE_URL=                  # required only for openai-compatible
```

If the default model is retired, the server asks the provider's model list and switches to the best available one (logged to the console). It also retries without JSON mode for models that don't support it, and strips `<think>` reasoning traces. Keys live only on the server; the browser calls `/api/ai`. **Settings → Services → Test connection** checks the AI from inside the app. Set `REQUIRE_AUTH=true` on public deployments so only signed-in users can spend your AI quota. Essays are sent to the provider only when the student clicks *AI deep read*, and are never used for training by AdmitIQ (check your provider's data policy).

### Supabase setup (accounts + sync)

1. Create a project at supabase.com (free tier).
2. SQL editor → run `supabase/migrations/0001_init.sql`, then `supabase/seed.sql`.
   (Or with the Supabase CLI: `supabase db push` then `psql "$DB_URL" -f supabase/seed.sql`.)
3. Authentication → enable Email provider; set your site URL for magic links.
4. Put `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env`. **Never** use the service-role key in this app.
5. To moderate community submissions: `update student_experience_submissions set approved = true where id = '…';`

Security model: RLS on every student table (`user_id = auth.uid()`), public read-only reference tables, an anonymous experience table with **no user column**, insert-only with consent and no self-approval, and `SECURITY INVOKER` RPCs (`sync_state`, `load_state`, `delete_my_data`) so RLS applies to every write.

---

## Deploy

**A. Static, free (local mode — no server features)**
`npm run build`, then upload `dist/` to Cloudflare Pages, Netlify, GitHub Pages or Vercel (static). The app detects there's no server and stays in local mode — no failed requests.

**B. Full app, free or low-cost**
- **Render**: push the repo and use `render.yaml` (free web service; it sleeps when idle). Add secrets in the dashboard.
- **Docker** anywhere (Fly.io, Railway, Koyeb, a VPS): `docker build -t admitiq . && docker run -p 8787:8787 --env-file .env admitiq`.
- Put it behind HTTPS and set `TRUST_PROXY=true` when behind a proxy.

The server sets a strict CSP, `X-Frame-Options: DENY`, `nosniff`, a referrer policy and a permissions policy; validates and size-limits request bodies; rate-limits API calls per IP; and blocks path traversal.

---

## Testing performed

- Headless Chromium (Playwright) visited all 28 routes at 1366×900 and 390×844 with demo data: **0 runtime errors**, no horizontal overflow.
- 17 end-to-end flows: onboarding from scratch (with validation errors), transcript, autocomplete, filters, compare + CSV export, essay grammar edits + drafts + diff, tracker apps/tasks/calendar/timeline, cost scenarios, strategist, offline research, community consent + PII scrub, export/import round-trip, invalid import rejection, dark mode.
- AI paths (essay deep read, strategist AI mode) through the server against a mock OpenAI-compatible provider.
- Server: health, marker injection, security headers, error handling, JSON validation, method checks, path traversal, rate limiting (429).
- Auth & sync end to end in the browser against a mock Supabase backed by the real schema: sign-up pushes local data, edits auto-sync, a second device pulls, wrong password, forgot password, recovery link → reset page → update, magic link, expired-link error, delete account (auth row + cascade).
- Setup wizard (interactive and piped input) against a mock Ollama.
- Voice (simulated Web Speech API in headless Chromium): voice compare, spoken glossary answers, typed palette commands, strategist voice question + spoken answer, assistant handing questions to an open strategist, essay dictation + read-aloud, and a full 3-question voice interview with scoring; command parser unit-tested on 22 phrasings. Server `/api/transcribe` tested against a mock Whisper endpoint (multipart format, content-type and 10 MB limits).
- What-if simulator, aid-offer math (checked by hand), weekly plan, glossary popovers; animation regressions (tab indicator after resize, chart tooltip placement, portals for fixed layers).
- Modal focus: typing in activity/task forms keeps focus (regression test for a bug that sent focus back to the first field on every keystroke).
- Database on Postgres 16 with a mocked Supabase `auth` schema: migration + seed + idempotent re-run; full demo state `sync_state` → `load_state` round-trip (all collections, ordering, essay text) passing the client's Zod import schema; cross-user read/write blocked by RLS; anon denied on private tables and RPCs; consent/moderation enforced; `delete_my_data` removes everything.
- Scorecard sync against a mock API → fields render as Verified with date and URL.
- Logic layer (`src/lib`, `src/data`) type-checks under `strict`.

---

## Known limitations

- **Not Next.js / shadcn / Recharts / Framer Motion.** It was built in an environment with no package registry access, so it uses the preinstalled React 19, TypeScript, Tailwind v4, Zod and esbuild, with hand-built UI components, SVG charts and CSS animations. The `lib/` layer is framework-agnostic and ports directly to Next.js App Router (pages → `app/*/page.tsx`, server routes → `app/api/*/route.ts`).
- **React components weren't type-checked here** (`@types/react` wasn't available offline); they were bundled and exercised in a real browser. Run `npm install && npm run typecheck` to check them.
- **Bundled college data is mostly unverified** and covers 38 institutions. Harvard (admit, completion, net price) and Purdue (admit, completion) carry exact official values fetched 2026-11-23; Duke and Vanderbilt were refreshed from official records and show tuition ~8–10% above the bundled recall, so other schools' tuition is probably slightly low. A free api.data.gov key + `npm run sync:scorecard` verifies all 34 US schools at once. Round-specific (ED/EA/RD) rates, net price by income, class-rank distributions, application volume, yield, safety and diversity statistics are shown as *Unavailable*. Use `sync:scorecard` and extend `colleges.ts` for more schools.
- Admissions categories and fit scores are transparent heuristics, not predictive models. Essay scores are text-pattern proxies; only humans (or the optional AI read) assess meaning.
- Scholarship list is curated (16 programs); deadlines are shown as typical cycles, not dates.
- Reminders are in-app alerts plus `.ics` export — no email/push notifications.
- Auth and sync were tested end to end against a mock Supabase (auth endpoints + REST RPCs executing in real Postgres 16 under RLS), not yet against a hosted Supabase project.
- The live AI path was tested against mock OpenAI-compatible providers (including model retirement and no-JSON-mode cases), not yet against a real Groq/Gemini key.
- Live research needs a Scorecard key and/or a search API key; without them, the Research center answers from stored data and says so.
- Voice input needs a browser with speech recognition (Chrome, Edge, Safari) **or** the AdmitIQ server with Groq/OpenAI for Whisper transcription. The published claude.ai preview blocks microphones entirely, so voice input only works when you run or deploy AdmitIQ yourself (read-aloud may still work there). Real microphones and voices were not available in testing; the speech APIs were simulated.
- In sandboxed previews (e.g. an embedded artifact viewer), file downloads are blocked — exports fall back to copying to the clipboard.

---

## Privacy commitments

No public student profiles · no selling of data · essays never used to train models · financial data excluded from AI unless the student opts in · no sensitive characteristics collected or inferred · RLS on all synced data · anonymous, consented, moderated community submissions · export or delete everything at any time.

AdmitIQ is not affiliated with any college, the Common App, or the U.S. Department of Education.
