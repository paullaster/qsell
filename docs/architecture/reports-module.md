# Reports module: design draft

**Status:** DRAFT for correction, 2026-11-22, revised the same day after the owner's answers (section 14; new sections 15 to 20). Nothing here is built. It is the contract for the slices in section 12.
**Owner:** a new top-level sidebar module, **Reports**. Every other module (Sales, Products & Inventory, Finance, Customers, Vendor Management, Delivery, Projects, and later HR) feeds it and keeps owning its own data.
**Reads with:** [`sales-order-blueprint.md`](sales-order-blueprint.md) (scale, kernel), [`core-finance-module.md`](core-finance-module.md) (ledgers, balances, integrity jobs), [`order-stage-timeline.md`](order-stage-timeline.md) (stage events), [`stock-locations.md`](stock-locations.md), [`business-time-zone.md`](business-time-zone.md).

---

## 1. Goal

Reports are how an owner, a branch manager, an accountant and an auditor see what the platform is worth to them. The module must be:

- **Complete.** Every question a distributor, wholesaler, retailer or till operator asks has a standard report (section 6), at the depth of Business Central, NetSuite, SAP Business One, Odoo, Lightspeed and Square, and where we are stronger (explained numbers, one definition of each measure) we say so.
- **Trusted.** A number on a report equals the number in the books and on the screen it came from, to the cent, and can be explained. Where two reports could disagree, the system proves they do not.
- **Fast and cheap at scale.** The blueprint's volume (about 900k orders a day, 10M products, 200 locations, no read replica, no managed queue) must not make a report slow or hurt the till.
- **Safe.** Every report is permissioned on the server, company scoped and branch scoped; exports are audited; nothing a person may not see is computed, cached or exported.
- **Configurable as data.** A company builds its own report, dashboard, schedule and distribution list without a release.

## 2. What exists today (evidence)

| What | Where | Finding |
|---|---|---|
| Business Overview (sales, collections, profit, receivables, inventory, "attention" items, headline sentence) | `domains/reports/` (`service.ts`, `queries.ts`, `period.ts`, `headline.ts`, `types.ts`) | **Good base.** Pure period resolver with comparison windows, per-section permissions (`report_sales:read` ...), branch scope (`reports:all_branches`), definitions version, in-process cache (15 s, per-permission key). Every figure is a **live aggregate over `orders`**. |
| Trial balance, GL entries, registers, balance drift | `finance/reports-service.ts`, `gl_account_balances` | Read from the ledger. No financial statements (P&L, balance sheet, cash flow) yet. |
| Customer statement, receivables ageing, wallet liability, refund report, bank position | `finance/receivables/*` | Exist as screens, each with its own query and export. |
| Payables ageing, statement, advances, reconciliation, Vendor reports, Vendor scorecard | `vendors/payables-report-service.ts`, vendor insights | Exist. |
| Delivery report, performance, late deliveries, running costs | `delivery/reports.ts` | Exists. |
| Pricing Insights, price book | `pricing/*` | Exists, cached a minute. |
| Customer Analytics | `analytics/service.ts` (88 lines) | **Thin and static** (not period or branch aware). |
| X and Z shift reports (PDF) | `selling/shifts/shift-report-document.ts` | Exists. |
| Order stage timeline, SLA breaches, funnel | `orders/timeline-read.ts`, `sla-service.ts` | Facts exist for lead-time and funnel reports. |
| Integrity jobs | finance, stock, payables | The proof that a report can be trusted already runs nightly in three places. |

**What is missing**

1. **No reports module.** Reports are scattered over seven sidebar places, each with its own filters, period handling, export and permission style. A user cannot find, save, schedule or compare them.
2. **No financial statements** (income statement, balance sheet, cash flow, budget versus actual).
3. **No sales analysis depth:** by customer, product, category, brand, salesperson, channel, route, margin by line, price variance, discount leakage, basket analysis, cohort and retention, ABC, new versus returning.
4. **No inventory reports** beyond levels and the ledger: valuation by location and date, ageing and dead stock, turnover, days of cover, reorder suggestions, shrinkage, transfers in transit, stock-out cost.
5. **No scheduling, subscriptions, email delivery, saved views, user-built reports or dashboards.**
6. **No reporting store.** Every figure aggregates raw `orders`, order lines or ledgers at request time. That is correct but will not hold at 900k orders a day on a primary with no replica.
7. **No definitions catalogue.** "Sales", "net sales", "margin", "collected" mean slightly different things in different screens.
8. **Exports are per screen**, with no common audit or formula-injection rule.

## 3. Principles

1. **One definition per measure.** A *measure catalogue* (code, name, plain meaning, formula, unit, source, version) is the only place a number is defined. Every report, dashboard, export and API reads it. A definition change bumps a version that is printed on the report (`OVERVIEW_DEFINITIONS_VERSION` generalised).
2. **Facts in, numbers out; reports never write.** Reports read the append-only ledgers and documents (orders, stage events, stock movements, GL, customer and vendor ledgers). No report writes business data.
3. **Reports reconcile or say why not.** Every report that has a counterpart in the books carries a **tie-out line** (sales report total equals sales posted to the GL; stock valuation equals inventory control account; receivables equals debtors control; payables equals creditors control). A difference is shown with the documents behind it, never hidden. Nightly jobs prove it (extending the integrity jobs).
4. **Accurate as of, always visible.** Every report states *as of* time, period in the **business time zone**, base currency, scope (company or branch), definitions version, and whether it is **live**, **near-live** or **closed-period**.
5. **Closed periods are frozen.** Once a fiscal period is closed, its figures are served from stored snapshots so a report printed in March for last June always matches the one printed in July. A re-run after a late correction shows both and says so.
6. **Pure core, thin edges.** Report definitions, period maths, comparisons, ranking and layouts are pure functions with unit tests (as `period.ts` and `headline.ts` already are). Database access is in query modules; screens render.
7. **Server decides who sees what.** Permission per report family plus branch scope, applied in the query, not by hiding columns afterwards (as the overview already does).
8. **Non-blocking screens.** Report pages follow project rule 5: the shell and filters render at once, each panel streams in via `use()` inside `Suspense`, panels fail independently with a retry.
9. **Bounded work.** Every report has a row limit, a date-range limit and a timeout; large outputs are produced as jobs (section 9), never inside a request.

## 4. Architecture

```
Source of truth (append-only facts)              Reporting layer                          Consumers
 orders, order_items, stage events    ─┐     ┌─► measure catalogue (definitions)  ─┐
 payments, receipts, customer ledger   │     │                                     │  Report pages (streamed panels)
 stock_movements, balances             ├─► facts/rollups (section 5) ─► query engine ─┼─► Dashboards, KPI tiles, headline
 gl_entries, gl_account_balances       │     │   (permission + scope + period)     │  Exports (CSV, XLSX, PDF), API
 vendor ledger, deliveries, shifts     │     └─► snapshots of closed periods     ─┘  Schedules and email distribution
 (HR later: attendance, payroll)      ─┘                                             Alerts and thresholds
```

### 4.1 Query engine (one door)

`ReportService.run(reportCode, params, actor)` is the only way to produce a report. It:

1. loads the **report definition** (code, family, permission, measures, dimensions, filters, default layout, limits, source tier);
2. resolves the period with the existing `resolvePeriod` (comparison windows included) and the business time zone;
3. resolves scope (company, branch, location set) from the actor, as `resolveScope` does;
4. checks the permission and refuses before any read;
5. builds the query **from the definition**, not from free text (parameters are typed and validated; no SQL from the browser);
6. serves from the right **tier** (live, rollup, snapshot; section 5), with the result cache keyed by (report, params, scope, permission set, definitions version);
7. returns rows plus `meta` (as of, scope, definitions version, tier, tie-out result, truncated flag) and writes an audit row for exports and for sensitive families.

