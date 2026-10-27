# Order Stage Timeline — Requirement and Design (DRAFT, nothing built)

Status: **draft for correction**, written 2026-10-27 from the owner's requirement:

> *Every stage an order goes through, from when a user initiates it until it succeeds or fails, must have a timestamp. Every order state or stage must have a timestamp.*

It applies to every module that moves an order: checkout and payments (built), approvals (built), stock reservation and issue ([stock-locations.md](./stock-locations.md)), fulfilment and delivery ([delivery-module.md](./delivery-module.md)), billing and KRA, returns and refunds. The requirement is also recorded as rule 11 of [`docs/PROJECT_RULES.md`](../PROJECT_RULES.md).

This one is **small, independent and valuable on its own**, so I recommend building it first, before the stock and delivery work (§11).

---

## 1. The requirement, stated precisely

1. **Every stage an order enters, and every outcome it reaches, is recorded with a server timestamp**, the actor, the source and (for a failure, a refusal, a cancellation) the reason.
2. **The record starts at initiation**, not at "order created": a shopper who submits checkout and is refused (a quantity limit, stock short, a payment that cannot be started, a rate limit) leaves a timestamped trace, even though no order exists.
3. **A failure is a stage like any other** (with its time and reason), not an absence.
4. **Nothing can change an order's stage without leaving a record**: the guarantee is structural (one writer plus a database safety net), not a convention.
5. **Order is by sequence, not by clock.** Times answer "when"; a per-order sequence number answers "in what order".
6. **Time spent in each stage is derivable** (from consecutive events) so delays, stuck orders and SLAs are measured, not guessed.

## 2. What exists today (evidence)

| Fact | Where |
|---|---|
| An order carries `created_at`, `updated_at`, `shipped_at`, `delivered_at`. Nothing else is timestamped on the order itself. | `orders` table |
| The order's `status` (`pending, processing, shipped, delivered, completed, failed, cancelled, refunded`), `payment_status` (`unpaid, pending_verification, paid, reconciled, discrepancy, failed`), `approval_status` and `kra_transmission_status` are **plain columns that are overwritten**: the previous value and *when it changed* are lost. | `orders`, `OrderStatus`, `PaymentStatus` |
| Status changes are made in **at least ten places**: `payments/service.ts` (5), `reconciliation/service.ts` (3), `inventory/service.ts` (`updateOrderStatus`, 2), plus approval and KRA paths. | grep of `orderRepo.update` / `updateOrderStatus` |
| A payment attempt has `created_at`, `paid_at`; provider events and callbacks are logged with their own times; the decision log records decisions with reasons. | `payment_attempts`, `provider_events`, kernel decision log |
| A refused checkout (`CheckoutRefused`, limit/stock/rate-limit refusals, a payment that "could not be started") is answered to the shopper and **leaves nothing behind**. | `orders/checkout-actions.ts` |
| Stock reservation, release and issue are journal rows with a creation time, but **the order does not show them as stages**. | `inventory_movements` |
| There is **a precedent we should copy**: purchase orders have an append-only event table (`purchase_order_events`: event, from/to status, reason, data, actor, time). Orders do not. | `purchase_order_events` |

So the system can already tell you *that* an order is paid, but not *when it was approved*, *how long payment took*, *when stock was released*, or *that a shopper tried and was refused at 14:02*.

## 3. Design stance

1. **An append-only event table is the truth; columns are projections.** `order_stage_events` records everything. The order's current `status`/`payment_status` stay (they are fast to filter on), plus a small set of *denormalised stage times* (§6) maintained from events.
2. **One writer.** A single service function (`OrderStages.record`) is the only code that moves a stage, and it writes the event and the new state in the same transaction. The ten call sites are rewritten to call it.
3. **A database safety net.** A trigger on `orders` writes an event with `source = 'trigger'` and raises a finding if any stage column changes without an event in the same transaction, so a forgotten path is *seen*, never silent (the pattern of the books trigger, migration 0054).
4. **Server time only.** `occurred_at` is the database's `now()` at the moment the transition is recorded. The rider's phone or a provider may send their own time; it is kept as `client_time` / `provider_time`, labelled, never trusted for ordering.
5. **The initiation is recorded before the order exists** in `checkout_attempts` (§5).
6. **Same shape for every module.** Stock, delivery, payment, approvals and billing emit events in the same table with a stage name from one controlled list.

