# Sales Order Platform — Architecture Blueprint

**Status:** DRAFT for approval. Nothing in this document is built yet.
**Scope:** the complete order-to-cash flow (inquiry → quotation → sales order → delivery → pick/pack → goods issue → billing → payment → closed, plus returns and credit/debit memos), POS and omnichannel, warehouse management, and a Business Central–style approval framework.
**Reading guide:** §1–§4 are the rules every line of code must obey. §5 is the approval framework. §6–§11 are the domains. §12 maps every item of the agreed flow to a component and a phase. §14 lists the decisions I need before Phase 0 starts.

---

## 1. Non-negotiable principles

Each principle has a **trade-off we knowingly accept**. If a change cannot honour a principle, it needs an ADR (§3.4) that says so out loud.

| #   | Principle                                                                  | What it means in code                                                                                                                                                                                           | Trade-off accepted                                                                                          |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| P1  | **Everything explains itself**                                             | Every state change records _who_, _what_, _when_, _why_ (reason code + free text), _which rule/policy version_, and a _snapshot of the inputs it used_.                                                         | Extra writes per action (~1 row per transition). Cheap next to the cost of an unexplainable money movement. |
| P2  | **One door per capability**                                                | Each business action (create order, reserve stock, issue credit, request approval, sign with KRA) has exactly one application service. UI, API, jobs and imports all call it.                                   | Less flexibility for "quick" shortcuts. That is the point.                                                  |
| P3  | **Documents are state machines**                                           | A document's status changes only through `transition(document, event, actor, reason)`. Illegal transitions are impossible, not merely unlikely.                                                                 | A declared transition table for every document type.                                                        |
| P4  | **Facts are append-only**                                                  | Stock movements, ledger entries, approval history, decision log and domain events are never updated or deleted. Corrections are new rows that reference the old ones.                                           | Storage grows; handled by partitioning and archival (§4.7).                                                 |
| P5  | **Commands are idempotent, events are at-least-once**                      | Every command carries an idempotency key. Events are published through a transactional outbox and consumers tolerate duplicates.                                                                                | Consumers must be written defensively; we provide the harness.                                              |
| P6  | **Side effects never block the sale**                                      | KRA signing, email, notifications, search indexing and analytics run after commit through the outbox. Their failures are recorded and retried, never rolled back into the sale. (Already true for KRA signing.) | Eventual consistency for those effects, made visible in the UI.                                             |
| P7  | **Money is exact**                                                         | Decimal arithmetic only, one rounding policy per currency, amounts stored as `numeric(19,4)`, never floats, always with the currency.                                                                           | Slightly heavier arithmetic.                                                                                |
| P8  | **Bounded contexts own their tables**                                      | A context writes only its own tables. Others read through its service or its published events.                                                                                                                  | Some duplication of read data (projections).                                                                |
| P9  | **Policy is data when the business must change it, code when it must not** | Pricing rules, approval workflows, credit rules, number series and blocks are configurable and versioned. Posting, tax and state-machine rules are code.                                                        | A configuration surface to build and test.                                                                  |
| P10 | **Failure is designed in**                                                 | Timeouts, retries with backoff, dead-letter queues, circuit breakers on external systems, bulkheaded worker queues, graceful degradation, runbooks.                                                             | More moving parts than a naive CRUD app.                                                                    |

---

## 2. Capacity model and service-level objectives

KES 100 billion per month is large in value but not necessarily in request volume. What matters is orders, lines and concurrency, which I do not yet have (§14, question 1). Two bracketing scenarios, so the design is sized honestly:

|                                                                                               | Average order KES 20,000 | Average order KES 5,000 |
| --------------------------------------------------------------------------------------------- | ------------------------ | ----------------------- |
| Orders / month                                                                                | 5 million                | 20 million              |
| Average rate                                                                                  | ~2 orders/s              | ~8 orders/s             |
| Peak (assume 50× burst: month-end, promotions, payroll days)                                  | ~100 orders/s            | ~400 orders/s           |
| Rows written per order (header, ~8 lines, schedules, reservations, approvals, events, outbox) | ~60                      | ~60                     |
| Peak row writes                                                                               | ~6,000/s                 | ~24,000/s               |

Postgres handles the first comfortably and the second with discipline: narrow rows, no hot rows, time-partitioned append-only tables, batched outbox publication, read replicas for reporting, and connection pooling. **The single biggest threat is not volume, it is contention**: today stock is one integer per product, so every sale of a popular product updates the same row. §7 fixes that.

**Proposed SLOs (to be confirmed)**

| Operation                                                            | Target (p99)                         |
| -------------------------------------------------------------------- | ------------------------------------ |
| Save a sales order (price, tax, availability, credit check included) | < 800 ms                             |
| Reserve stock for an order line                                      | < 150 ms                             |
| Open an order, a list of 50 orders, an approval inbox                | < 300 ms                             |
| Outbox → consumer lag                                                | < 5 s (p99)                          |
| Availability of order entry                                          | 99.95%                               |
| Data loss on committed documents (RPO)                               | 0 (synchronous commit; PITR backups) |

