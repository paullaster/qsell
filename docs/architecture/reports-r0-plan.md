# R-0 plan: the reports foundation

**Status:** PLAN for approval, 2026-11-22. Nothing is built. Slice R-0 of [`reports-module.md`](reports-module.md) section 12. Scorecard acceptance per [`reports-benchmark.md`](reports-benchmark.md).
**Rule for this slice:** *no number changes.* Every existing report returns exactly what it returns today; R-0 gives them one door, one frame, one permission and audit model, one export path and one design system, and puts the Reports module in the sidebar. New analysis starts in R-1 and later.

## 1. What R-0 delivers

1. The **measure catalogue** (one definition per number, with the document-state rule and a version).
2. The **report registry** (every report described in code: question, family, permissions, measures, tier, tie-out declaration, documentation link) with a test that fails the build when an entry is incomplete.
3. The **query door** `ReportRunner.run`: permission, scope, period and comparison, cache, as-of metadata, audit, truncation. Existing reports run through it by **adapter**.
4. The **export service**: CSV, XLSX and PDF from one place, formula-injection safe, audited, row-capped.
5. The **premium report design system**: page frame, filter bar, hero strip, data table, chart kit, states, number and date formatting, message catalogue (English only, translation-ready), style guide page.
6. The **Reports module** in the sidebar: hub listing every registered report the person may open, search, favourites, and the Ctrl/Cmd+K command palette.
7. **Documentation:** implementor guide chapter, platform SEO entry, docs of the registry.

Out of scope for R-0 (and where it goes): rollup tables and tie-outs (R-1), new analysis reports (R-2 onward), budgets and targets (R-4), saved views and builder (R-6), schedules, alerts and API (R-7), HR (R-9).

## 2. What exists and is reused (verified in the code)

| Reused | Where | How |
|---|---|---|
| Period and comparison maths, business time zone | `domains/reports/period.ts` (317 lines, tested) | Moved behind the engine unchanged; its tests stay as they are |
| Section permissions, branch scope, cache keyed by permission set, in-flight de-duplication | `domains/reports/service.ts` | Generalised into the runner; `ReportsService.getBusinessOverview` becomes a thin caller so its tests keep passing |
| Headline sentences | `domains/reports/headline.ts` | Becomes the first "findings" template set, reading measure definitions |
| Overview queries | `domains/reports/queries.ts` | Untouched in R-0 (rollups arrive in R-1) |
| Overview screen and a hand-built SVG trend chart | `components/admin/overview/*` (1,304 lines) | Its parts (`Kpi`, `Card`, `Delta`, `TrendChart`, `format.ts`) are promoted into the kit; the screen is rebuilt from kit parts with identical content |
| CSV read and write (RFC 4180) | `lib/csv.ts` | Export writes through it; adds one shared cell-neutraliser (refund files already neutralise `= + - @`; the rule moves to one place) |
| PDF generation | `adapters/pdf` (pdfkit), `lib/downloadPdf.ts` | Export PDF reuses the adapter; no new dependency |
| XLSX reading with size and zip-bomb guards | bank statement import | The writer is new (no spreadsheet library is installed): a small in-house writer, tested by reading its own output back through that reader |
| Tokens, dark mode, company colours | `app/globals.css`, `components/ui/screen-kit.tsx` | The kit uses tokens only; adds a **data palette** (categorical, sequential, diverging) as tokens |
| Paged lists, pickers, modals, toasts | `usePagedList`, `ChoicePicker`, `Modal`, `Toast` | Filter bar and drill drawer use them; no `<select>` anywhere |
| Existing report screens | finance trial balance and ageing, payables ageing (*What we owe*), delivery report, vendor reports, pricing insights, customer analytics | Registered by adapter (section 4.3) |
| Permissions | `report_sales:read`, `report_collections:read`, `report_profit:read`, `report_receivables:read`, `report_inventory:read`, `reports:all_branches`, `trial_balance:read`, `receivables_ageing:read`, `vendor_reports:read`, delivery read keys | Kept as they are; the registry names the existing key each report requires |

Two corrections found while reading: the Business Overview page `await`s the whole report before drawing (`app/admin/page.tsx`), which breaks project rule 5; R-0 awaits only the permission decision and streams the data. **Customer Analytics** (`analytics/service.ts`) is static and neither period- nor branch-aware; R-0 registers it as *legacy, to be replaced in R-5* and does not pretend otherwise.