Reports are registered in code (the **registry**, like lookup sources and platform modules), and a test fails when a registered report has no permission, no measure definitions, no documentation entry or no tie-out declaration. User-built reports (section 8) are definitions stored as data and run by the same engine, so they cannot exceed what the registry allows.

### 4.2 Dimensions and measures

A shared set of **dimensions** (date and period, branch, location, channel, sales type, customer, customer group, product, category, brand, product group, vendor, salesperson, payment method, delivery zone, rider, cost centre and the existing finance **dimension sets**) and **measures** (section 6) so that any measure can be cut by any dimension it makes sense for. The catalogue records which pairs are valid, which prevents nonsense cuts (stock by salesperson).

## 5. Data tiers and scale

Three tiers, chosen per report by the registry, never by the user.

| Tier | Source | Used for | Freshness |
|---|---|---|---|
| **Live** | The documents and ledgers directly, narrow indexed queries with keyset paging | Operational lists and small scopes: today's till, an order, a customer statement, a stock card | Real time |
| **Rollup** | Incremental **summary tables** maintained by the worker from the outbox / stage events and ledgers (below) | Dashboards and analysis over weeks and years | Seconds to minutes (shown on the report) |
| **Snapshot** | A stored result frozen when a fiscal period closes, with a hash | Statutory and management packs, comparisons with past periods | Fixed |

**Rollup tables** (additive, company scoped, partitioned by month, rebuilt from facts by a job so they are never the truth):

| Table | Grain | Key measures |
|---|---|---|
| `rpt_sales_daily` | day × branch × channel × sales type × customer × product | quantity, gross, discount, net, tax, cost, margin, orders (distinct counted by a separate order-day table), returns |
| `rpt_cash_daily` | day × branch × payment method × shift | collected, refunded, fees, variance |
| `rpt_stock_daily` | day × location × product | opening, receipts, issues, transfers, adjustments, closing, value at cost |
| `rpt_receivables_daily`, `rpt_payables_daily` | day × customer / vendor × bucket | open, overdue, by ageing bucket (so ageing at any past date needs no replay) |
| `rpt_order_flow_daily` | day × stage × outcome | counts, median and p90 time in stage (from stage events) |
| `rpt_delivery_daily`, `rpt_vendor_daily` | day × zone/rider and day × vendor | on-time, attempts, cost; lead time, fill rate, price variance |
| `rpt_hr_*` (later) | day × employee / department | hours, overtime, cost, headcount |

Rules: rollups are **additive**, so any grouping is a sum; ratios are computed from sums on read (never averaged averages); updates are idempotent by (source id, version); a nightly job recomputes a sample window from facts and compares (the integrity-job pattern), raising a finding with exact keys on any difference; a rebuild is a permissioned, resumable job.

**Why not materialised views or a warehouse first:** materialised views need full refreshes that lock or lag at this volume, and a separate warehouse adds infrastructure the blueprint's constraints (one Postgres, graphile-worker queue) rule out. Rollup tables in the same database, written by the worker in small keyset batches, need nothing new and keep reports transactional with the source. The design keeps the query engine behind a port, so a column store or replica can serve the rollup tier later without changing a report.

**Load rules.** Heavy reports run only against rollups or snapshots, never against `orders` during trading hours. Anything over a configured cost is a **background job** with progress and a notification. A report has a timeout and a result cap; the screen says when a result was cut and offers the export job. Indexes are added for every query path with the migration that adds the rollup.

## 6. Report catalogue

Grouped as the sidebar will be. Each entry becomes a registry item with owner, permission, measures, dimensions, tier and tie-out. Existing screens stay where they are for one release and are re-pointed at the registry (section 12).

### 6.1 Executive and management
- **Business Overview** (exists): headline, sales, collections, profit, receivables, inventory, attention list. Becomes the first dashboard of the module.
- **Management pack:** one printable monthly pack (income statement, balance sheet, cash flow, KPIs, receivables and payables position, stock value, top and bottom lists, commentary) from snapshots.
- **KPI scorecard** per branch and per person with targets and traffic lights.
- **Branch league table**, **company versus budget**, **trend and seasonality** (12 and 24 month, same-period-last-year).
- **Cash position and forecast:** bank and till balances, due receivables and payables by week, committed purchase orders, expected deliveries cash, projected 13-week cash.

### 6.2 Sales (distribution, wholesale, retail, POS)
- Sales summary and detail by day, week, month, branch, channel, sales type, customer, customer group, salesperson, product, category, brand, product group, route and delivery zone.
- **Gross margin** by line, product, customer, category, branch; margin leakage (discount, price override, below floor); **price variance** by branch and customer; **discount and promotion effectiveness** (cost, uplift, budget burn: uses pricing insights).
- **Top and bottom** products and customers, **ABC / Pareto**, **new versus returning customers**, **customer lifetime value, cohorts and retention**, **churn risk** (no order for N days against their usual rhythm), **basket analysis** (units per basket, attach rate, frequently bought together), **average order value and items per order**.
- **Quotes:** pipeline, win/loss with reasons, conversion, ageing, value by stage, salesperson performance, expiring quotes.
- **Orders:** open orders and backlog, aged backorders, fill rate, **order-to-cash cycle** (stage timings from the timeline: placed to paid, paid to dispatched, dispatched to delivered), cancellations and reasons, refused checkouts and reasons (funnel from `checkout_attempts`), approvals turnaround.
- **Returns and credit notes:** rate by product, customer, reason, branch; value; restock disposition.
- **Packages and kits:** sales by package and by selection, preparation totals, option popularity, below-cost configurations.
- **Web shop:** funnel (visit not tracked yet; initiated, refused, placed, paid), cart abandonment and recovery, payment success rate by method and provider, search terms with no results (needs search logging).

### 6.3 Point of sale and cash
- **X and Z reports** (exist), **shift variance history**, **cashier performance** (sales, voids, returns, discounts, average time), **till and register comparison**, **tender mix**, **hourly sales heat map**, **voids, returns and discount exceptions** (fraud controls), **offline sales review**, **cash counts and variances**, **paid in / paid out**.

### 6.4 Products and inventory
- **Stock valuation** by location, branch, category as of any date (from `rpt_stock_daily`), tied to the inventory control account.
- **Stock card / movement ledger** per product and location; **stock on hand and available** (on hand less reserved), **low stock and reorder suggestions** (using sales velocity and lead time), **days of cover**, **inventory turnover and GMROI**, **stock ageing** and **dead / slow stock**, **overstock**, **stock-outs and lost sales estimate**, **ABC-XYZ classification**.
- **Receipts and purchases by product**, **cost price history and landed cost**, **margin erosion** (cost rising faster than price).
- **Transfers:** in transit, ageing, lost; **counts:** variance by product and counter, shrinkage rate, **write-offs and adjustments by reason**, **expiry and batch** (when batches exist).
- **Kits and component availability**, **negative stock findings**, **stock integrity check** results.