**Gate rule:** no phase is "done" until its load test, at 2× the agreed peak, meets these numbers. We will not assert scale; we will measure it.

---

## 3. Architecture

### 3.1 Style: modular monolith, microservice-ready

One deployable, strictly separated contexts, communicating through services and events. This is the right trade-off here: a distributed system adds network failure modes, distributed transactions and operational cost that a single Postgres-backed monolith avoids, while the boundaries below let us extract a context later (inventory and fulfilment first) without rewriting it.

**Rejected:** microservices from day one (operational cost, no proven need); event sourcing for everything (replay and schema-evolution burden). Event sourcing is used only where history _is_ the product: approvals, stock movements, ledger, decision log.

### 3.2 Context map

```
                    ┌────────────────────────── Platform kernel ──────────────────────────┐
                    │ Decision log · State machines · Outbox/events · Idempotency · Numbering│
                    │ Approvals (workflow engine) · Notifications · Access control · Audit  │
                    └────────────────────────────────────────────────────────────────────────┘
 Catalog & Customer master ──► SALES (inquiry, quote, sales order, with Pricing inside it) ──► Credit
                                               │            │                         │
                                               │            ▼                         │
                                               │   Inventory (ledger, ATP, reserve)   │
                                               │            │                         │
                                               ▼            ▼                         │
                                       Fulfilment (delivery, pick, pack, ship, goods issue)
                                                        │
                                                        ▼
                                Billing ──► Receivables (payments, allocation, dunning)
                                   │
                                   ├──► Fiscal (KRA eTIMS/TIMS signing)   [built]
                                   └──► Returns ──► Credit/Debit memos ──► Fiscal  [credit notes built]
 POS (shifts, tills, tenders) ──► Sales / Billing / Inventory   ·   Omnichannel (BOPIS, ship-from-store)
```

### 3.3 Layering inside every context

```
domain/        pure TypeScript: entities, value objects, state machines, policies. No I/O. 100% unit-testable.
application/   use cases ("one door" services): transaction boundary, idempotency, authorization, emits events.
infrastructure/ repositories (Drizzle), outbox publisher, adapters (KRA, email), read-model projectors.
interface/     server actions, route handlers, UI. Calls application services only.
```

Dependency rule: `interface → application → domain ← infrastructure`. Enforced by lint (boundary rules), not by convention.

### 3.4 Patterns, why, and what they cost

| Pattern                                                   | Why here                                                                                           | Cost we accept                                       | Rejected alternative                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| **Transactional outbox**                                  | Atomically commit a change and its event; publish after. Gives P5/P6 without two-phase commit.     | A publisher worker and consumer idempotency.         | Publish in-request (loses events on crash); distributed transactions. |
| **State machine per document**                            | Makes illegal states unrepresentable; the transition table _is_ the documentation.                 | Declaring every transition.                          | Free-form status columns edited anywhere.                             |
| **Aggregate + optimistic concurrency** (`version` column) | Sales order is edited by many people; lost updates must be impossible without locking.             | Retry-on-conflict UX ("this order changed, review"). | Last-write-wins; long pessimistic locks.                              |
| **Append-only ledger + balance projection**               | Stock and money are facts; balances are derived and rebuildable.                                   | Projection maintenance.                              | Mutating counters (current model; hot rows, no history).              |
| **CQRS read models** (selective)                          | Order lists, approval inboxes, dashboards must stay fast regardless of write load.                 | Projection lag (seconds) and rebuild tooling.        | Querying normalised write tables for screens.                         |
| **Specification/Policy objects with traces**              | Pricing, credit, approval selection, availability return _an answer and the reasons_ (P1).         | Every rule returns a trace; slightly more code.      | Boolean checks scattered in services.                                 |
| **Ports & adapters**                                      | KRA, email, payment gateways, courier APIs replaceable and testable.                               | Interfaces to maintain.                              | Calling SDKs directly from domain code.                               |
| **Saga / process manager** for multi-step flows           | Order → reserve → approve → deliver → bill spans contexts and time; compensation must be explicit. | A durable process state per order.                   | Chained synchronous calls.                                            |
| **Architecture Decision Records**                         | A decision that is expensive to reverse gets one page: context, options, decision, consequences.   | Writing discipline.                                  | Tribal knowledge.                                                     |

### 3.5 Reliability toolkit (applies everywhere)

Idempotency keys on commands · outbox with `FOR UPDATE SKIP LOCKED` batch publishing · retry with exponential backoff and jitter · dead-letter queue with an operator screen · circuit breaker around every external call · separate worker queues (bulkheads) so a KRA outage cannot starve order processing · health checks that test real dependencies · structured logs with a **correlation id** carried through commands, events, jobs and external calls · OpenTelemetry traces · feature flags for risky rollouts · expand/contract migrations (no breaking schema change in one step) · point-in-time-recovery backups tested by restore drills · runbooks per alert.