## 3. Work packages

Sizes: S under a day, M one to three days, L three to five days of focused work. Order is the dependency order.

### WP1. Measure catalogue and message catalogue (M)

Files (new):
- `src/server/domains/reports/catalogue/measures.ts`: `MeasureDefinition { code, labelId, meaningId, formula, unit ('money'|'count'|'percent'|'days'|'ratio'), additive, aggregation, source, countedStates, excludedStates, version }`; the measures the overview uses today (`sales.net`, `sales.orders`, `sales.average_order`, `sales.tax`, `sales.cost_covered_share`, `collections.collected`, `collections.rate`, `profit.gross`, `profit.margin`, `receivables.outstanding`, `receivables.overdue`, `inventory.stock_value_at_cost` and so on), each stating which order, payment and document states count (the rule the overview already applies in `orderFlow`, written down).
- `.../catalogue/dimensions.ts`: dimension codes (date, branch, channel, sales type, customer, group, product, category, brand, vendor, salesperson, payment method, zone, rider) with labelIds, and the valid measure by dimension pairs (initially those the overview needs).
- `.../catalogue/measures.test.ts`: every measure has label, meaning, formula, version; additive measures declare their aggregation; no duplicate codes; every counted and excluded state is a real status value from `src/lib/order-stages.ts`.
- `src/lib/reports/messages/en.ts` and `src/lib/reports/messages.ts`: `t(id, slots)` with typed ids; whole-sentence templates with named slots (no string building in code); a test fails on a used id with no entry and on a slot missing at the call.
- `src/lib/reports/format.ts` (moved from `components/admin/overview/format.ts`, re-exported there): money, compact money, count, percent, delta, local date, range, instant, all through `Intl` with the company locale and the business time zone passed in (default `en-KE`, `Africa/Nairobi` from the company row), never the browser. Tabular rules (negatives, variance sign and arrow) live here. Existing `format` tests carry over.

Definitions version: `OVERVIEW_DEFINITIONS_VERSION` becomes the catalogue version (`catalogueVersion()`); the overview's `meta.definitionsVersion` keeps its field name and now holds it, so no consumer changes.

### WP2. Report registry (M)

Files (new):
- `.../registry/definition.ts`: `ReportDefinition { code, titleId, questionId, family, permissions (all required), anyOfPermissions?, measures[], dimensions[], tier ('live'|'rollup'|'snapshot'), scope ('company'|'branch'|'both'), params (typed reader), tieOut ({ kind: 'none', reason } | { kind: 'gl'|'subledger', control }), sensitivity ('normal'|'cost'|'personal'|'bank'|'pay'), exportFormats, maxRows, timeoutMs, keywords[], docsAnchor, href? (legacy), view ('table'|'overview'|'legacy') }`.
- `.../registry/index.ts`: `REPORTS` list and lookup; `visibleReports(allowedPermissions)`.
- `.../registry/families.ts`: the families in `reports-module.md` section 6 (executive, sales, pos, inventory, finance, tax, customers, vendors, delivery, projects, people, operations).
- `.../registry/registry.test.ts`: fails when an entry has no permission, no question, no measure definition (or an unknown measure code), no tie-out declaration (an explicit `none` with a reason is allowed), no documentation anchor in `docs/implementor-guide/15-…`, duplicate code, or a sensitivity of `cost` without `report_profit:read` among its permissions (cost cannot leak through a registry entry).

### WP3. The runner (L)