### 6.5 Finance
- **Financial statements** (configurable layouts, section 7): income statement (monthly, quarterly, annual, comparative, by branch and dimension), balance sheet, cash flow (direct from bank ledger, indirect from movements), statement of changes in equity, **budget versus actual**, **trial balance** (exists), **general ledger and account detail** with drill-down to document, **dimension and branch P&L**.
- **Receivables:** ageing (exists), **customer statements**, **collections effectiveness** (DSO, collection rate, promise-to-pay), **credit limit utilisation and exposure**, **bad debt and write-offs**, **wallet liability**, **unapplied cash**, **top debtors**, **disputed items**.
- **Payables:** ageing, vendor statements, **cash needed to pay on time**, **early-payment discount capture**, **withholding tax schedules** and certificates, **advances outstanding**.
- **Banking:** reconciliation status, **unreconciled items ageing**, **payment gateway settlement and fees**, **M-Pesa reconciliation**, **refund report**, **cheque register**.
- **Tax:** the full suite is section 17 (VAT by rate and direction, return support, eTIMS, withholding, excise, tax by product, category, customer, vendor and branch, tax audit file).
- **Audit:** finance audit trail, posting register with hash chain status, period close checklist, **journal entries by user and reason**, **control-account reconciliations** (all of them on one page), **segregation-of-duties exceptions** (maker equals approver attempts blocked).
- **Foreign currency:** exposure by currency, revaluation, realised and unrealised exchange differences.

### 6.6 Customers
- **Customer 360** (orders, payments, ledger, wallet, returns, quotes, delivery issues, reviews, margin contribution), **segmentation** (RFM, group, value tier), **retention and cohort**, **acquisition by channel**, **loyalty and gift card liability and usage**, **rebate accruals and settlements**, **reviews and ratings summary**, **newsletter growth**.

### 6.7 Vendors and purchasing
- **Spend** by vendor, category, product, branch; **purchase price variance** (PO versus invoice versus last price); **vendor scorecard** (on-time, fill rate, quality rejects, price stability; exists in part); **PO status and backlog**, **goods received not invoiced**, **three-way match exceptions**, **RFQ cycle time and savings**, **contract compliance and expiring contracts**, **prequalification status and expiring documents**, **landed cost analysis**, **supplier concentration risk**, **returns to vendors**.

### 6.8 Delivery and logistics
- **On-time delivery**, **first-attempt success**, **failed delivery reasons**, **delivery cost per order and per km**, **delivery margin** (charge less cost), **rider productivity and pay**, **cash in custody and variance**, **courier performance and invoice variance**, **slot utilisation**, **late deliveries**, **vehicle running cost** (exists in part).

### 6.9 Projects and job costing
- Budget versus actual by project, **WIP**, **margin by project**, **time and expense**, **billing versus progress** (extends the Projects module).

### 6.10 People (HR, Kenya first and built for Africa; the full design is section 19)
HR is an end-to-end module still to come, so the reports module is built to receive it without rework: employees, departments and positions become **dimensions**; attendance, leave, payroll and benefits become **facts** with their own rollups (`rpt_hr_*`). Planned reports: headcount and turnover, attendance and lateness, overtime, leave balances and liability, payroll cost by department and branch, payroll statutory returns (PAYE, NSSF, SHIF, housing levy for Kenya, as a localisation pack), **sales per employee and labour cost percentage** (the retail and wholesale classics), commission and incentive, recruitment funnel, training, performance. Payroll data is the most sensitive in the system: its reports use their own permission family, column-level hiding of pay, and an audited export.

### 6.11 Operations and system health
- Order flow and **stuck orders / SLA breaches** (exists), **approvals backlog and turnaround**, **integration health** (payments, KRA, SMS, email delivery, courier), **failed jobs**, **data integrity dashboard** (every nightly integrity result in one place), **user activity and permission use** (who exported what, who viewed payroll or bank details), **report usage and slow reports**.

## 7. Financial statement layouts (as data)

Statements are not hard-coded to account numbers. A **report layout** is data: rows (heading, account range, formula over other rows, total, ratio), columns (period, comparison, budget, variance, percentage of revenue), sign rules and a mapping to the chart's **account category and subcategory** (already in `gl_accounts`). Shipped layouts: international (IFRS-style) and Kenya; a company copies and edits. Layout changes are versioned, reasoned and logged; a snapshot stores the layout version it used. Dimensions and branches filter any layout. Budgets are stored as data (`budgets`, `budget_lines` by account, period and dimension set) with a screen and import.

## 8. Building your own: saved views, custom reports, dashboards

1. **Saved views:** any report's filters, columns, sort, grouping and comparison saved per user or shared (permission-checked on load, so a shared view never shows more than the viewer may see).
2. **Report builder:** pick a **dataset** (sales lines, stock movements, ledger entries, receivables, payables, deliveries, HR), choose dimensions and measures from the catalogue (only valid pairs), filters, grouping, sorting, calculated columns from a small, safe expression language (arithmetic, comparisons, ratios; no arbitrary SQL, no functions that reach other data), conditional formatting, subtotals. It compiles to the same typed query as a registry report; **permission and branch scope are applied by the engine, not by the builder**.
3. **Dashboards:** a grid of tiles (KPI with comparison and sparkline, chart, table, list of attention items). Role-based defaults (owner, branch manager, cashier supervisor, accountant, buyer, warehouse, dispatcher, HR) that people may copy and adjust. Tile layouts are data; each tile is one report call, streamed independently.
4. **Targets:** targets per measure, branch, person and period (data), shown as thresholds and traffic lights.
5. **Drill-through everywhere:** every number links to the next level and finally to the source documents (order, invoice, journal register, stock movement), with the filter carried over.

## 9. Delivery: exports, schedules, alerts, API

