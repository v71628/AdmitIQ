# Data sources

Every record AdmitIQ stores comes from a named public dataset or an official page, and keeps its origin: dataset, year and record key. Missing values stay missing (IPEDS codes -1, -2 and -3 are never turned into zeros). Nothing is generated to make up a count.

## Counts measured from the live sources (dry run, 24 Nov 2026)

The pipeline's own transform code (`scripts/ingest/transform.mjs`) was run in a browser against the live sources. **These are counts of what the pipeline produces. They are not counts of what is in your database.** Your database is filled when you run `npm run ingest` with your Supabase keys (see SETUP.md). After that, the admin dashboard and `source_library_stats()` report the real stored numbers.

| What | Source | Year used | Records |
|---|---|---|---|
| Institutions | IPEDS Directory (Urban Institute Education Data Portal) | 2023 ¹ | **6,163** (6,059 active · 4,096 active degree-granting · 101 HBCUs · 35 tribal colleges · 59 states and territories) |
| **Unique source URLs from the directory** | Official pages each institution reports to IPEDS (website, admissions application, financial aid, net price calculator, veterans, athletics, disability services), plus NCES College Navigator pages for every active institution and College Scorecard pages for every active Title IV institution, after de-duplication (8,569 duplicates removed; branch campuses often share a URL) | 2023 | **37,001** |
| ↳ by category | net price & College Scorecard (affordability) 10,464 · College Navigator (admissions statistics) 6,058 · official websites 5,325 · financial aid 3,868 · disability services 3,811 · admissions 3,473 · veterans 2,748 · athletics 1,254 | | |
| Occupation profiles | BLS Occupational Outlook Handbook XML (May 2025 pay; 2025–2035 projections; updated 29 Oct 2026) | 2025 | **343** careers + 343 source pages |
| Majors | NCES Classification of Instructional Programs 2020 | 2020 | **2,028** six-digit programs in 50 families |
| Dataset-level sources | one record per IPEDS dataset and year used, plus the CIP and OOH index pages | | 11 |
| **Total source records** | | | **≈ 37,355**, all tier 1 (official or government) |

¹ The 2024 directory on the Urban portal was only partly loaded when this was checked (5,438 of 6,072 rows had no institution name). The pipeline skips any year where fewer than 90% of rows have a name, and uses 2024 automatically once it's complete.

### Statistics (stored in `college_statistics`, each value citing its dataset source)

| Dataset | Year | Values |
|---|---|---|
| Admissions & enrollment (applicants, admits, admit rate, yield) | 2024 | 9,673 |
| Admissions requirements & test scores (SAT/ACT 25/50/75th percentiles, % submitting, test policy, open admission) | 2022 ² | 6,411 |
| Tuition & required fees (in-district, in-state, out-of-state; full-time undergraduates) | 2023 | 10,611 |
| Room & board, books, other expenses (on campus) | 2023 | 7,254 |
| Full-time retention rate | 2024 | 4,947 |
| Student-to-faculty ratio | 2024 | 5,577 |
| Fall undergraduate enrollment (total, full-time) | 2024 | 11,092 |
| Graduation rate within 150% of normal time | 2023 | 2,243 |
| Average net price (full-time first-time students receiving grant aid) | 2021 ³ | 5,321 |
| **Total** | | **≈ 63,100 values** |

² 2022 is the newest admissions-requirements year on the portal. Only 384 institutions reported SAT percentiles that year, which reflects how widespread test-optional policies were, not a pipeline gap.
³ 2021 is the newest net-price year on the portal. The College Scorecard key (`SCORECARD_API_KEY`) provides newer values on demand, and any disagreement between the two goes into `data_conflicts` rather than being silently resolved.

## Verification states

Ingested sources start as **`listed`**: the URL is in official federal data but hasn't been visited yet. `npm run sources:verify` then link-checks them politely (robots.txt respected, at most one request per second per host):

- `link_ok` / `link_redirected`: the page loaded.
- `link_broken`: HTTP 404/410, or the site couldn't be reached.
- HTTP 401, 403, 429 or 5xx: left as `listed` with the status recorded, because a site blocking bots doesn't make the page wrong.
- `content_extracted`: page text stored and chunked (`--extract`), then embedded for semantic search (`--embed`).

Each record gets a `stale_after` date (180 days for admissions and cost pages, 365 days for others). The `sources_freshness` view labels records fresh, aging, stale, unchecked or broken.

**The admin dashboard reports "verified" as only those records whose link was actually checked or whose content was extracted.** Listed records are counted separately.

## Reliability tiers

1. Official government or institutional primary sources: IPEDS, College Scorecard, BLS, NCES, the institutions' own pages. **All current records are tier 1.**
2. Peer-reviewed research and established research organizations.
3. Reputable educational research and publications.
4. Secondary reporting and anything else.

Tiers 2–4 have no bulk collection yet. They're meant to be added deliberately (for example published research or rankings methodology pages), never scraped in bulk.

## Licenses and attribution

- **IPEDS**: U.S. Department of Education, National Center for Education Statistics. Public domain. Distributed by the Urban Institute Education Data Portal under ODC-By; attribution is shown in the app and stored in `sources.citation`.
- **BLS Occupational Outlook Handbook**: U.S. Bureau of Labor Statistics. Public domain. Each profile links to its OOH page.
- **CIP 2020**: NCES. Public domain.
- **Institution pages**: linked and cited, never republished. Extracted text is used only for retrieval and quoting short passages with links.

## Not yet ingested (planned)

- Common Data Set PDFs: institution-specific, no central index. Planned as an assisted per-college import with page citations.
- Application deadlines and Early Decision/Early Action dates: not in any federal dataset. These need official admissions pages plus Gemini grounded research, with every date stored as `unverified` until a page confirms it.
- Rankings: methodology pages only, with source and year, and never presented as data quality.
- International institutions: there is no IPEDS equivalent. Planned sources include the UK HESA/UCAS open data and Canada's official university directories. The app's existing hand-curated Canada and UK rows remain.
- The CIP–SOC crosswalk (major → career links): the NCES file is distributed as .xlsx. The pipeline will accept a CSV export of it (`--cip-soc-file`, planned).