---

## 4. Platform kernel (built first)

### 4.1 Decision log — "everything records why"

One append-only table (`decision_log`, partitioned monthly), written by the kernel, not by feature code:

`id · occurred_at · correlation_id · causation_id · subject_type · subject_id · action · actor_type (user/system/job/integration) · actor_id · reason_code · reason_text · policy_id · policy_version · inputs (jsonb snapshot) · outcome (jsonb) · before/after status`

**Reason codes are a controlled catalogue** (`reason_codes` table: code, meaning, applicable actions, whether free text is mandatory). A user can never get a transition through with "no reason" where policy requires one. The existing `kra_signing_events` becomes a specialisation of this log; its gate-by-gate trace is the model for every policy trace.

### 4.2 State-machine kit

`defineStateMachine({ states, events, transitions: { from, event, to, guard?, effects[] } })`. `transition()` does, in one transaction: load with version → check legal → run guard (returns trace) → apply → write decision-log row → write outbox events → commit. Guards cannot do I/O except through injected, read-only ports, so a transition is deterministic and replayable in tests.

### 4.3 Outbox, events and idempotency

`outbox(id, aggregate_type, aggregate_id, event_type, schema_version, payload, created_at, published_at)` plus `processed_events(consumer, event_id)` for consumer dedupe. Events are **versioned and additive**; consumers ignore unknown fields. Command idempotency: `idempotency_keys(key, command, result_ref, expires_at)`.

### 4.4 Number series (modelled on Business Central, made friendlier and more scalable)

**Concepts kept from Business Central:** a _No. Series_ has one or more _lines_; each line has a starting and ending number, a starting date, an increment, a warning threshold and a last-used number; series are bound to document types in a setup page; _manual numbers_ can be allowed per series; _date order_ can be enforced; _related series_ let a document offer alternatives; and a series can _allow gaps_ in exchange for speed.

**What we improve:**