- **Exports:** CSV, XLSX and PDF from one **export service**: formula-injection neutralised (cells starting with `= + - @`), UTF-8 with BOM for Excel, the definitions version and as-of in a footer sheet, row cap and an async job above it, audit row (who, which report, parameters, rows, hash), permission `reports:export` plus the report's own. Branded PDF layouts reuse document layouts.
- **Schedules and subscriptions:** run a report or dashboard daily, weekly, monthly or at period close, send to people, roles or addresses by email (links, not attachments, for sensitive reports; attachments when allowed), recipients re-checked against permissions **at send time** (a person who lost access gets nothing), delivery log with retries, a failure never blocks anything else. Uses the existing email routing and outbox. WhatsApp or SMS summaries (owner's daily "yesterday in numbers") when the SMS port has a provider.
- **Alerts and thresholds:** a rule on a measure (stock-out risk, margin below floor, overdue above limit, cash below minimum, till variance, spike of voids, failed integrations) raising a notification, with de-duplication and a reason. Alerts use the approvals and notification machinery where one exists.
- **Read API:** versioned, authenticated, rate-limited, company scoped endpoints over the same engine for BI tools (Power BI, Looker Studio, Excel Power Query), with scoped, revocable, hashed API keys and an audit trail.
- **Embedded in screens:** the same registry reports appear as panels inside Orders, Customers, Vendors and Products (a customer's statement, a product's sales and stock history).

## 10. Security, privacy and audit

- Each report family has its own permission (`report_sales:read` and the five that exist stay; new ones are added per family: `report_finance`, `report_stock`, `report_customers`, `report_vendors`, `report_delivery`, `report_pos`, `report_projects`, `report_hr_*`, `report_audit`); `reports:all_branches` stays as the scope switch; `reports:export`, `reports:schedule`, `reports:build` are separate. Existing roles are given nothing new automatically except by an explicit migration that maps today's keys, as was done for refunds.
- Cost, margin, payroll, bank and personal data are separate sensitivity classes: a user with sales but not profit permission gets sales rows with **no cost or margin column computed**.
- Rollup tables carry `company_id`; every query is company scoped and branch scoped in SQL. Cache keys include permissions. Result and export files are private, expire, and are served by signed route.
- Personal data (customer phone, employee pay) is masked in lists unless the permission to see it is held; every view of the most sensitive reports is logged (as bank detail views are).
- Reports never accept raw SQL or free column names from the browser; the builder's output is validated against the catalogue.

## 11. Quality bar (project rules applied)

- **Screens:** loading, empty, error and partial states for every panel; as-of and scope always visible; filters in the address so a result can be shared (as the storefront does); 390 px to desktop with no horizontal scroll (wide tables become cards on phones, with a "view as table" scroll box inside its own container); charts with text alternatives and tables beneath; WCAG AA, colour never the only signal; selection inputs through `ChoicePicker` / `LookupAutocomplete`, never `<select>`.
- **Charts:** one small, accessible chart kit used everywhere (line, bar, stacked bar, area, donut limited to few slices, heat map, waterfall, funnel, sparkline, histogram); consistent palette that holds in light and dark.
- **Tests (full pyramid, every slice):** unit (definitions, period and comparison maths, expression language, layout evaluation, ranking), integration (every report against a seeded database with **known answers**, tie-out to the books, rollup versus live equality, scope and permission refusals, closed-period snapshots stable), API (permission, tampered params, export audit, API key scope), e2e desktop and phone (filters, drill-through, export, schedule, layout checks). **Property tests:** rollup equals live aggregate over random histories; any grouping of an additive measure sums to the total; comparison windows never overlap.
- **Load gate:** a 90-day rollup dashboard, a year of sales by product and a stock valuation as of last month must meet p95 targets on a production-sized dataset while the till writes continue (target to be set in R-0 from blueprint section 2: for example dashboard panel under 300 ms from rollup, any registry report under 2 s, anything heavier is a job).
- **Docs:** every report documented in the implementor guide (8-part anatomy) with its sales talk track (what question it answers, who uses it, the decision it supports); `src/config/seo/platform-modules.ts` entry for the module in everyday words ("sales reports", "stock valuation report", "profit and loss", "VAT report", "end of day report"); the platform page lists it.

## 12. Slices

| Slice | Delivers | Gate |
|---|---|---|
| **R-0a Benchmark study** *(closed 2026-11-22)* | Documentation study and 150-question scorecard done ([`reports-benchmark.md`](reports-benchmark.md)); the hands-on trial pass was skipped by the owner; the scorecard is now the acceptance checklist for our own reports | Every later slice scores its reports against the scorecard questions it answers |
| **R-0 Foundation** | Measure catalogue and definitions version; report registry; `ReportService.run` (period, scope, permission, cache, audit); common filter bar and address-borne state; **the premium report design system and in-house chart kit (section 15)**; export service; **Reports** sidebar module; existing reports re-pointed at the registry with no change of numbers | Every existing report returns exactly its old numbers through the engine (golden tests); a registered report without permission, definition or tie-out fails the build |
| **R-1 Rollups and tie-outs** | `rpt_sales_daily`, `rpt_cash_daily`, `rpt_stock_daily`, receivables and payables daily; worker maintenance, rebuild job, integrity comparison, tie-out lines on sales, stock, receivables and payables reports; overview and dashboard moved onto rollups | Rollup equals live over random histories; tie-outs agree to the cent; dashboard p95 target met under write load |
| **R-2 Sales and POS reports** | Section 6.2 and 6.3 complete, **rankings and the comparison engine (section 18)**; ABC, cohorts, basket analysis, price variance, discount leakage, cashier and till reports | Known-answer tests; drill to documents |
| **R-3 Inventory reports** | Section 6.4: valuation as of any date, ageing, turnover, cover, reorder suggestions, shrinkage, transfers | Valuation equals inventory control account |
| **R-4 Financial statements, budgets and targets, tax** | Layout engine, income statement, balance sheet, cash flow, **the Budgets and Targets sub-module (section 16)**, budget versus actual, dimension and branch P&L, period snapshots, **the tax suite (section 17)** | Statements balance; closed periods stable; tie to trial balance |
| **R-5 Customers, vendors, delivery, projects** | Sections 6.6 to 6.9 | Each ties to its ledger |
| **R-6 Saved views, builder, dashboards, targets** | Section 8 | Builder output cannot exceed the user's permissions (tested by tampering) |
| **R-7 Delivery of reports** | Schedules, subscriptions, alerts, read API and keys | Permission re-checked at send; one send per schedule under retries |
| **R-8 Operations and audit reports** | Section 6.11 | Integrity dashboard reflects every nightly check |
| **R-9 HR reports, Kenya first** | Section 19, delivered with each HR slice (employees and attendance first, payroll next) | Payroll tie to the GL payroll accounts; sensitive-class controls |
| **Docs** | Implementor guide and sales enablement in every slice; SEO registry | Definition of done per project rule 12 |

Slices R-0 and R-1 are the foundation: nothing after them is allowed to query `orders` or the ledgers directly from a screen.

## 13. What we will not promise

That a report equals another tool's number when the two define "sales" differently (the catalogue says exactly what ours means); that figures from a rollup are real time (they say how fresh they are); that a forecast is a guarantee. What the design guarantees is one definition per number, a tie-out to the books where one exists, and a stated as-of on every page.

## 14. Decisions (answers of 2026-11-22 recorded; the rest still open, recommendation first)

**Decided by the owner on 2026-11-22**
- **HR is Kenya only for now, on a platform built for Africa:** every statutory rule is dated data in a pack, never code, so nothing has to be redesigned later (section 19). No other country is planned.
- **Who may set budgets and targets is a permission, not a role in the design.** Every action has its own key granted to people or roles (section 16.5), and the flow is placed in the natural places (section 16.6).
- **Budgets and targets belong in the Reports module** (the budget module does not exist yet, so it is built here, section 16).
- **Depth:** reports must be intensive and extensive, with best sellers, categories, vendor and supplier views, tax and VAT, and comparisons everywhere (sections 17 and 18).
- **Premium UI is a requirement, not a polish item:** it is studied from the Cash Sales till and held to the same standard (section 15).
- **Benchmark:** the best from America, Europe, China and Asia, not only African competitors (section 20).

**Approved by the owner on 2026-11-22:** all recommendations below except item 6, which stays open: 1 (rollups in the same Postgres), 2 (top-level Reports module), 3 (financial reports read the GL, operational reports read documents, tie-out shows the difference), 4 (base currency first, converted reporting at the dated rate later), 5 (report builder in R-6), 9 (email only for scheduled reports; no WhatsApp for now), 10 (three years of daily rollups, then monthly; closed-period snapshots kept forever), 11 (in-house chart kit), 12 (English only, translation-ready). Items 7 and 8 were decided earlier.

**Remaining open:** item 6, the ten reports and dashboards that sell the platform to your first clients, which decides the front of R-2 to R-4. Until given, the build order follows section 12.

**The decision list**

1. **Rollups in the same Postgres, written by the worker** (recommended), rather than a separate warehouse or materialised views now. A read replica and a column store can be added behind the engine's port when volume demands.
2. **A top-level Reports module** (recommended) that lists every report from the registry, rather than keeping reports inside each module. Modules keep small contextual panels fed by the same registry.
3. **Do reports follow the books or the operations when they differ?** Recommend: financial reports read the **GL**; operational reports read **documents**; the tie-out page shows the difference. Sales go to the GL only from the go-live date and foreign-currency postings wait for a rate, so the difference is real and must be visible, not smoothed over.
4. **Base currency only in R-1** (as today: other currencies are counted, not converted), then converted reporting at the dated rate from the books' rate table. OK?
5. **Report builder in R-6 or earlier?** Recommend R-6, after the catalogue and rollups exist, because a builder over unstable definitions produces unreliable reports.
6. **Which dashboards and reports do your first clients ask for?** The catalogue is wide; tell me the ten that sell the platform and they move to the front of R-2 to R-4.
7. ~~Who sets targets and budgets~~ Decided: nobody is named in the design. The permission system already grants each person or role every action individually, so who may set, edit or approve a budget or target is whatever the company gives them (section 16.6). The flow is placed where people naturally look for it.
8. ~~HR scope~~ Decided: Kenya only for now. The platform stays built for Africa (statutory rules are dated data, never code), but no other country is planned or designed until asked.
9. **Delivery channels for scheduled reports:** email only at first; is WhatsApp for owners' daily summaries a requirement (needs a WhatsApp Business provider)?
10. **Retention:** how many years of daily rollup detail to keep on fast storage (recommend 3, older to monthly rollups, closed-period snapshots forever).
11. **Charts: build a small in-house SVG chart kit** (recommended) rather than adding a charting library. The project has none today (its UI dependencies are `motion` and `lucide-react`), the design tokens already handle light, dark and company colours, and a purpose-built kit gives exact accessibility, print and server-render behaviour, and no third-party bundle on every screen. Cost: we write and test it once (R-0).
12. **Language: English only for now, written so more languages can be added later (decided 2026-11-22).** Every word a report shows (titles, labels, findings sentences, empty and error messages, PDF and email text) lives in a message catalogue keyed by id and is never concatenated or built from English grammar in code (findings use whole-sentence templates with named slots, so another language can reorder them). Numbers, dates, currency and plurals go through locale-aware formatting with the company's locale and country (en-KE today), never the browser alone; layouts use logical (start and end) spacing and tolerate longer text, so right-to-left and longer languages need no redesign. Measure names, dimension names and report titles are catalogue entries with a translatable label. No second language is built, translated or tested now.

## 15. The premium experience (what "a gem" means here)

### 15.1 What the Cash Sales till teaches

I read the till (`components/admin/cash-sales/`, `components/ui/screen-kit.tsx`, `app/globals.css`, `lib/till/`) to find what makes it feel premium, because the reports must feel at least this good. Each lesson becomes a rule for reports.

| What the till does | Why it feels premium | Rule for reports |
|---|---|---|
| **One screen, one job.** Search and scan on the left, the sale on the right, nothing else competes. | No hunting; the next action is always obvious. | Every report screen has one question it answers, stated in its title, and one primary view. Secondary detail is a drill, not clutter. |
| **The hero number.** The payment dialog shows the total as a large monospace figure on a dark card with a live, colour-coded sentence under it ("KES 340 still to pay", "Change KES 60"). | The number that matters is the biggest thing on screen and is explained in words. | Every report leads with a **hero strip**: the two to four headline figures, large, tabular, each with its comparison and a plain-language sentence (the existing `headline.ts` idea, for every report). |
| **Honest answers.** "A priced answer counts only for the sale exactly as it stands, so Pay is never available on an old total." | The screen never shows a stale figure as current. | A report figure is bound to the exact parameters that produced it. While new parameters load, the old figure is dimmed and marked *updating*, never shown as the answer to the new question. |
| **Instant feel.** Debounced search, optimistic tile counts, `active:scale` press feedback, skeletons shaped like the real content. | Everything responds within a frame, even when the server takes a moment. | Filters respond immediately (the control changes at once, the data follows); panels stream with skeletons of their own shape; every press has feedback. |
| **Keyboard first.** F2 search, F4, F6, F8, Enter adds a scanned code, a number pad and quick-cash buttons. | Power users never touch the mouse; new users are not slowed down. | A command palette (Ctrl or Cmd K) to jump to any report, person, product or customer; shortcuts for period, compare, export, full screen; every table keyboard navigable. |
| **Big, forgiving targets.** Controls are at least 44 to 64 px, with whole-row hit areas. | Works on a phone, a tablet at a counter, a wet hand. | 44 px minimum everywhere on touch; charts have large hit areas and a keyboard path through points. |
| **Imagery and identity.** Product tiles use the picture, or a stable colour from the name with initials, a stock badge and a count chip. | The screen looks like the shop, not a spreadsheet. | Product, customer and vendor rows in rankings carry their picture or initials tile; branches and people carry stable colours so a series keeps its colour across every chart. |
| **Full-screen mode.** The company can run the till full screen (`till_mode`). | It becomes an appliance. | **Boardroom** and **wall display** modes: full screen, rotating dashboards, auto refresh, no chrome, large type. |
| **Works offline.** Offline selling with an outbox and a service worker. | Trust: it never stops. | Last-good dashboards are kept in the browser and shown with their as-of time when the connection drops. |
| **Saying why.** Every refusal and state is a sentence ("Orders for this lunch close at 10:00 the day before"). | Nothing is a mystery. | Every empty, partial or failed panel says why and offers the next step ("No sales in this branch yet. Last sale: 14 Nov. Show the last 30 days"). |
| **Tokens, not colours.** Surfaces, lines and text are semantic tokens with light and dark and company accent. | One look, every theme, no contrast accidents. | All report colour comes from tokens, including a **data palette** (categorical, sequential, diverging) validated for contrast in light and dark and for colour-vision deficiency. |
| **Design is tested.** `data-testid`s and e2e layout checks (`noHorizontalScroll`, `noInnerHorizontalScroll`). | Quality does not regress. | Visual and layout tests on every report: desktop, phone, dark, print. |

### 15.2 What reports need beyond the till

1. **Numbers are typography.** Tabular, monospaced digits so columns align and change without jitter; compact forms (1.2M) in tiles with the exact value on focus and in tables; negatives and variances in one consistent form (colour plus sign plus arrow, never colour alone); currency, decimals and symbol from the company's currency setup; consistent rounding with the books.
2. **A purpose-built chart kit** (decision 11): line and area with comparison overlay, bar and grouped and stacked, horizontal ranked bars with pictures, waterfall (variance bridges), funnel, heat map (hour by day, product by branch), treemap, bullet (actual against target), sparkline, histogram, donut (few slices only), calendar heat map, and a small-multiples grid. Every chart: tokens, a keyboard and screen-reader path (data table beneath, an `aria` summary sentence), hover and focus tooltips with the comparison, smooth short motion (respecting reduced motion), correct on a phone (simplified marks, tap to inspect), crisp in print and PDF, server-renderable for emails and PDFs.
3. **Insight, not only display.** Each report may carry **findings** computed by rules in the catalogue and shown above the data in words: *"Sales are up 12.4% on last year, but 70% of the rise is two customers"*, *"Margin fell 2.1 points: price drove +0.4, mix drove -1.9"*, *"Product X has 9 days of stock at the current rate"*, *"This branch's voids are 3 times the company average"*. Findings come from deterministic rules and variance decomposition (price, volume, mix, discount, exchange rate), never from a guess, each with a link to the evidence. (An assistant that answers questions in plain language is a later, optional layer over the same engine and the same permissions.)
4. **Comparison is one click everywhere** (section 18): a compare control on every report (last period, same period last year, budget, target, another branch, another product or customer), with the difference shown in the chart and the table.
5. **Pinned and personal.** Pin any report or tile to a personal home; role defaults; recently viewed; a favourites bar; saved views with a name and a share link.
6. **Beautiful on paper and in a message.** PDF packs designed as documents (cover, contents, one page per report, brand, as-of and definitions footer, page numbers); email digests with the hero strip and one chart rendered server-side; share images for chat. Same chart kit, same tokens.
7. **Owner on a phone.** A phone-first **Owner view** (installable PWA; web push exists in the project): yesterday in numbers, today so far, cash, what needs attention, one-tap drill; push alerts for the owner's thresholds.
8. **Accessible and fast.** WCAG AA, reduced motion respected, focus management in drawers and dialogs, first meaningful paint from the server shell, panels streamed, no layout shift (skeletons match final size), and an interaction budget (filter change to first updated figure under 200 ms perceived, from rollups under 300 ms on the server).
9. **Consistency kit.** One page frame (title, question, as-of and scope strip, filter bar, compare control, hero strip, panels, footnote with definitions), one table (sticky header and first column, column chooser, density, sort, group with subtotals, inline sparklines and data bars, conditional formats, virtualised for long lists, copy, export), one drill drawer. Every report is built from these parts; a report that needs a new part adds it to the kit.

### 15.3 How we keep it premium

- A **design review checkpoint** in each slice: screenshots at 390 px, 768 px and 1440 px, light and dark, with real seeded data, reviewed against this section before the slice is called done.
- A **golden-visual test** set (Playwright screenshots of the kit and of each report with seeded data) so a regression is caught.
- A **report style guide** page inside the admin (the kit's components, the data palette, the number formats) kept in the repository and reviewed with every kit change.
- **Real data, always.** The seed for demos and tests includes a believable year of trade (seasonality, promotions, returns, a slow branch, a star product) so every chart and finding is shown at its best and tested at its worst.

## 16. Budgets and targets (a sub-module of Reports)

A budget is a plan; a target is a goal someone is held to. Business Central, NetSuite and Dynamics ship budgets as a finance feature; retail and POS systems ship targets as a sales feature; we ship both on one model, because the questions are the same ("where are we against plan?").

### 16.1 Concepts

| Term | Meaning |
|---|---|
| **Budget** | A versioned set of planned amounts by **account, dimension set, branch and period** (finance) or by **measure** (units, orders, margin, headcount). A budget has a fiscal year, a name, a status and a basis. |
| **Version** | Original, Reforecast 1, Reforecast 2, and so on. Only one is *current*; all are kept, so a report can show actual against original and against the latest forecast. |
| **Target** | A goal on any catalogue measure for a **person, branch, channel, customer group, category, product, vendor or the company**, for a period, with optional thresholds (red, amber, green) and a link to commission or incentive rules later. |
| **Forecast** | A projected value for open periods, from a method (see 16.3), shown beside budget and actual. |

### 16.2 What you can do

- **Create** a budget from scratch, from last year's actuals (with a percentage uplift), from a prior budget, or by import (CSV and Excel with a template and validation).
- **Spread** an annual figure over periods: evenly, by days, by last year's seasonal shape, by a seasonality profile, or by hand. Lock periods already closed.
- **Top-down and bottom-up:** head office sets a company total and allocates to branches and accounts; branch managers refine their own lines; the system shows the sum and any gap before submission.
- **Approve:** submission uses the existing approvals engine (trigger `budget.submit`); a budget goes *draft, submitted, approved (current), superseded, archived*; nothing approved is edited, a revision is a new version with a reason (the same rule as price lists and workflows).
- **Targets in bulk:** set a target for every salesperson or branch from a rule ("5% above last year, floor KES 400,000"); individual overrides with a reason.
- **Track:** budget and target lines are data (`budgets`, `budget_versions`, `budget_lines`, `targets`), company scoped, with dimension sets, effective dates, `version` for optimistic edits, decision log for every change.

### 16.3 Forecasting (honest and simple first)

Methods the company chooses per line: run rate, same period last year, trailing average, seasonal index, **actual plus remaining budget**, straight-line to target, and manual. Each forecast says its method and as-of. We do not claim predictive accuracy; the report shows the method and the error of the last forecast so users learn how far to trust it. A **rolling 13-week cash forecast** uses due receivables, due payables, committed purchase orders, scheduled payroll and recurring items.

### 16.4 Reports on top

Budget versus actual (by account, branch, dimension, period, year to date, full year outlook), variance with **favourable and unfavourable** shown correctly for income and for cost, variance explanation (price, volume, mix), **target attainment** league tables and bullet charts, **run-rate to hit target** ("you need KES 41,000 a day for the next 9 days"), **forecast versus budget**, **version comparison**, and **commission base** reports. Dashboards get target lines and traffic lights from the same data.

### 16.5 Permissions and controls

Following the platform rule that every action has its own permission and is granted to a person or role individually, nothing in this sub-module assumes a job title. The keys are: `budgets:read`, `budgets:create`, `budgets:edit`, `budgets:submit`, `budgets:approve`, `budgets:import`, `budgets:reforecast`, `targets:read`, `targets:set`, `targets:set_all_branches`, `targets:approve`; branch scope comes from the existing `reports:all_branches` rule. A person with `targets:set` but not `targets:set_all_branches` sets targets only for their own branch and the people in it. Whether a budget or target needs approval is the company's choice through the approvals engine (a workflow on `budget.submit` and `target.set`; with no workflow it takes effect at once, the platform's standing rule). A requester cannot approve their own submission; an approved budget is immutable; every change is in the decision log with who and why.

### 16.6 Where it lives, so people find it naturally

The test is the one other good systems pass: a person looking for "the budget" or "my target" finds it in the place they would look, and the same data appears wherever it helps them, without a second copy. So there is **one data model and several natural doors**, each shown only to people who hold the permission for what it does.

| Who looks, and where | What they find | Why it is natural |
|---|---|---|
| **Finance → Budgets** (accountant, finance manager) | The budget list by fiscal year and version; open one to see a grid of **accounts down, periods across**, filtered by branch and dimension; spread, copy last year, import, submit, reforecast, compare versions | This is where Business Central and NetSuite put it, beside the General Ledger and Trial Balance; the grid reads like the trial balance they already use |
| **Sales & Fulfillment → Targets** (sales manager) | Targets for people, branches, channels, categories, customer groups: a table of who and what, the period, the goal, progress so far, and a bulk "set from last year plus x%" action | Sales people think in quotas next to their orders and quotes; it sits with the sales screens, not in finance |
| **On the thing itself:** a branch, a salesperson's user card, a product, a category, a customer group, a vendor | A small **Targets** panel on its own screen ("Mombasa branch: June target KES 4.2M, 61% reached") with *Set or change target* | When you are looking at the branch, you expect to find its goal there |
| **On a report, in place:** click a bar, a row or a tile on any report | The row menu offers **Set target for this** and **Add to budget** (only if permitted); the target line then appears on that chart | People discover targets at the moment they ask "how should this be doing?" |
| **Dashboards and the owner's phone view** | Target lines, traffic lights and "needs KES 41,000 a day to hit it" on the tiles; the person's **own** target at the top of their own home | Targets are seen daily by the people held to them, not buried in a setup page |
| **A person's own view: "My targets"** | Every target set for me, progress, run-rate, what changed | Salespeople and cashiers look for "how am I doing" without needing any setup permission |
| **Approvals → Waiting on me** | A submitted budget or target change, with the version difference | Approvals already live here for everything else |

**The flow as users meet it**

1. **Plan (yearly).** Finance opens *Budgets → New budget*, chooses the fiscal year, starts from last year's actuals with an uplift (or blank, or import), spreads by seasonality, and branch managers with `budgets:edit` refine their own branch lines. The budget shows its total, its gap to the company goal and any account with no plan. Submit. If the company has a workflow it goes to *Waiting on me* of the approver; otherwise it becomes current.
2. **Set goals (monthly or quarterly).** The sales manager opens *Targets*, sets "each branch: last year plus 8%", adjusts two with a reason, and the people targets follow from the branch targets (a share by past contribution, editable). Each person sees theirs in *My targets*.
3. **Watch.** Actual against budget and target appears on the Business Overview, on each branch and person, and in the monthly pack, with the same favourable and unfavourable colouring everywhere.
4. **Reforecast.** Mid-year finance creates *Reforecast 1* from year-to-date actuals plus remaining budget; the report compares original, reforecast and actual.
5. **Close and learn.** At period close the figures are frozen into the snapshot; attainment and variance explanations are kept for the review.

Nothing is duplicated: a target set on the branch screen, in the Targets list or from a report row is the same row and the same permission check, and the activity is in the decision log whichever door was used.

## 17. Tax reports (VAT and beyond)

Tax is the report auditors, accountants and revenue authorities read, so it has the strictest rules in the module: it reads the **tax entries and the GL**, ties to the tax control accounts, and is frozen at period close.

### 17.1 The suite

- **VAT summary and return support** by period: **output tax** (sales) and **input tax** (purchases and expenses), by **tax rate and class** (standard, zero-rated, exempt, out of scope), net, tax and gross, with credit notes and debit notes shown separately and netted, the **VAT payable or refundable**, and the carried-forward position. Layouts follow the company's country pack (for Kenya, the return's boxes; for another country, its own), as data.
- **VAT by product, category, customer, vendor, branch and channel;** **VAT on prices that include and exclude tax** shown consistently; **kits and packages taxed by part** (the kit rule) so the report matches the invoice.
- **Sales and purchase VAT registers** (every document, in number order, with the customer or vendor tax number), exportable as the authority's file format where one exists.
- **Tax reconciliation:** the VAT control accounts in the GL against the tax entries and against the register, with every difference listed by document; **late postings and reversed documents** flagged.
- **eTIMS (KRA) compliance:** signing status by document, **unsigned and failed** documents with reasons and age, retries, rejected items, items not registered with the authority, invoices issued with no customer PIN where one is required, credit notes against signed invoices, a **daily and monthly signing completeness** check (every taxable sale has a signed document or a stated reason), and the audit trail of each transmission.
- **Withholding:** withholding VAT and withholding income tax deducted from vendor payments and suffered on customer receipts, by vendor and certificate, **certificates issued and outstanding**, schedules ready for filing.
- **Excise, levies and other duties** where the company configures them; **import duty and landed cost tax** with the landed cost module.
- **Customer and vendor tax-number quality:** missing, malformed (the country pack's pattern) and duplicate numbers, with a worklist.
- **Payroll taxes** (section 19) and **corporate income tax support:** taxable profit workings, disallowed items flagged by account, capital allowances schedule (when fixed assets exist), provisional tax estimates from the year to date.
- **Tax audit file:** a complete, period-bound export of invoices, credit notes, purchases, tax lines and the GL with hashes, for an audit or a data request.

### 17.2 Rules

Tax regimes are **packs, not code** (core finance section 4.3): rates, classes, return layouts, registers and e-invoicing adapters are data, so Uganda's, Tanzania's, Rwanda's, Nigeria's and others' regimes are added as packs without touching the engine. A rate change is effective-dated; a report for an old period uses the rate and layout in force then. Every tax report carries the tie-out, the layout version and a **review stamp** (prepared by, reviewed by, date) kept as data for the audit.

## 18. Rankings, comparisons and the "everything by everything" principle

### 18.1 Rankings (the questions every owner asks)

One **ranking engine** answers "what are the best and worst, by what, in which period", for any ranked entity and any measure, with the same controls everywhere:

- **Entities:** product, variant when it exists, category and sub-category, brand, product group, kit and package, customer and customer group, salesperson, branch and location, channel, payment method, delivery zone and rider, vendor and supplier, project.
- **Measures:** quantity, revenue (net and gross), margin amount and percentage, orders and lines, average price, discount given, returns, share of total and **cumulative share (Pareto / ABC)**, growth against the comparison, rank movement (up or down since last period), velocity (units a day), and days of cover.
- **Controls:** top N or bottom N, minimum volume to qualify (so a single sale does not top a margin ranking), period and comparison, any filter on any dimension, and "include or exclude kits, gifts and services".
- **Output:** ranked bars with pictures, a table with sparklines and rank movement, a Pareto line, and the **long tail** summary (how many items make 80% of sales).

Examples that ship as named reports: **best-selling products** (by units, revenue and margin), **best and worst categories**, **best brands**, **slow and dead stock**, **top customers and customers at risk**, **top salespeople**, **top branches**, **top vendors by spend**, **most returned products**, **most discounted products**, **fastest-growing and fastest-declining items**.

### 18.2 By vendor or supplier

Owners want to know which **suppliers** their sales and profit come from. Three questions with three answers, kept apart so none is misleading:

1. **Purchases from a vendor:** spend, orders, price trend, on-time and fill rate, quality (exact, from purchasing data).
2. **Sales of the products a vendor supplies:** revenue and margin of products by their **preferred or primary vendor** (a product-to-vendor link that exists in the catalogue and in vendor items).
3. **Sales traced to the vendor's actual deliveries:** exact when stock is tracked by batch or lot (a later module); until then the report states it is *by primary vendor* and shows the share of units that could not be attributed (products with several vendors). It never presents an estimate as exact.

Supplier reports include **margin by supplier**, **supplier concentration** (share of cost of goods by vendor, risk flag above a threshold), **price change impact** (how much a supplier's price rises cost this month), **savings against RFQ**, and **supplier comparison** of the same product across vendors (price, lead time, reliability).

### 18.3 The comparison engine

Comparison is a service, not a feature of one chart. Any report that has a measure can be compared with:

| Comparison | Examples |
|---|---|
| **Time** | Previous period, same period last year, same weekday last year, trailing 12 months, year to date against last year to date, rolling 4 weeks, custom period |
| **Plan** | Budget (a chosen version), forecast, target |
| **Peer** | Branch against branch, branch against the company average or best branch, salesperson against team, product against category, customer against group, vendor against vendor |
| **Cohort** | Customers acquired in the same month, products launched in the same quarter |
| **Benchmark** | Against the company's own history percentile (best month ever, 90th percentile) |

Comparison results always show **absolute and percentage difference**, handle zero and missing bases without nonsense percentages, align calendar periods correctly (leap days, fiscal calendars of any shape, trading-day adjusted comparison for months with different weekdays), and offer a **variance bridge** (waterfall) that splits the change into **volume, price, mix, discount and exchange rate** so the answer to "why" is on the page. All comparison maths is pure and property-tested (periods never overlap, bridges sum to the total difference to the cent).

### 18.4 The "everything by everything" rule

Every additive measure can be grouped by every dimension for which it makes sense (the catalogue lists the valid pairs), with drill from any group to its components and finally to the documents, and the grouping chosen is in the address. This is what turns a hundred named reports into thousands of useful views without a thousand screens.

## 19. People (HR) reports: Kenya first, built for Africa

### 19.1 Principle

The HR module is end to end and not yet built. Reports are designed so it can arrive without rework: **employees, departments, positions, grades and branches are dimensions**; attendance, leave, payroll runs, benefits, loans and appraisals are **facts**. Everything country-specific is a **localisation pack** (core finance section 4.3), never code: a country pack carries the statutory deductions and their bands, the filing forms and returns, the public holidays, the leave rules and the pay-slip layout, each **effective-dated**, so a payslip for an old month is reproduced with the rules of that month.

### 19.2 Kenya pack (first)

Rates and bands change by law and must be **entered as dated data from the current authority publications and verified by a qualified practitioner before go-live; none is hard-coded and none in this document is a rate**. The pack covers: PAYE with its bands and personal and other reliefs; **NSSF** contributions in their tiers and limits; **SHIF** (social health insurance); the **Affordable Housing Levy**; **NITA** levy; other statutory and voluntary deductions; pension and provident fund treatment; benefits in kind and their taxable value; and the filings and certificates payroll produces (the annual tax deduction card, the employer's annual return, monthly PAYE return and the schedules for NSSF, SHIF and the levy) as report layouts in the pack.

### 19.3 Reports

- **People and organisation:** headcount by branch, department, grade, contract type and gender; turnover and retention (leavers, tenure, reasons), new hires, vacancies, span of control, organisation chart as of a date, probation and contract expiry, work-permit and certification expiry.
- **Time and attendance:** attendance and lateness, absence patterns, overtime by person and cost, shift coverage against sales (staffing against the hourly sales heat map), leave taken and balances, **leave liability** (accrued leave value for the books), public-holiday work.
- **Payroll:** payroll register, **payslips**, payroll journal (ties to the payroll accounts in the GL), cost by branch, department, project and dimension, gross to net bridge, employer cost, statutory deductions by authority with the **filing schedules**, bank and mobile-money payment files and their reconciliation, loans and advances outstanding, variance month on month with reasons (new hire, leaver, overtime, rate change), **off-cycle and reversed runs**.
- **Productivity and cost:** **sales per employee**, **labour cost as a percentage of sales** by branch and hour, commission and incentive reports linked to targets (section 16), cost per head, revenue per head, absence cost.
- **Talent:** recruitment funnel and time to hire, training hours and certification status, appraisal completion and ratings distribution, succession and flight-risk flags where the company uses them.
- **Compliance and audit:** statutory filing calendar and status, who viewed or exported payroll, pay changes and approvals trail, segregation of duties on pay changes, missing statutory numbers (tax PIN, NSSF and SHIF numbers) worklist.

### 19.4 Safety (the most sensitive data in the system)

Payroll and personal data have their own permission family (`report_hr_*`), **column-level hiding** (pay, bank, ID numbers, health data), branch and department scope, masking by default, every view and export audited, exports watermarked and expiring, no pay in any shared saved view, no pay in email attachments, and a data-protection retention rule per country pack (Kenya's data protection law applies to employee data). Roles that may see headcount may not see pay.

### 19.5 Scope

Kenya only. Because the rules live in a dated pack and not in code, another country can be added later as data without redesign, but nothing for another country is designed or built until the owner asks.

## 20. Competing with the best in the world

The aim is a reporting module that a buyer who has used the best systems from America, Europe, China and Asia would still choose, and that wins in Africa because it understands how trade really works here.

### 20.1 The field (to be verified hands-on, see R-0a)

| Region | Systems to measure against | What they are known for in reporting (to confirm by trial, not assumed) |
|---|---|---|
| **America** | NetSuite, QuickBooks, Square, Shopify POS, Lightspeed, Toast, Vend | Saved searches and dashboards, financial statements and budgets (NetSuite); simple owner dashboards (QuickBooks, Square); retail analytics and employee reporting (Lightspeed, Shopify) |
| **Europe** | SAP Business One, Microsoft Dynamics 365 Business Central, Odoo, Sage, Xero | Statutory financial reporting and consolidation, account schedules, analysis views (Business Central, SAP); pivot and spreadsheet-style views (Odoo) |
| **China** | Kingdee, Yonyou (UFIDA), and the mobile-first retail and WeChat-linked POS suites | Dense management reports, mobile-first operations, tight integration of retail, payment and loyalty data |
| **Asia** | Zoho (Books, Inventory, Analytics), Tally, Marg, Odoo localisations, Japanese and Korean POS suites | Wide report catalogues, GST-style tax reporting, strong low-cost owner reports, Tally's accountant-friendly drill and keyboard speed |
| **Africa** | Sage, Odoo and local ERP and POS products | Local statutory reporting and mobile-money awareness, but typically shallower analysis and weaker design |

### 20.2 Where we must lead (the advantages that are ours to take)

1. **One platform for wholesale, retail, POS, delivery, vendors, finance and HR**, so a report can follow a shilling from a quote to a payslip with no export between tools. Most competitors reach this only by integrating several products.
2. **Mobile money and informal-economy reality built in:** M-Pesa and other mobile-money reconciliation, till and rider cash custody, customer credit and credit limits, wallet liability, multi-branch cash, offline selling, with reports for each (cash-in-transit, unreconciled mobile money, fees, agent float).
3. **Statutory by pack:** eTIMS and VAT today, other African regimes by pack, payroll statutory returns per country: a depth foreign tools lack and local tools rarely extend across borders.
4. **Explained numbers:** one definition per measure, tie-out to the books on every report, findings in words, variance bridges. The best systems show numbers; we show why and prove them.
5. **Premium, fast and accessible on a modest phone and a poor connection:** streamed, cached, offline-tolerant, installable, with small payloads (the owner in a town with a weak signal gets yesterday in numbers).
6. **Built-in budgets, targets and forecasting** for every size of business, not only enterprise editions.
7. **Locale-ready:** English now, with the message catalogue and locale formatting of decision 12 so other languages can follow without a rewrite; Kenyan number and date formats, holidays and calendars.

### 20.3 Method: not feature counting, but outcomes

- **R-0a Benchmark study (first task of the slice, before any screen):** trial or study the leading systems in each region against a **scorecard** of about 150 questions grouped as in section 6 (can it answer *this* question, in how many clicks, how fast with a year of data, how it looks on a phone, how it exports, who may see it, whether it ties to the books). The result is a table in this folder that decides what is built first and what we deliberately do better. No claim in this section about another product is final until that study confirms it.
- **Ten buyer questions per persona** (owner, branch manager, cashier supervisor, accountant, buyer, warehouse lead, dispatcher, HR officer, auditor, bank or investor reading a pack) turned into acceptance tests: "within three clicks and under two seconds, show me X".
- **Pilot with real data** from a real distributor and a real retailer (with their consent) to see which reports they open weekly, and which they never do, then remove or fix.
- **Usage analytics on reports** (section 6.11) feed a continuing improvement loop: slow reports, unused reports, repeated exports (a sign a report lacks a column).

### 20.3a R-0a first pass: what it added

The documentation pass is in [`reports-benchmark.md`](reports-benchmark.md) (150-question scorecard, sources, confidence; it is not a hands-on trial). It added these requirements to this design, none of which change the architecture:

1. **VAT return readiness view:** every document in a tax period shown as included, needing correction (missing PIN, unsigned, wrong rate) or excluded, each drillable (section 17).
2. **Keyboard drill on every table line** down to the source document, with a detail toggle (section 15.2, consistency kit).
3. **Exception and activity reports** as a named family: voids, refunds, discounts, price overrides, stock adjustments by person, branch and hour, with thresholds and alerts (section 6.3 and 6.11).
4. **Retail performance measures:** customer capture rate, upsell percentage, sales by hour of day, margin alert, sell-through, GMROI, each with a catalogue rule (section 6.2 and 6.4).
5. **Sales and delivery on a map** using zones and branch pins (section 6.2 and 6.8).
6. **Inventory ageing with company-set bands** (section 6.4).
7. **Every measure definition states which document states count** (drafts, held, cancelled and failed excluded) (section 3, principle 1).
8. **No feature tiers inside reports:** custom reports, goals, schedules and exports are for every customer; permissions govern access (section 10).
9. **Time-limited report permissions:** a grant may carry a look-back limit (section 10).
10. **Kenya payroll forms checklist** (PAYE return, P9 certificates, fringe benefit, housing levy and other levy reports) to be confirmed against each authority's current form before building (section 19.2).

### 20.4 What we will not do

Add a report because a competitor has it without a question it answers; ship a chart that cannot be read on a phone or by a screen reader; show a number we cannot tie to the books or explain; hide a stale figure; or copy a competitor's layout without understanding the decision it supports.