Files (new unless noted):
- `.../engine/run.ts`: `ReportRunner.run(code, rawParams, actor)`: load definition, check permissions (refuse before any read), resolve period via `resolvePeriod` and scope via the moved `resolveScope`, build the cache key from (code, validated params, scope, sorted permission set, catalogue version), serve from cache or share an in-flight read, call the report's `execute`, attach `meta` (as of, scope, period, compare, tier, definitions version, tie-out result placeholder `not_declared` in R-0, truncated flag), enforce `maxRows` and `timeoutMs`, write an audit row when the definition's sensitivity or an export requires it.
- `.../engine/scope.ts`, `.../engine/cache.ts` (moved from `service.ts`; same 15 s TTL and 200 entry cap; bounded; tested for permission-set isolation), `.../engine/params.ts` (typed readers: uuid, local date, preset, compare, bounded string; anything else dropped, never trusted).
- `.../service.ts` (edited): `getBusinessOverview` now builds its sections as before but is called through the runner's cache and scope; behaviour and output identical (golden test below).
- `.../actions.ts` (edited): adds `runReportAction(code, params)` (one permission check by the registry, params cleaned by the definition's reader, result as data `{ ok, data } | { ok:false, error }` per project rule 3) and `listReportsAction()`; `getBusinessOverviewAction` stays.

Golden guarantee: the existing `overview.integration.test.ts` (453 lines) runs unchanged and must pass; a new `engine.integration.test.ts` runs the overview through `run()` and asserts deep equality with the direct service result for several periods, scopes and permission sets.

### WP4. Adapters for existing reports (M)

`.../registry/legacy.ts` registers, with `view: 'legacy'` and their current `href`, the reports that exist today so the hub, permissions, search and documentation cover them: Business Overview (`overview`), Trial balance, GL entries and registers, Customer statement, Receivables ageing, Wallet liability, Refund report, Bank account movements, What we owe (payables ageing), Vendor statement, Advances outstanding, Payables reconciliation, Vendor reports, Vendor scorecard, Delivery report, Delivery performance, Late deliveries, Pricing Insights, Price book, Order flow and late orders, Customer Analytics (flagged legacy), X and Z shift reports. Each carries its **existing permission key**, a plain-language question, and its measure codes where they exist (otherwise `measures: []` with `catalogue: 'pending'`, allowed only for `view: 'legacy'` entries and listed by a test as technical debt that must reach zero by R-5). **Their internals are not touched.** Three run through the runner in R-0 so the door is proven end to end: Business Overview, Receivables ageing and Payables ageing (the ones already read by both screens and tests). The others keep calling their own services until the slice that rebuilds them.

### WP5. Export service and audit (L)

Migration `drizzle/0208_report_audit.sql` (generated with `pnpm db:generate --name report_audit`, hand-reviewed): table `report_audit` (`id bigint generated always as identity`, `company_id`, `user_id`, `report_code`, `action` ('run'|'export'), `params jsonb` (typed parameters only, no personal data), `format`, `row_count`, `truncated`, `content_hash`, `definitions_version`, `correlation_id`, `occurred_at default now()`), append-only trigger (no update, no delete) as the decision log, indexes `(company_id, occurred_at)` and `(company_id, report_code, occurred_at)`. Schema edit in `schema.ts` with the migration, snapshot and journal committed together; no `db:push`.

Files (new):
- `.../export/sanitize.ts` (neutralise cells starting `= + - @ tab CR`, one function, used by CSV, XLSX and PDF; the refund-file code calls it instead of its own copy; tests with the injection strings).
- `.../export/csv.ts` (over `lib/csv.ts`, UTF-8 with BOM, CRLF, footer rows for report name, as-of, scope, definitions version), `.../export/xlsx.ts` (minimal writer: one worksheet per table, shared strings, number and date styles, frozen header row, column widths, a Details sheet with the footer facts; no library), `.../export/pdf.ts` (table layout through the PDF adapter, company header from document layouts, page numbers, as-of and definitions in the footer).
- `.../export/export-service.ts`: `exportReport(actor, code, params, format)`: needs `reports:export` **and** the report's own permissions; runs the report with `maxRows` capped by an export limit; above the limit refuses in words in R-0 (the async job path arrives in R-7 with schedules) and says to narrow the range; writes the audit row with the content hash; returns the file as a private, signed, expiring download (the existing refund-file route pattern).
- `.../audit/report-audit-service.ts` and a small **Report activity** list for people holding `reports:view_audit` (who ran or exported what), paged by keyset.
- New permission keys (added to `permissions.ts`, seeded to the Admin role on new installs; existing roles are given them in Admin → Roles, as is the project's practice): `reports:read` (opens the Reports hub; registry entries still need their own keys), `reports:export`, `reports:view_audit`.

### WP6. Design system and chart kit (L)

Everything in `src/components/reports/kit/`, tokens only, server-renderable where it has no interaction, each with a unit or component test and a story on the style guide page.

| Component | Notes |
|---|---|
| `ReportFrame` | Title and the **question** it answers, as-of and scope strip, filter bar slot, compare control, hero strip slot, panels, footnote with definitions and version. One frame for every report. |
| `FilterBar` | Period presets and custom range, compare mode, branch (`ChoicePicker`, never `<select>`), state in the address (as the storefront does), instant control feedback and *updating* dimming of the old figure until the answer for the new parameters arrives |
| `HeroStrip`, `Kpi`, `Delta` | Large tabular figures, comparison with arrow, sign and colour, plain-language sentence under it; promoted from `overview/parts.tsx` |
| `Panel`, `PanelSkeleton`, `EmptyPanel`, `FailedPanel` | Skeletons the same shape as the final content (no layout shift); empty and failed states that say why and offer the next step; independent retry |
| `DataTable` | Sticky header and first column, sort, group with subtotals, column chooser, density, data bars and inline sparklines, conditional formats, virtualised rows for long lists, **keyboard drill on every line** (Enter opens the next level, a key shows detail), copy, export menu; phones show cards, with a "table" scroll box that scrolls only inside itself |
| `DrillDrawer` | Next level or the source document, focus-managed, Escape closes |
| Charts (pure geometry in `src/lib/reports/chart/{scale,ticks,paths,palette}.ts`, SVG components on top) | **LineArea** (with comparison overlay; promoted from `TrendChart.tsx`), **Bars** (grouped and stacked), **RankedBars** (with picture or initials tile), **Sparkline**, **Donut** (few slices), **Bullet** (actual against target, for R-4). Waterfall, funnel, heat map, treemap and map arrive with the slice that needs them. Each has a text alternative: an `aria` summary sentence and the data table beneath; keyboard path through points; reduced-motion respected; crisp in print; usable at 390 px (simplified marks, tap to inspect). |
| `DataPalette` tokens in `app/globals.css` | Categorical (8), sequential and diverging ramps, light and dark, checked by a script for contrast against surfaces and for colour-vision-deficiency separation; a series keeps its colour across charts (stable hue from the entity id, as the till does for product tiles) |
| `CommandPalette` | Ctrl/Cmd+K: search over registry titles, questions and keywords the person may open; recent and favourites; reusable later for the whole admin |
| Style guide page | `/admin/reports/style-guide` (needs `reports:read`): every component with real seeded data, the palette, the number formats |

The Business Overview screen is rebuilt from these parts with the **same content**; its `OverviewFrame` and `parts.tsx` are retired (their tests ported). The page passes the data promise into `Suspense` and awaits only the permission check.

### WP7. The Reports module and hub (M)

- `config/admin-nav/nav.config.ts`: new top-level **Reports** group (icon `BarChart3`, permission `reports:read`) with sub-links **All reports** (`/admin/reports`), **Report activity** (`reports:view_audit`) and, once they exist, Budgets and Targets (R-4). **Business Overview stays at `/admin`** as the landing screen and is also listed in the hub.
- `app/admin/reports/page.tsx` (server component, hub), `app/admin/reports/[code]/page.tsx` (generic runner for registry reports with `view: 'table'`; legacy entries link to their own screen; unknown code or a report the person may not open answers through `MissingAs404`), `app/admin/reports/activity/page.tsx`, `app/admin/reports/style-guide/page.tsx`. All load the list and the permission together, stream the rest.
- Hub: grouped by family, each card shows the **question** the report answers, who it is for, and a data-freshness chip; search; favourites (per user, stored in the existing user preference mechanism if one exists, else a small `report_favourites` table in the same migration, to be confirmed in WP7 after checking user preferences); recently opened.
- `config/seo/platform-modules.ts`: entry for the Reports module and its sub-modules in everyday words (a test already enforces it).

### WP8. Documentation (S)

- `docs/implementor-guide/15-reports-and-analytics.md` in the 8-part anatomy (value and talk track, prerequisites, architecture, screens, field reference, user actions, rules, go-live checklist) covering the hub, the registry, permissions and exports, how to read an as-of strip and a definitions version, and each registered report's question and permission; README table row; `scripts/build-docs.ts` picks it up. The registry test checks every `docsAnchor` resolves to a heading in this file.
- This plan and `reports-module.md` get an "as built" note at the end of the slice.

### WP9. Tests and verification (M, runs through every package)

| Level | Content |
|---|---|
| **Unit** | measure and registry validity, message catalogue completeness, `format` (money, compact, percent, delta, dates in zones), chart scales, ticks and path builders (including empty, one point, negative and huge values), palette contrast and CVD script, sanitiser with injection strings, CSV and XLSX writers (XLSX round-trips through the existing reader), params readers rejecting junk, cache isolation by permission set |
| **Integration** (database from migrations) | golden: overview through `run()` equals the direct result for several periods, scopes, permission sets; permission refusal happens before any query (spy on the database); branch scope for a branch-pinned user; export writes one audit row with the hash; audit table refuses update and delete; export over the row cap refuses in words; a report whose definition lists `report_profit:read` is unavailable to a user without it, and the response contains no cost or margin key |
| **API / actions** | tampered params (bad uuid, huge range, unknown code, injection in strings) are dropped or refused as data; masked errors; download route refuses another user's file and an expired link |
| **E2E** (Playwright, desktop and phone) | hub lists only what a limited user may open; search and Ctrl/Cmd+K open a report; Business Overview shows the same headline and figures as before the change (read from the seed); filters live in the address and survive reload; export CSV opens with BOM and neutralised cells; keyboard drill; dark mode; `noHorizontalScroll`, `noInnerHorizontalScroll` (table scrolls only in its own box), `noNativeSelect` |
| **Visual** | Playwright screenshots of the style guide page and the overview at 390, 768 and 1440 px, light and dark, from the seeded data, kept as baselines |
| **Quality** | `pnpm typecheck`, `pnpm lint` (ESLint 10.12 rules: strict-boolean-expressions, no nested ternary, `has`/`orElse` helpers), Prettier on exact files only; accessibility checks in the e2e for dialogs, tabs and focus |
| **Scorecard** | The L and K questions (experience and platform trust) answered for what R-0 ships, recorded in the as-built note |

## 4. Design decisions in this plan

1. **Adapter first, rewrite later.** Existing reports keep their services and tests. Putting them behind the registry gives one door, one hub and one permission and audit model immediately, with no risk to numbers. Their internals move onto rollups in R-1 and later, one at a time, each with a golden test.
2. **Registry in code, not a table.** Reports are code-reviewed, typed and tested; only saved views and user-built reports (R-6) are data. This matches how lookup sources and platform modules are done here.
3. **One export path.** All exports go through one service that audits and sanitises; a screen that builds its own CSV is a defect after R-0 (a test greps for new `text/csv` responses outside the service, as the stage-writer test does).
4. **XLSX without a dependency.** A small tested writer keeps the pinned stack unchanged and avoids a heavy library; accountants live in Excel, so it ships in R-0.
5. **No new infrastructure.** Everything is the app, the one database and the existing worker; the only schema change is the audit table (and, if user preferences are not available, a favourites table).
6. **Streaming everywhere.** The runner returns data promises; pages await only the permission decision, per project rule 5.

## 5. Risks and how they are handled

| Risk | Handling |
|---|---|
| Moving the overview onto the kit changes a figure or a sentence | The golden tests compare the runner against the old service; the e2e reads the seeded headline; the rebuilt screen is compared against screenshots of the old one before the old components are deleted |
| The registry becomes a dumping ground of half-described legacy reports | The `catalogue: 'pending'` allowance is explicit, listed by a test, and capped; it must reach zero by R-5 |
| Chart kit scope creep | R-0 ships only the six chart types the overview, the table views and R-1 need; each later chart arrives with the slice that uses it |
| Palette fails in dark mode or for colour-vision deficiency | A script checks contrast and separation in CI; the style guide shows both schemes |
| XLSX writer produces a file Excel repairs | Tested by round trip through the bank-statement reader and opened in a real spreadsheet during review (manual check recorded in the as-built note); strict use of the minimal valid structure |
| Export of large data hurts the primary | Row cap in R-0 with a plain refusal; the async job path is R-7 |
| Permission leakage through cache or export | Cache key includes the sorted permission set (tested); export re-runs the report under the exporter's permissions and refuses cost data without the cost permission |

## 6. Definition of done for R-0

- All nine work packages merged, the migration applied from scratch to a fresh database, `pnpm test`, e2e (desktop and phone), typecheck and lint green.
- Every existing report appears in the hub with its question and permission; three run through the runner; no figure differs from before (golden tests).
- The registry, catalogue and message tests are in CI and fail on an incomplete entry.
- The implementor guide chapter and the platform SEO entry are in, and the as-built note records what differs from this plan, what was verified, and what was not.

## 7. Assumptions to correct before the build starts

1. **Business Overview stays at `/admin`** as the landing screen, also listed in the Reports hub (recommended), rather than moving under Reports.
2. **R-0 registers legacy reports by adapter** and runs only three through the runner (recommended), rather than rewriting all of them now.
3. **The new keys** are `reports:read`, `reports:export` and `reports:view_audit`; existing report keys keep their meaning and no role gains access it did not have, except the Admin role on new installs.
4. **Favourites** use the existing user preference mechanism if there is one; otherwise one small table in migration 0208 (checked in WP7).
5. **Customer Analytics** is registered as legacy and not rebuilt here.

## 8. As built (R-0)

What was delivered, and where it differs from the plan above.

**Delivered.** Message catalogue and locale formatting (WP1); measure catalogue with 19 measures (WP1); report registry with 20 legacy reports adapted and the Business Overview built in (WP2); `ReportRunner` as the single door with permission-before-read, scope, cache keyed by permission set, as-of metadata, timeout and optional audit (WP3); three executors (overview, receivables ageing, payables ageing) with a golden test proving the runner returns what the overview service returned before (WP3, WP4); export to CSV, Excel and PDF with formula neutralisation, SHA-256 fingerprint and an append-only audit table, migration 0208 (WP5); design tokens for data colours, an in-house SVG chart kit, the report kit (hero, panel, frame, filter bar, table, palette, export buttons), the Reports page, report activity page, style guide and the rebuilt Business Overview (WP6, WP7); implementor guide chapter 15 and the platform SEO entry (WP8).

**Differences from the plan.**
1. **Adapter first.** Legacy reports are registered with their real permissions and links and are not rewritten; 17 of the 20 are marked `catalogue: 'pending'` until they are moved onto catalogue measures.
2. **Direct download, not signed links.** The export route checks the session and permissions on each request and makes the file on the spot; nothing is stored, so there is no link to expire or leak.
3. **Favourites in the browser.** Stars are kept in local storage, not in the database (no migration needed beyond 0208). They do not follow a person between devices. Moving them to the server is a small later change.
4. **Charts take data, not functions.** Chart components receive a `unit` description rather than formatting functions, because functions cannot cross from server to client components.
5. **Page titles are level-2 headings.** The admin shell owns the single level-1 heading.
6. **Native selects removed from the overview filters.** The period comparison uses a segmented choice and the branch uses the shared picker (lookup source `report-branches`, behind `reports:all_branches`).

**Verified.** Unit and component tests for the catalogue, registry, runner, export, chart maths, palette contrast and colour-blind separation, kit and hub; integration tests (fresh database built from the migrations) for the runner golden test, the audit service and lookup sources; ESLint and `tsc` clean on every new file (the only `tsc` error is a Sentry type conflict that predates this work). The Playwright spec `e2e/reports.spec.ts` covers the Reports page, palette, style guide, downloads in three formats, the audit page, the unauthenticated refusal and the overview filters.

**E2E result.** `e2e/reports.spec.ts` passes in full on the desktop and phone projects (12 of 12) against a fresh database. It was run with a local wrapper because the repo's Playwright setup spawns `pnpm` and `exec`, which do not work on Windows; the repo files were not changed for it.

**Not verified / left.** Screenshot baselines (none exist yet), dark mode checked by eye in a browser, and the whole existing e2e suite (only the new spec was run). Lint errors that already existed in `period.ts`, `headline.ts`, `service.ts` (two sort comparators), `company-ui` and the overview integration test were not changed. The ten reports that sell the platform to first clients (decision 6 in `reports-module.md`) are still open. Rollups, snapshots, the builder, schedules, budgets, targets, the tax suite and HR reports are later slices.