| Business Central                                    | Ours                                                                                                                                                                  | Why                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| New line each year, by hand                         | **Reset policy** (never / yearly / monthly) with `{YYYY}`, `{MM}` tokens: counters per period are created automatically                                               | No year-end admin task; no "series ran out on 1 January" incident            |
| Prefix typed into the number                        | Separate `prefix`, `suffix`, `digits`, with tokens `{YYYY} {YY} {MM} {BRANCH}`                                                                                        | Admins see structure; examples are generated, not guessed                    |
| Per-company series; branch handled by many series   | A line can be **scoped to a branch**; the most specific open line wins                                                                                                | One series "INV" serves all branches with their own counters                 |
| Gap-free vs "allow gaps" is a global feature toggle | **Per series**: _gap-free_ (counter row locked inside the document's own transaction) or _allow-gaps_ (counters hand out **blocks** per app instance, held in memory) | Fiscal documents stay gap-free; high-volume internal documents never contend |
| Opaque errors                                       | Every allocation returns a **trace** (lines considered, why each was rejected) and there is a **live preview** of the next number                                     | "Why did it not number my document?" is answerable                           |
| Setup scattered across modules                      | **One binding table**: document kind → series, with optional per-branch override                                                                                      | One place to see how everything is numbered                                  |

**Scalability model.** _Gap-free_: `UPDATE … SET last_no = last_no + increment … RETURNING` on the counter row **inside the caller's transaction**, so a rollback releases the number; contention is per counter, and counters split per branch and per period, so independent branches never wait on each other. _Allow-gaps_: a counter hands out a block (default 50) in its own short transaction and the app instance serves numbers from memory; a crash loses at most the unused remainder of a block (a recorded, accepted gap). Both paths insert an allocation row with a **unique** `(series, number)` constraint, so a duplicate number is impossible whatever goes wrong.

**Rules.** Fiscal document kinds (tax invoice, credit note, POS receipt) may only be bound to gap-free series (enforced at binding time). Date order, when on, rejects a document dated before the last one numbered in that counter. A line's prefix, suffix, digits and start number are frozen once its first number is issued. Lines for the same series and branch scope may not overlap in dates. A warning threshold raises a notification; exhaustion blocks numbering with a clear reason, never a duplicate. Every configuration change and every allocation is recorded (§4.1).

### 4.5 Concurrency and locking policy

Optimistic `version` on aggregates; row locks only for scarce resources (stock allocation, number allocation) and always `NOWAIT`/`SKIP LOCKED` with bounded retry, never unbounded waits.

### 4.6 Money

`Money(amount: Decimal, currency)` value object; one place for rounding (`round_half_even` per currency policy); totals computed in the domain, **stored with their components** so any total can be re-derived and audited. Foreign-currency documents store the rate used and its source (this closes the gap that currently makes non-KES invoices fail to sign).

### 4.6a Multi-currency and the country master

Multi-currency is a foundation, not a feature: every monetary amount carries its currency, every document stores the **exchange rate and its source** (rate table, manual, or document-fixed), and totals are held in both document currency and base currency (KES).

**Country is a dimension, extended by a `countries` master** (the same pattern as dimension values linked to branches): a dimension value of the _country_ dimension links to a row in `countries`, which carries `iso2`, `iso3`, `iso_numeric`, `name`, `official_name`, `nationality`, `currency_code`, **`kra_country_code`** (eTIMS), `calling_code`, `region`, trade-bloc flags (EAC, COMESA…), `address_format`, `postal_code_pattern`, `default_locale`, `default_timezone`, `is_active` and `sort_order`. Rate sources, price lists, tax jurisdictions and customer addresses refer to the country master, never to free text. The eTIMS country code list shipped with KRA's code definitions seeds the KRA column; other columns import from CSV.

### 4.7 Data lifecycle

Monthly range partitions for decision log, outbox, stock movements, ledger entries, approval history, order events. Hot window on fast storage; older partitions detached and archived, never deleted if fiscal. Retention is a per-table policy, recorded.

---

## 5. Approval framework (modelled on Dynamics 365 Business Central)

The aim: **one approval entry per approval step, and that single record, together with its append-only history, answers every question anyone can ask about the approval.**

### 5.1 Concepts (BC → ours)

| Business Central                                                                                                                            | Ours                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Workflow (template + steps: _When event → Then response_)                                                                                   | `workflows`, `workflow_steps` (versioned)                                            |
| Workflow events (document created, approval requested, approved, rejected, delegated, cancelled, released…)                                 | `workflow_events` catalogue, raised by state-machine transitions via the outbox      |
| Workflow responses (create approval request, send notification, release document, set pending, cancel/reject all requests, restrict usage…) | `workflow_responses` catalogue, each a registered handler                            |
| Workflow event conditions (e.g. amount > 500,000, customer group = X)                                                                       | `workflow_step_conditions` over document fields                                      |
| Workflow step instance (runtime state of a step)                                                                                            | `workflow_step_instances` (inactive / active / completed / ignored)                  |
| Approval User Setup (approver, **approval limits**, unlimited flags, **substitute**)                                                        | `approval_user_setup`                                                                |
| Workflow User Group (ordered set of approvers)                                                                                              | `workflow_user_groups` + `workflow_user_group_members(sequence)`                     |
| Approver type: Salesperson, **Approver (chain)**, Workflow user group                                                                       | same three                                                                           |
| Approver limit type: **Approver chain**, **First qualified approver**, **Specific approver**                                                | same three                                                                           |
| **Approval Entry**                                                                                                                          | `approval_entries` (the single record)                                               |
| Approval Comment Line                                                                                                                       | `approval_comments`                                                                  |
| Posted Approval Entry (history kept after the document is posted)                                                                           | entries are never deleted; a document's close archives them to the history partition |
| Overdue Approval Entry / notification entries                                                                                               | `approval_overdue`, `notifications`                                                  |
| Document status Open → Pending Approval → Released                                                                                          | the sales order's _approval status_ (§6.4)                                           |

### 5.2 The single approval entry

`approval_entries` — one row per (document, sequence, approver):

| Question                          | Column(s)                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What** is being approved?       | `document_type`, `document_id`, `document_no`, `record_ref`, `amount`, `currency`, `amount_base` (KES), `document_snapshot` (the values as they were when requested)                           |
| **Why** was approval needed?      | `trigger_reason_code`, `trigger_detail` (e.g. "discount 18% > allowed 10%; order value 2.4M > Sales Rep limit 1.0M"), `workflow_id`, `workflow_version`, `workflow_step_id`, `condition_trace` |
| **From whom**?                    | `sender_id`, `sender_role`, `on_behalf_of`                                                                                                                                                     |
| **To whom**? Why _this_ approver? | `approver_id`, `approver_type`, `limit_type`, `approver_selection_trace` (which limit or group matched, which chain was walked, why this person), `substitute_for`                             |
| In what **order**?                | `sequence_no`, `total_steps`, `previous_entry_id`                                                                                                                                              |
| **Status**                        | `status` ∈ Created · Open · Approved · Rejected · Cancelled · (Expired)                                                                                                                        |
| **When**?                         | `created_at`, `sent_at`, `due_at`, `decided_at`, `last_modified_at`, `last_modified_by`                                                                                                        |
| **How** did it end?               | `decision`, `decision_reason_code`, `decision_comment`, `decided_by`, `decided_via` (UI/email/API), `delegated_from/to`                                                                        |
| **Control**                       | `limit_snapshot` (approver's limit at the time), `segregation_check` (creator ≠ approver, recorded)                                                                                            |
| **Related**                       | `correlation_id`, `decision_log_id`, `escalated_from_entry_id`                                                                                                                                 |

`approval_entry_events` (append-only) records every change to the entry: created, sent, viewed, commented, delegated, escalated, reminder sent, approved, rejected, cancelled, expired — with actor, time and reason. **An entry's current columns are a projection of its events**, so "who did what, in what order, and why" is always answerable and tamper-evident.

### 5.3 Behaviour (the BC semantics)

1. **Request:** `request_approval` is a transition on the document (P3). It fires the workflow event; the workflow's responses create the entries (all for parallel, first for sequential), set the document to _Pending approval_ and **lock it from editing** (BC "restrict record usage").
2. **Priority and lazy creation.** Approvers are assigned _in the workflow_ (a user, a role or a user group), each with a **priority (sequence)**. Only the entry for the **lowest open priority is created**; the entry for the next priority is created **at the moment the previous one is approved**, so an approver never sees (or acts on) a request that is not yet theirs. Equal priority means _parallel_ (all must approve, or "any one", per the step's rule).
   **Approver selection** is deterministic and traced:
   - _Approver chain:_ walk the sender's approver chain up until someone's limit covers the amount, creating an entry per hop.
   - _First qualified approver:_ the first up the chain whose limit covers it.
   - _Specific approver / workflow user group:_ the named person, or the group in sequence order.
   - If the approver is absent, **substitute** is used and recorded; if no one qualifies the document **cannot be submitted** and says exactly why (never a silent bypass).
3. **Decide:** approve → create the next priority's entry, or release the document when none remain; **reject → the complete rejection flow:** the rejecting entry records a mandatory reason; every other open and not-yet-created entry is closed (_cancelled by rejection_, each with the cause); earlier approvers' decisions are kept as history; the document returns to _Open_ (editable) with the rejection reason and who rejected shown prominently; the sender is notified; re-submitting starts a **new approval round** (round number recorded) linked to the rejected one; **delegate** → new entry for the delegate, original marked delegated; **cancel** (by sender) → all entries cancelled with a reason.
4. **Time:** each entry has a `due_at`; overdue entries produce reminders and, per workflow, **escalate** to the next in chain (recorded, with the reason "overdue").
5. **Segregation of duties:** the sender can never approve their own request; enforced and recorded.
6. **Change after approval:** editing a released document in a way that touches approval-relevant fields (amount, discount, customer, terms) re-opens approval, linked to the earlier entries.
7. **Everything is a workflow:** discount approvals, credit release, price override, delivery block release, billing block release, return authorisation, credit memo approval, manual stock adjustment, large refund — all use the same engine, configured not coded.

### 5.4 Approval UX (BC-faithful, improved)

- **Requests to Approve** (approver's inbox): sorted by due date, shows document, amount, sender, _why it needs approval_, how long it has waited; approve/reject/delegate inline with a required reason where policy says so; bulk actions for low-risk items.
- **My Approval Requests** (sender): status per step, who it is waiting on, when it is due, a "nudge" action.
- **Approval entries log** (finance/audit): filter by document, sender, approver, status, date, workflow, reason; export. Opening any entry shows its full event timeline and the policy trace.
- On the **document itself** (fact box): current approval chain as a timeline, with status chips and reasons.
- Notifications by email, in-app, and (later) mobile push; actionable from the message.

---

## 6. Sales domain

### 6.1 Documents and links (document flow)

`inquiry → quotation → sales order → delivery → billing document → (payment)` and `returns order → return delivery → credit memo`. Every document stores `predecessor_id` and `predecessor_type`, and a `document_flow` view lets any document show everything before and after it, with status. A **line** also records which source line it came from, so partial quantities trace exactly.

### 6.2 Order types (a table, not code branches)

`order_types(code, behaviour flags…)`: Standard · Cash sale (delivered and paid immediately) · Rush · Returns · Contract/blanket with call-offs · Consignment · Third-party drop-ship · Intercompany. Flags decide: allows partial delivery, requires credit check, creates delivery automatically, billing relevance, default blocks, number series, which approval workflows apply.

### 6.3 Header, partners, lines, schedule lines

- **Header:** sales organisation, channel, branch/warehouse, currency and rate, payment terms, incoterms, requested delivery date, shipping condition, customer PO number, notes, dimensions.
- **Partners (roles):** sold-to, ship-to, bill-to, payer — each a customer or address with validity and defaults.
- **Lines:** product, quantity + unit of measure (with conversions), price with full pricing trace, discounts, tax, ship-from location, requested date, line status.
- **Schedule lines:** each line splits into dated deliveries (date, quantity, confirmed quantity, reason if confirmed < requested). Partial delivery and backorder are _states of schedule lines_, not special cases.

### 6.4 Status model (several independent statuses, as in SAP)

Overall (open → confirmed → in delivery → partially delivered → delivered → partially billed → billed → closed; cancelled) plus **separate** approval status, credit status, delivery status, billing status, and block status. Every status has a transition table, a reason requirement, and shows in the UI as a chip so "why is this order stuck?" is one glance. **Every status and stage has a server timestamp, from the moment the user initiates checkout (a refused attempt included) until the order succeeds or fails; the design is in [order-stage-timeline.md](./order-stage-timeline.md).** Stock per location, which this section assumes, is designed in [stock-locations.md](./stock-locations.md); delivery in [delivery-module.md](./delivery-module.md).

### 6.5 What happens on save (the pipeline)

An ordered, replayable pipeline; each stage returns _result + trace_; the order stores the combined trace (this is the "why" for price, tax, availability and credit):

1. **Pricing** (condition technique): price lists, customer/group prices, quantity breaks, promotions, order- and line-level discounts, surcharges, rebates. Each step records the condition, its source, the value and why it applied. Overrides need a reason and may need approval.
2. **Tax determination:** by product, customer, place of supply; includes the KRA code mapping already built.
3. **Availability check (ATP):** requested date vs. stock; outcome per schedule line: confirm, partial, backorder, substitute, reject; each with the reason.
4. **Credit check:** limit, overdue invoices, open-order exposure. Outcomes: pass, warn, block (credit hold with release workflow).
5. **Approval determination:** which workflows apply (discount, margin, size, price override…), producing approval entries (§5).
6. **Blocks:** delivery block, billing block, credit hold — each with reason, owner, release workflow.
7. **Output:** confirmation/proforma generated and sent (outbox).

### 6.6 Quote → order, inquiry

Inquiry and quotation reuse the same document engine (types, partners, lines, pricing) with their own state machines (quote: draft → sent → accepted → converted/expired/lost, with _lost reason_). Conversion copies lines and links source; the quote's proforma is never signed (policy already built).

---

## 7. Inventory (the scale-critical context)

- **Locations:** stock is held per **location**, and a location is a **warehouse or a branch** (a `locations` table with `kind`, linked to the branch where applicable; a branch may hold stock directly or draw on a warehouse, per its sourcing setting).
- **Ledger:** `stock_movements` (append-only, monthly partitions): product, location (warehouse/bin), batch/serial (later), quantity, movement type, document ref, reason code, cost.
- **Balances:** `stock_balances(product, location, on_hand, reserved, …)` as a _projection_ of the ledger, **sharded by location** so popular products do not funnel into one row; a location can be further split into N counters (`shard`) if a single location is hot. Reads sum shards; writes pick a shard with `SKIP LOCKED`.
- **Reservations/allocations:** `stock_reservations(order_line, schedule_line, location, qty, status, expires_at)`. Reserving is a bounded-wait transaction; if a shard is locked it tries another.
- **ATP service:** "available to promise" = on-hand − reserved + inbound (purchase orders/transfers) by date; returns per-location availability and the _trace_.
- **Goods issue** converts a reservation into a movement and posts cost of sales; **goods receipt, transfer, adjustment, count** are movement types with mandatory reason codes. Manual adjustments above a threshold use approval (§5).
- **Migration from today:** the current `products.stock_quantity` becomes the opening balance of a default location; a reconciliation job proves ledger sum = old counter before cutover.

---

## 8. Fulfilment / warehouse management

`delivery` (created from one or more orders/schedule lines; **not** an invoice) → `pick task(s)` (bin, quantity, strategy FEFO/FIFO, wave/batch) → pick confirmation → `packing` (packages, weights, packing list) → `shipment` (courier, tracking) → **post goods issue** (stock leaves, cost posted, delivery status updates, billing becomes due). Shortage at pick: partial pick, backorder the short quantity (schedule line re-planned), or cancel it, each with a reason. Phase 5 adds bins, batches, expiry and serials, wave planning, cycle counts, putaway and replenishment. Each document has its own state machine and decision-log trail.

---

## 9. Billing, receivables, fiscal

- **Billing document** is a separate document from the order: per delivery, consolidated across deliveries, split by payer, or by billing plan (milestones, down payments). It is the **signable document** for KRA (the signing service's source kind extends to `billing`), with the existing gates, trace and "never blocks" guarantee.
- **Receivables:** payments, cash application, partial payments and allocation to invoices, overdue and dunning levels (each level a configured, traced action), write-offs through approval.
- **Credit and debit memos:** a _credit memo request_ goes through review and approval, then creates the credit note using the single credit-note service already built (policies CN-1…CN-14; the accounting rules are now specified in [core-finance-module.md](./core-finance-module.md) §9, awaiting approval). Finance (chart of accounts, general ledger, receivables, customer wallet, refunds) is its own module designed there; billing posts through its journal engine.

## 10. Returns

Returns order (reason code mandatory, authorisation workflow) → return delivery with inspection result → disposition per line (restock / scrap / return to vendor / quarantine) → credit memo request → credit note. Quantities are validated against what was delivered and billed; every step links back to the original lines.

## 11. POS and omnichannel

- **Shift and till:** open with float, tender types (cash, M-Pesa, card, split), cash declaration at close, **X and Z reports**, variance recorded with reason, supervisor override through the approval engine.
- **Cash sale** = order type with delivery and billing created immediately and atomically; the KRA receipt with QR is the signed billing document.
- **Offline mode:** a local queue of idempotent commands with client-generated ids, replayed on reconnection; conflicts surface for review, never silently overwrite.
- **Returns at the till:** find the receipt, validate against it, reason, manager override.
- **Omnichannel:** one customer record and order history across channels; click-and-collect (BOPIS), ship-from-store, and "endless aisle" (sell from another location's stock) are fulfilment strategies on the same order, chosen by an explainable sourcing rule.

---

## 12. Experience principles (what "greatest user experience" means here)

1. **Speed you can feel:** list and document screens read projections; documents open in < 300 ms; line entry is keyboard-first with instant local feedback and server validation behind it.
2. **Never lose work:** drafts autosave; optimistic concurrency conflicts show a field-level diff, not a generic error.
3. **Always say why:** every block, price, availability result, credit decision and approval requirement has a "Why?" affordance showing its trace in plain language.
4. **One glance status:** status chips for each status dimension; a document timeline combining document flow, approvals and decisions.
5. **Fact boxes** on every document (customer credit, stock availability, history, approvals), as in Business Central.
6. **Fix in place:** an error says what, why, and offers the next action (release credit hold, request approval, choose substitute).
7. **Responsive and accessible** (existing standing rule): phone to desktop, WCAG AA, keyboard complete.
8. **Resilient by design:** KRA down, courier down, email down — the sale and its documents still complete, and the UI shows the pending effect with a retry.

---

## 13. Traceability matrix — every element of the agreed flow

| Element (from the agreed flow)                                                 | Component                                   | Phase                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------- |
| Inquiry, Quotation                                                             | Sales: document engine, quote state machine | 1                                      |
| Sales order, order types                                                       | Sales: `order_types` table-driven behaviour | 1                                      |
| Partners: sold-to, ship-to, bill-to, payer                                     | Sales: partner roles                        | 1                                      |
| Header (org, channel, branch, currency, terms, incoterms, dates, PO, notes)    | Sales: header aggregate                     | 1                                      |
| Lines, units, schedule lines, partial delivery, backorder                      | Sales: lines + schedule lines               | 1 (model), 2 (execution)               |
| Pricing (lists, customer, breaks, promotions, discounts, rebates) with reasons | Pricing engine + trace                      | 1                                      |
| Tax determination (incl. KRA mapping)                                          | Pricing/Tax + Fiscal                        | 1                                      |
| Availability check (confirm/partial/backorder/substitute/reject)               | Inventory ATP                               | 1 (on current stock), 2 (per location) |
| Credit check, credit hold, release                                             | Credit context + approvals                  | 1                                      |
| Approvals (discount, margin, size, credit, price override…)                    | Approval framework (§5)                     | 0–1                                    |
| Blocks (delivery, billing, credit) with reason and release                     | Sales status model                          | 1                                      |
| Output (confirmation, proforma)                                                | Outbox + document rendering                 | 1                                      |
| Document flow, statuses (overall + separate)                                   | Document kernel                             | 1                                      |
| Delivery document                                                              | Fulfilment                                  | 2                                      |
| Picking (waves, bins, FEFO/FIFO, batch/serial)                                 | Fulfilment/WMS                              | 2 (basic), 5 (full)                    |
| Packing, shipping, courier, tracking, packing list                             | Fulfilment                                  | 2                                      |
| Goods issue (stock leaves, cost posted)                                        | Inventory + Fulfilment                      | 2                                      |
| Shortages: partial pick, backorder, cancel                                     | Fulfilment + Sales                          | 2                                      |
| Billing (per delivery, consolidated, split payer, plans)                       | Billing                                     | 2                                      |
| KRA signing of billing documents                                               | Fiscal (built; source extended)             | 2                                      |
| Payment, cash application, overdue, dunning, write-off                         | Receivables                                 | 2–3                                    |
| Returns order, return delivery, inspection, disposition                        | Returns                                     | 3                                      |
| Credit/debit memo request → credit note                                        | Memos + credit-note service (built)         | 3                                      |
| Overall/individual statuses visible at a glance                                | UI status chips                             | 1                                      |
| POS: shifts, tills, tenders, cash declaration, X/Z, offline, returns, receipts | POS                                         | 4                                      |
| Omnichannel: BOPIS, ship-from-store, endless aisle                             | Sourcing rules + fulfilment                 | 4–5                                    |
| Warehouse depth: bins, batches, expiry, serials, waves, counts                 | WMS                                         | 5                                      |
| **Everything records why; everything is traceable**                            | Decision log + traces                       | 0 (kernel)                             |

---

## 14. Delivery plan, gates and decisions

### Phase 0 — Kernel (no business screens; everything depends on it)

Decision log + reason-code catalogue · state-machine kit · outbox/events/idempotency · number series · money value object · approval engine (entities, selection, events, UI) · boundary lint rules · load-test harness · ADR template. **Exit:** kernel load-tested; approval engine demonstrably answers every question in §5.2 from data; two existing flows (KRA signing, credit notes) migrated onto the kernel as proof it fits.

### Phase 1 — Sales order core

Order types, partners, header/lines/schedule lines, pricing with trace, tax, availability on the current stock, credit check and hold, approvals wired, blocks, statuses, document flow, quotes/inquiry. Existing orders migrated by _strangler_ (new aggregate alongside; ecommerce checkout moved over behind the same door).

### Phase 2 — Delivery, goods issue, billing

Per-location stock ledger and balances (this is where the scale fix lands), deliveries, picking/packing/shipping (basic), goods issue, billing documents (KRA signing source extended), receivables basics.

### Phase 3 — Returns and memos

### Phase 4 — POS and omnichannel

### Phase 5 — Warehouse depth

**Every phase exits only when:** unit tests on domain logic, contract tests on ports, property tests on state machines, an end-to-end browser test of its flows (as we have been doing), a load test at 2× peak meeting §2, a migration rehearsal on a production-sized copy, and updated runbooks.

### Decisions taken

| Topic                | Decision                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stock model          | Per **location**, where a location is a warehouse or a branch (§7).                                                                                                                                                                              |
| Approvals            | Approvers assigned in the workflow with **priority**; the next approver's entry is created only when the previous approves; a **complete rejection flow** (§5.3).                                                                                |
| Pricing              | A full configurable sub-module **of Sales** (Sales owns how a customer is priced; the catalogue and the customer master own the groups and kits it uses): customer, customer group, variants, sales types, branch, fixed/contract, route, channel and country prices; discounts, promotions, hampers/bundles, rebates. Design in [pricing-module.md](./pricing-module.md). |
| Currency and country | Multi-currency from the start; country is a dimension extending a `countries` master with currency, nationality, KRA country code and more (§4.6a).                                                                                              |
| Numbering            | Business Central–style number series, more configurable and scalable (§4.4); the first kernel slice built after the decision log.                                                                                                                |

### Still open

1. **Volume:** orders per day, average lines per order, peak orders per second, number of products, locations and tills (sizes §2).
2. **Hosting:** single Postgres today? Is a read replica and a managed queue available?
3. **Initial approvers and limits** (the workflow _mechanism_ is decided; I need the first real assignments).
4. The seven pricing decisions at the end of the pricing design.

### What I will not promise

That any system "guarantees" 100 billion shillings a month. What this plan guarantees is that every claim about scale is measured by a gate, every money movement is explained, and every failure mode has a designed response.

## Appendix A — Measured volumes and what they change (2026-10)

Given: ~900k orders/day average, peak ~50k orders/hour (~14/s), busiest instance 10M products and
growing, 200 locations, no read replica, no managed queue.

| Fact | Consequence |
| --- | --- |
| ~330M orders/year | Document numbers need ≥9 digits; order, order-line, ledger and decision-log tables are partitioned by month. |
| 10M products × 200 locations | Stock balances are sparse rows (product, location) and partitioned by location; never one row per product per location up front. |
| No read replica | Reports must not run on the primary during peak. Add a replica before Phase 2 (billing/reporting load); until then reports read pre-aggregated tables. |
| No managed queue | Keep the Postgres-backed graphile-worker queue; the outbox is a table drained by it. |
| Main pool is 10 connections | Put PgBouncer (transaction mode) in front; keep transactions short; kernel work uses its own small pool. |
| Partitioning | Needs a migration-managed production schema, not `db:push`. |

## Appendix B — Numbering rollout (done)

Every generator now uses the number series: sales orders, quotes (conversion no longer derives
`SO-<quote>`), tax invoices and proformas (one stable number per order and type), credit notes
(in the issuing transaction), customers, stock references, product SKU and stock code (blank =
automatic, including CSV import). Fiscal series number per branch and fall back to the default
branch so a sale never fails for a missing branch.

## Appendix C — Quote and template layout (2026-10)

A quote and a quote template arrange their items the same way, with one shared board: individual items first, then named sections, each holding its own items. Items and sections are reordered by dragging or with arrow buttons (keyboard and phone friendly); an item can be moved within its place, into another section, or out to the individual items, and the arrows carry an item across the edge of a section into the next place. The arrangement is the order of the saved lines and sections, so it survives saving, copying a template, making a quote from a template, and revising a quote. A section has a "keep expanded on the printout" choice (off by default): off, the printout (PDF, shared page, preview) shows the section title with its total; on, it also lists the section's items under it with their own quantity, price and amount. Logic: `src/lib/quote-layout.ts` (pure, tested); screen: `QuoteLayoutBoard`.