## 4. The stage catalogue

One controlled list (a code constant with a test, like the movement types), grouped by phase. Each stage has **outcomes**: `entered` (started or reached), `succeeded`, `failed`, `skipped`, `cancelled`, where they apply.

| Phase | Stages (stage → outcomes) |
|---|---|
| **Initiation** | `checkout_started`, `checkout_validated`, `checkout_refused` (reason: input invalid, quantity limit, stock short, not for sale, price changed, coupon refused, rate-limited) |
| **Placement** | `order_placed`, `charge_quoted` (delivery charge), `pricing_applied` (the price trace id) |
| **Stock** | `stock_reserved` / `reservation_failed`, `stock_issued`, `stock_released` (reason: cancelled, payment failed, expired, re-sourced), `stock_returned` |
| **Approval** | `approval_requested`, `approval_approved`, `approval_rejected`, `approval_escalated`, `approval_reopened`, `approval_withdrawn` |
| **Payment** | `payment_started`, `prompt_sent`, `payment_pending_verification`, `payment_confirmed`, `payment_failed` (reason: declined, timeout, cancelled, wrong number), `payment_expired`, `payment_retried`, `payment_reconciled`, `payment_discrepancy`, `refund_requested`, `refund_completed`, `refund_failed` |
| **Fulfilment** | `released_for_fulfilment`, `blocked` / `unblocked` (reason, owner), `pick_started`, `picked`, `packed`, `ready`, `dispatched`, `out_for_delivery`, `delivery_attempted` (result, reason), `delivered`, `delivery_failed`, `returned_to_stock`, `collected` (pickup) |
| **Billing & compliance** | `invoice_issued`, `kra_submitted`, `kra_signed`, `kra_failed` (reason), `credit_note_issued` |
| **Closure** | `completed`, `cancelled` (reason, who), `failed` (reason), `refunded` |

A failure stage always carries a reason code from the controlled reason catalogue and a plain-language message; a free-text detail is bounded and never holds secrets or personal data beyond ids.

## 5. Data model

### 5.1 `order_stage_events` (append-only)

| Column | Notes |
|---|---|
| `id bigint generated always as identity` | Dense, ordered. |
| `company_id`, `order_id` | Company-scoped. |
| `sequence int` | Per order, 1, 2, 3 …; `UNIQUE (order_id, sequence)`; assigned in the writing transaction under the order's row lock, so it cannot gap or repeat. |
| `stage text`, `outcome text` | From the catalogue; `CHECK` against the list. |
| `from_status`, `to_status` | The order's `status` before and after, when the event changed it (else null). |
| `occurred_at timestamptz default now()` | Database time of the transition. |
| `recorded_at timestamptz default now()` | Insert time. Equal except for back-dated entries (which need a permission, a reason and `back_dated = true`). |
| `client_time`, `provider_time` | Optional, as reported; never used for order or SLA. |
| `source` | `shop`, `staff`, `pos`, `webhook`, `rider_app`, `worker`, `system`, `migration`, `trigger`. |
| `actor_type`, `actor_id` | User, customer, rider, provider, job. |
| `reason_code`, `message` | For failures, cancellations, blocks, refusals. |
| `ref_type`, `ref_id` | The thing behind it: payment attempt, stock document, reservation, delivery, approval request, invoice, KRA submission. |
| `attempt_no` | For repeatable stages (payment retries, delivery attempts). |
| `correlation_id` | The kernel request id; ties the event to its decision-log entries and stock/payment rows. |
| `detail jsonb` | Small, structured, no secrets, no free personal data. |
| `approximate boolean` | True for backfilled events (§9). |

Constraints and indexes: append-only trigger (no update, no delete); `(order_id, sequence)` unique; `(company_id, stage, outcome, occurred_at)` for funnels and SLAs; `BRIN(recorded_at)`; a partial index on failures; partitioning by month when volume needs it (§10).

### 5.2 `checkout_attempts` (initiation before there is an order)

| Column | Notes |
|---|---|
| `id uuid`, `company_id` | |
| `started_at` | Server time the shopper pressed pay. |
| `customer_id`, `session_ref` | The signed-in customer if any; for guests a salted hash of the session, never the raw address or phone. |
| `channel` | `ecommerce`, `pos`, … |
| `cart_summary jsonb` | Product ids, quantities, the total shown: enough to reproduce why it was refused. |
| `outcome` | `refused`, `placed`, `abandoned_after_payment_start`. |
| `refused_stage`, `reason_code`, `message` | The stage it stopped at and why. |
| `order_id` | Set when it became an order; the order's first event (`checkout_started`) is then copied in with the attempt's `started_at`, so the timeline is whole. |
| `finished_at` | Server time of the outcome. |

Retention: refused attempts are short-lived analytics (default 13 months, configurable); placed ones are folded into the order's timeline.

### 5.3 Denormalised stage times on `orders`

For hot list filters and "why is it stuck" without a join: `placed_at` (= `created_at`), `approved_at`, `payment_started_at`, `paid_at`, `released_at`, `packed_at`, `dispatched_at`, `delivered_at`, `completed_at`, `cancelled_at`, `failed_at`, `refunded_at`, `current_stage`, `current_stage_since`. They are **projections written by the same function in the same transaction**; the events remain the truth, and a nightly job proves they agree (the L-0 integrity-check pattern). (`shipped_at`, `delivered_at` already exist and are kept.)

## 6. How it is guaranteed

1. **`OrderStages.record(tx, order, stage, outcome, {reason, ref, source, actor, …})`** is the only function that changes `status`, `payment_status`, `approval_status`, `kra_transmission_status` or the projections. It locks the order row, assigns `sequence`, writes the event, updates the order, all in the caller's transaction. Failures are recorded **before** the error is returned to the shopper (a refused checkout writes its `checkout_attempts` row even though the order insert never happens).
2. **The ten existing call sites** (payments, reconciliation, inventory status, approvals, KRA, returns) are rewritten to call it. A CI test greps the code base for direct writes to those columns outside the function and fails on any.
3. **The trigger** on `orders` (`BEFORE UPDATE OF status, payment_status, approval_status, kra_transmission_status`) checks that a matching event was written in the same transaction (a transaction-local setting set by the function); if not, it writes a `source = 'trigger'` event *and* a finding, so a bypass is visible within the day.
4. **A deferred check** at commit (constraint trigger) refuses a transaction that changed an order's stage but wrote no event, in development and CI (in production the trigger above records rather than refuses, so a sale is never lost to an audit rule).
5. **Property test:** over random sequences of operations, every order's events are strictly ordered by `sequence`, `occurred_at` is non-decreasing (except flagged back-dating), `to_status` of each event equals `from_status` of the next status-changing event, and the order's current status equals the last event's `to_status`.

## 7. Using the timeline

* **Admin order screen:** a *Timeline* tab: every stage with time, actor, source, reason and **time since the previous stage**, failures in red with reasons, the pre-order refusals of the same customer in the last day, links to the payment attempt, stock document, delivery and approval. Exportable.
* **Customer:** the tracking page and "Track my order" show the stages the company chooses to expose (placed, paid, packed, out for delivery, delivered, with times), never internals or reasons that are for staff.
* **Operations dashboard:** *stuck orders* (current stage older than the stage's SLA), funnel (initiated → placed → paid → released → dispatched → delivered, with drop-off and median time), failure reasons by stage, payment time-to-confirm, approval turnaround, pick-to-dispatch time, delivery time against slot.
* **SLAs:** a configurable target per stage (and per method/zone); a breach raises a task to the owner and escalates (the approvals escalation machinery is reused).
* **Support:** "why is this order stuck?" is one glance: the current stage, since when, and the last failure with its reason.
* **Reports:** all computed from events with keyset paging; no screen scans the whole table.

## 8. Privacy and security

* Events store ids and codes, not names, phones or addresses; the pre-order table stores a hash for guests. Personal data stays where it already lives (the order, the customer).
* Reading the timeline needs `orders:read`; seeing staff-only reasons and actors needs a permission (`orders:timeline`); the customer view is a whitelisted projection.
* Back-dating needs its own permission, a reason, and is refused in a closed period.
* The tables are append-only by trigger; corrections are new events (`correction` with a reference to the one corrected), never edits.
* Exports are audited.

## 9. Backfill (existing orders)

For every existing order, in keyset batches from the worker: `order_placed` at `created_at`; `payment_confirmed` at the successful attempt's `paid_at`; `dispatched`/`delivered` at `shipped_at`/`delivered_at`; the current terminal status at `updated_at`; approval events from the approval engine's own history; stock and KRA events from the journals where times exist. All marked `source = 'migration'`, `approximate = true`, so reports can exclude or flag them. Nothing is invented where no time is known.

## 10. Scale

At the blueprint's ≈ 900k orders a day and ≈ 15 events per order, that is ≈ 13M rows a day (≈ 5B a year). So: narrow rows (ids, codes, small `detail`), monthly partitions with a retention/archive policy (older partitions move to cold storage but stay queryable for audit), `BRIN` on time plus one btree `(order_id, sequence)`, batched inserts where a module records many stages at once (a basket's stock reservations are one event per order, with the lines in `detail`, not one per line). High-frequency internal ticks (polling a provider every few seconds) are **not** stages: only changes of state are. The write cost per stage is one insert in a transaction that already writes the state.

## 11. Order of work

This is independent of L-0 and delivery, small, and everything else emits into it, so it comes first.

| Slice | Delivers | Gate |
|---|---|---|
| **T-0** | `order_stage_events`, `checkout_attempts`, the stage catalogue, `OrderStages.record`, the trigger and finding, the CI scan, the ten call sites rewritten, projections, backfill, admin *Timeline* tab, customer timeline, funnel/stuck-orders basics | Every transition in the existing payment, approval, status and KRA paths produces exactly one event; the property test passes; a refused checkout leaves an attempt with its reason; the backfill reconciles with current statuses |
| **T-1** | Stock stages (reserve, issue, release, expiry) emitted by L-0b | Each stock change of an order has its event |
| **T-2** | Delivery stages emitted by D-1/D-2 (attempts, proof, failure) | A delivered order's timeline shows every hand-over with its time |
| **T-3** | SLAs per stage, breach tasks and escalation; operations dashboard in full | A breach raises exactly one task, escalates on schedule |

Each slice has unit, integration, API and e2e tests (desktop and phone), docs and the permissions it adds, per the project rules. The e2e tests exercise the happy path **and** each failure path (limit refused, stock short, payment declined, payment timeout, approval rejected, delivery failed) and assert the stage, the time and the reason.

## 12. Decisions needed (my recommendation first)

1. **Which stages the customer sees** (recommend: placed, paid, packed, out for delivery, delivered/collected, cancelled/refunded, each with its time).
2. **Retention of refused checkout attempts** (recommend 13 months, hashed for guests).
3. **Record failed attempts for anonymous visitors?** Recommend yes, hashed and aggregated (it is how you learn why people leave), with no personal data.
4. **Do SLAs ship in T-0 or T-3?** Recommend T-3: first make the facts exact, then measure against them.
5. **Back-dated entries**: allowed only for a documented list (rider offline sync, provider callbacks that carry their own time)? Recommend yes, with `client_time`/`provider_time` kept separate and the server time always the ordering key.
6. **Name of the permission to see staff-only detail** (recommend `orders:timeline`).
