# Stock per Location (L-0) — Module Design (DRAFT, nothing built)

Status: **draft for correction**, written 2026-10-27. It is the prerequisite of the [delivery module](./delivery-module.md) (a delivery leaves a named location) and the "per-location stock ledger and balances" of Phase 2 in the [sales-order blueprint](./sales-order-blueprint.md) (§ stock, "where the scale fix lands"). It also touches [core-finance-module.md](./core-finance-module.md) (stock at cost in the books), [vendor-management-module.md](./vendor-management-module.md) (goods received, purchase returns), [pricing-module.md](./pricing-module.md) (kits) and [order-stage-timeline.md](./order-stage-timeline.md) (every stock stage of an order is timestamped).

Where it lives: **Products & Inventory** (nav), as *Stock levels, Locations, Transfers, Counts*. Per the standing rule, no new top-level group.

Read §1 for why, §3–§6 for the model, §9 for everything that has to change, §10 for the migration (the hard part), §14 for the order of work, §16 for what I need you to decide.

---

## 1. What is wrong today (evidence from the code)

| # | Finding | Where | Consequence |
|---|---|---|---|
| 1 | Stock is **one pair of numbers per product**: `products.stock_quantity` and `products.reserved_quantity`. | `schema.ts` (`products`), `inventory/service.ts` (`applyStockDelta`), `inventory/reservation-service.ts` | The business cannot say *where* stock is. A delivery cannot leave a named branch. Two branches share one number. |
| 2 | Every change takes `SELECT … FOR UPDATE` on the **product row** (`applyStockDelta`, `reserveForOrder`). | same | One hot row per popular product. Two simultaneous sales of the same product queue. At the blueprint's volumes (≈ 900k orders a day, peaks ≈ 50k an hour) this is the first bottleneck. |
| 3 | The **movement journal mixes two things**: physical movements and holds. A reservation is a row with `change_amount = −qty` and `new_stock` = *available*, not on hand. | `reserveForOrder`; `finance_capture_stock_movement()` has to special-case `order_reservation` / `order_cancellation_release` to ignore them | The journal cannot answer "what is physically on the shelf" or "who holds what" without rules about row types. It cannot expire holds, or release part of one. |
| 4 | `previous_stock` / `new_stock` are **copied into each row** at write time. | `inventory_movements` | Correct only while one row per product is locked. With several locations or shards the copied numbers are meaningless. |
| 5 | Row ids are `Date.now()` + random text (`newId('ledger')`). | `reservation-service.ts`, `service.ts` | Not ordered, not dense, not cheap to index; collisions are improbable, not impossible. |
| 6 | The books are fed by a **database trigger on the journal** that reads the product's single `cost_price`, and keeps running totals per product in `finance_inventory_totals` under another row lock. | migrations 0054, 0065, 0069 | Good idea (no path can change stock without reaching the books) but it is a second per-product serialisation point and it knows nothing of location or branch. |
| 7 | There is **one unit cost per product** (`products.cost_price`, last cost on receipt). | `applyStockDelta` (`costPrice`), `finance_capture_cost_change()` | No per-location or per-lot cost. A transfer cannot carry a cost. (Acceptable at first: see §7.) |
| 8 | **Thirteen change types are written in many places**: `order_reservation`, `order_fulfillment`, `order_cancellation_release`, `purchase_order_receipt`, `purchase_receipt_reversal`, `purchase_return`, `credit_note_restock`, `manual_adjustment`, `physical_audit`, `damage_writeoff`, `restock`, `product_deleted`, `product_restored`, plus `cost_change`. Callers of `applyStockDelta`: catalog service, inventory service, return receipts, purchase returns, goods received notes. | grep of `changeType:` and `applyStockDelta` | Every one needs a location. This is the migration surface (§10). |
| 9 | **Readers** of `stockQuantity` / `reservedQuantity` are spread over catalog, storefront, quotes, pricing, KRA eTIMS (`item-service`), analytics, units, vendors, the admin screens and the cart. | grep | They need one definition of "available" (§6), not each their own subtraction. |
| 10 | Users are **not scoped to branches** for stock (only reports have `reports:all_branches`). | `access-control`, `reports/service.ts` | Location access needs a model (§11). |

None of this is broken for a one-location business: it is correct, idempotent on settlement (`inventory_movements_settlement_uidx`) and the books are complete. The design keeps those properties and removes the limits.

## 2. Design stance

1. **Location is part of the key of stock.** Every quantity is held at a location: `(product, location)`.
2. **Two ledgers, never mixed.** A **movement ledger** (physical stock; append-only) and a **reservation ledger** (holds against stock; rows with a lifecycle). Balances are *projections* of these, kept in the same transaction and checked by a job.
3. **No hot rows.** Balances are sharded per `(product, location)` when a product is hot; allocation picks a shard without waiting (`FOR UPDATE SKIP LOCKED`), as the blueprint says.
4. **Documents, not edits.** A receipt, transfer, adjustment, write-off, count is a **stock document** with lines, a state machine, a number from the series, reasons, approvals and a decision-log entry. No code path edits a balance directly.
5. **Constraints, not hopes.** `on_hand`, `reserved` and the relationship between them are enforced by check constraints and by the single function that writes them; the nightly integrity job proves them again.
6. **One definition of available**, used by the shop, quotes, orders, eTIMS and the admin: `available(product, location set, channel)`.
7. **A one-location business sees no change.** A company with a single location (the default) behaves exactly as today; the new screens appear when a second location is created. The migration is expand → verify → contract, reversible until the last step.
8. **Everything has a server timestamp** that says when it happened, who did it and why (see [order-stage-timeline.md](./order-stage-timeline.md) for the order's stages).

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Location** | A place that holds stock: warehouse, store, van, quarantine, etc. (§4.1). Belongs to a branch (or to none). |
| **Balance** | `(product, location, shard)` → on-hand and reserved. A projection. |
| **Movement** | One physical change of stock at one location, with a reason, a cost and the document that caused it. Append-only. |
| **Reservation** | A hold on a quantity at a location for a purpose (an order line, a transfer, a delivery). Has a state and an expiry. |
| **Stock document** | Header + lines for receipt, issue, transfer, adjustment, write-off, count, return receipt. |
| **Transfer** | Stock moved between two locations, with a time in transit in between. |
| **Available** | What can still be promised: on-hand minus reserved minus safety stock, over the locations a channel may sell from. |
| **Sourcing** | The decision of which location(s) supply an order line, recorded with its reason (a trace, like a price trace). |
| **Shard** | One of N counters for a hot `(product, location)`; reads sum them. |

## 4. The model

### 4.1 Locations

`stock_locations`

| Column | Notes |
|---|---|
| `id uuid`, `company_id` | Company-scoped as everything. |
| `branch_id` (nullable) | The branch it belongs to: gives the **dimension for the books** and the access scope. A location without a branch is "company stock" (a central warehouse). |
| `code`, `name` | Unique per company. |
| `kind` | `warehouse`, `store`, `van`, `quarantine`, `damaged`, `consignment_in`, `transit` (system, per transfer; see §7.3). The kind drives rules, not code paths: e.g. `quarantine` and `damaged` are *not sellable*. |
| `address`, `contact`, optional pin | Used by delivery (dispatch origin) and distance charges. |
| `is_sellable` | Whether stock here counts toward availability for sale at all. |
| `sells_channels` | Which channels may sell from it: `ecommerce`, `sales_order`, `credit_sale`, `pos_cash_sale` (an array; empty = none). |
| `fulfils_delivery` | May dispatch deliveries from here. |
| `allow_negative` | Policy per location (§16.2). Default false. |
| `safety_stock_default` | Optional. |
| `is_default`, `is_active` | Exactly one default per company; a location in use is deactivated, never deleted. |
| `parent_id` (reserved, unused in L-0) | Bins and zones come in Phase 5; the column exists so locations can nest later without a rewrite. |

Rules: a location with stock, open reservations or open documents cannot be deactivated (it must be emptied or transferred first, with the words to say so). The default location cannot be deleted. A *van* is a location a rider loads at the start of a run and unloads at the end (the delivery design's cash-and-stock float).

### 4.2 Balances (projection)

`stock_balances (company_id, product_id, location_id, shard smallint)` primary key `(product_id, location_id, shard)`

| Column | Notes |
|---|---|
| `on_hand numeric(14,3)` | Physical quantity in the product's base unit (the units module's decimals apply). `CHECK (on_hand >= 0)` unless the location allows negative stock (then enforced by the function and flagged). |
| `reserved numeric(14,3)` | Sum of open reservations on this shard. `CHECK (reserved >= 0)`. `CHECK (reserved <= on_hand)` unless `allow_negative`. |
| `version bigint` | Incremented on each write; lets the integrity job and tests detect lost updates. |
| `updated_at` | Server time. |

Indexes: the primary key; `(location_id, product_id)` for "everything at this location"; a partial index of rows below their reorder level for low-stock screens.

A view `stock_availability(product_id, location_id, on_hand, reserved, available)` sums shards. `products.stock_quantity` / `reserved_quantity` remain during the migration as a **maintained total** (§10) and are removed at the end.

### 4.3 Movement ledger

`stock_movements` — **append-only**, enforced by a trigger (as the decision log and the inventory events are).

| Column | Notes |
|---|---|
| `id bigint generated always as identity` | Dense, ordered, cheap. Replaces text ids from `Date.now()`. |
| `company_id`, `product_id`, `location_id`, `shard` | |
| `movement_type` | A controlled list (below); a new type is a code change with a test, not free text. |
| `quantity numeric(14,3)` | **Signed** physical change. Never zero. |
| `unit_cost numeric(14,4)` | The cost **frozen at the moment** (company moving average at that time, §7.1). Replaces the trigger's read of `products.cost_price`. |
| `document_type`, `document_id`, `document_line_id` | What caused it (stock document, delivery, order line, return, GRN line). `UNIQUE (document_type, document_line_id, movement_type, location_id)` where idempotency is required (settlement), replacing `inventory_movements_settlement_uidx`. |
| `reason_code` | From the reason catalogue where a reason is mandatory (adjustments, write-offs, counts). |
| `actor_type`, `actor_id` | User, system job, rider, webhook. |
| `occurred_at` | Server time of the business event. |
| `recorded_at` | Server time of the insert (`default now()`); they differ only for back-dated entries, which need a reason and a permission. |
| `correlation_id` | The request/trace id from the kernel context, so one checkout's stock effects are found together. |
| `note` | Free text, bounded. |

Movement types: `receipt` (goods received), `purchase_return`, `receipt_reversal`, `sale_issue` (goods issue for an order/delivery/POS sale), `sale_return` (return receipt / credit-note restock), `transfer_out`, `transfer_in`, `adjustment`, `count_variance`, `write_off`, `opening`, `delete_adjust` (product deleted/restored), `cost_revaluation` (a pure value movement, quantity zero is the one exception to "never zero": it carries a value and no quantity, see §7.1).

Indexes: `(product_id, location_id, id)` for a product's history at a place; `(document_type, document_id)`; `(occurred_at)`; `(company_id, id)` for ordered consumers (the books worker). Partitioning by month is planned for when volume demands it (the blueprint's capacity model); keyset paging is used everywhere meanwhile.

### 4.4 Reservation ledger

`stock_reservations` — a hold is a **row with a life**, not a number in a counter.

| Column | Notes |
|---|---|
| `id uuid`, `company_id` | |
| `product_id`, `location_id`, `shard` | Where it is held. |
| `purpose` | `order_line`, `transfer`, `delivery`, `manual`. |
| `ref_type`, `ref_id`, `ref_line_id` | The order line (or transfer line, etc.). `UNIQUE (ref_type, ref_line_id, product_id, location_id) WHERE state = 'held'` makes reserving twice a no-op (idempotency, as today's journal check). |
| `quantity` | Held; `consumed` and `released` quantities are tracked so a reservation can be consumed in parts (partial deliveries). |
| `state` | `held` → `partly_consumed` → `consumed` / `released` / `expired`. |
| `expires_at` | Optional. Unpaid shop orders hold stock for a limited time (§16.4); an expiry job releases them. |
| `created_at`, `state_changed_at` | Server times (the order timeline records the same moments). |
| `reason` | For release/expiry (customer cancelled, payment failed, expired, re-sourced). |

A balance's `reserved` is `Σ quantity − consumed − released` over its open reservations; the integrity job proves it.

### 4.4a Why two ledgers (and not the single journal)

The mixed journal (finding 3) cannot say which order holds the last kilo of fish, cannot expire a hold, cannot release half of one, and needs special cases in the books trigger. Separating them also lets the books ignore reservations by construction (they never touch `stock_movements`).

### 4.5 Stock documents

`stock_documents` (header) and `stock_document_lines`

| Header | Notes |
|---|---|
| `id`, `company_id`, `number` | Number from the series (`stock_receipt`, `stock_adjustment`, `stock_write_off`, `stock_count`, `stock_transfer`, `stock_issue` kinds; the first four exist today in `inventory/service.ts` via `numbering.assign`). |
| `kind` | `receipt`, `issue`, `transfer`, `adjustment`, `write_off`, `count`, `return_receipt`, `opening`. |
| `state` | A state machine per kind (§7), every transition timestamped and with its actor and reason. |
| `from_location_id`, `to_location_id` | As the kind needs. |
| `source_type`, `source_id` | The GRN, delivery, credit note, return, order that caused it. |
| `reason_code`, `note` | Mandatory where the catalogue says so. |
| `requested_by`, `approved_by`, `posted_by`, timestamps for each | |
| `approval_status`, `approval_managed_by` | Hooked to the approval engine for adjustments/write-offs above a threshold and for transfers where the company wants them. |

Lines: `product_id`, `quantity`, `unit_cost` (frozen when posted), `expected_quantity` / `counted_quantity` (counts), `lot` (reserved for Phase 5), `note`. One document posts in **one transaction**: all its lines or none.

### 4.6 Transfers and stock in transit

A transfer is one document with two movements and a state in between:

```
draft → requested → (approved) → shipped (transfer_out at A; stock now "in transit") → received (transfer_in at B) | partly_received → closed
                                          └→ lost / damaged in transit (a write-off against the transit holding, with a reason and approval)
```

Stock in transit is held in a per-transfer **transit location** (kind `transit`, created with the transfer, system-owned) so that on-hand across all locations always sums to what the company owns and nothing is "nowhere". Receiving less than shipped leaves the difference in transit until it is resolved (received late, or written off with a reason). The transfer's time stamps (requested, shipped, received) are the transit time metric. A transfer carries stock **at cost** (§7.1), so no profit or loss is created by moving goods.

### 4.7 Counts

`stock_documents(kind = count)` with counted quantities per line:

* **Cycle count** (a subset of products at a location) or **full count**; *blind* (counters do not see the expected quantity) or open.
* The expected quantity is **snapshotted** when the count is opened; movements that happen during the count are reconciled when it is posted (the variance is `counted − (expected + movements since)`), so counting does not require freezing sales.
* A variance above a threshold needs approval; posting creates `count_variance` movements with the count's reason.
* Counts are timestamped per line (when counted, by whom), not only per document.

## 5. Concurrency, scale and correctness

### 5.1 The hot-row problem and the answer

Today: a lock on the product row for every change. Design:

1. **Balances are sharded.** Every `(product, location)` starts with **one shard** (shard 0). A product that sees contention gets more shards (the blueprint's "N counters"), by an administrator action or an automatic rule (when the lock-wait of the shard exceeds a threshold, the integrity job proposes adding shards; moving to N shards is an online operation that only adds rows and spreads on-hand).
2. **Allocation does not wait.** To reserve `q` of product `p` at location `l`: pick a shard with `on_hand − reserved ≥ q` using `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`; if none single shard can cover it but the sum can, lock the shards in a **stable order** and take from several (rare path); if the sum cannot, the line is short. Skipping locked shards means concurrent checkouts proceed in parallel on different shards instead of queuing.
3. **Many lines in one call.** A basket's lines are processed in a stable `(product_id, location_id)` order inside one transaction, so two baskets cannot deadlock each other.
4. **Idempotent by key.** Reserve/consume/release are keyed by the reference (order line + product + location), so a retried webhook or a double click changes nothing (the idea of `inventory_movements_settlement_uidx`, kept and generalised).

Alternatives considered and rejected: an in-memory counter or queue per product (loses on restart, breaks with several instances); advisory locks per product (still one point); optimistic retry on a single row (thrashes under contention); eventual availability from a cache (oversells). Sharded counters with `SKIP LOCKED` need only the database we already run, with no new infrastructure (the blueprint's constraint).

### 5.2 Budget

At ≈ 14 sales a second at peak and a few lines per sale, a sale touches ≈ 2 statements per line (a balance update and a reservation/movement insert) inside one short transaction: well within one Postgres on the design's hardware, *provided the lock is not per product*. The load gate for L-0b is a mixed test of 200 concurrent baskets over a small hot set of products at one location, with **zero oversell, zero deadlock, and p95 reserve under 50 ms**; the numbers are checked in CI at a smaller scale and recorded.

### 5.3 Integrity

A graphile-worker job (`stock-integrity-check`, nightly and on demand), like `finance-integrity-check`, proves:

* `Σ shard.on_hand = Σ movements.quantity` per `(product, location)`;
* `Σ shard.reserved = Σ open reservations` per `(product, location)`;
* no balance breaks its constraints;
* every posted stock document has all its movements, and every movement has a document or a stated system reason;
* on-hand over all locations equals what the books' running total says (value reconciliation).

A failure raises a finding on the dashboard with the exact keys, never "fixes" silently, and can be repaired by a documented, approval-gated correction document.

### 5.4 Idempotency and ordering of the books

The books are fed from `stock_movements` ordered by `id`. Because the frozen `unit_cost` travels with the movement, the posting worker does not need the product row lock the trigger takes today (finding 6): the trigger becomes a plain insert of an event row (still "no path reaches the shelf without reaching the books"), and the rounding running totals (`finance_inventory_totals`) are applied by the worker, one product at a time, in `id` order. This removes the second per-product serialisation point from the sale path.

## 6. Availability and sourcing

### 6.1 One definition of available

```
available(p, L) = Σ shards.on_hand − Σ shards.reserved − safety_stock(p, location)     for each location in L
availability(p, channel, customer/zone) = Σ available(p, l) over locations l where l.is_sellable and channel ∈ l.sells_channels
```

A single service (`StockAvailability`) answers it, with batch reads (many products in one query, no N+1), used by: the shop (cards, product page, cart, checkout), quotes, orders, POS, eTIMS, the admin. Nobody subtracts `reserved` themselves any more.

### 6.2 Sourcing: which location supplies a line

* **Rules (configurable):** per branch and channel, an ordered list of locations to try (the default is "the order's branch location first, then the company's default"), whether a line may be **split** across locations (→ several deliveries), whether the **whole order** must come from one location, and a preference such as "closest to the delivery address" (needs zones/pins, from the delivery module).
* **The decision is recorded** on the reservation (and so on the order line) with its trace (rules considered, why this location), exactly like a price trace; staff may **re-source** before picking with a reason (the reservation moves, with an event).
* **The shop** sources automatically; availability shown is the sum over locations the channel may sell from; "only 2 left" counts only sellable stock.
* **Pickup** orders source from the pickup location only; the shop shows "in stock at <branch>" when the shopper chooses collection.

### 6.3 Kits and bundles

A kit (existing `KitService`) reserves and issues its **components** at the sourcing location(s); the kit itself holds no stock. A kit is available up to the smallest component availability (already how the engine treats it; this keeps it per location).

## 7. Operations (each is a stock document or a reservation action)

### 7.1 Costing (what a movement is worth)

* **L-0 keeps the company-wide moving average cost per product**, as today (`products.cost_price`, updated on receipt). Each movement **freezes** the cost at its moment (`unit_cost`), so history never changes when cost changes later.
* **Transfers move at cost**: `transfer_out` and `transfer_in` carry the same unit cost; they create no gain or loss, and the books show a movement between branch dimensions only when branches act independently.
* **Revaluation** (a change of cost) is a `cost_revaluation` entry that values the goods on hand at that moment (the books already post it from `finance_capture_cost_change()`); it is now computed from balances summed over locations.
* **Not in L-0:** FIFO/lot costing, landed-cost allocation per lot, per-location cost differences. They belong with batches and expiry (blueprint Phase 5); the movement already carries `lot` (reserved) and `unit_cost` so they can be added without rewriting history.

### 7.2 Receipt (goods in)

From a goods received note (vendors module, `rgn-service`), a return receipt, an opening balance or a manual receipt. State: `draft → posted` (a receipt from a GRN posts with the GRN). Needs a location (default = the GRN's receiving location). Updates the moving-average cost in the same transaction. Reversal is a new document (`receipt_reversal`), never an edit.

### 7.3 Issue and sale

* **Reserve** (order placed): sourcing + reservation(s) at the chosen location(s), with `expires_at` for unpaid shop orders.
* **Issue** (delivery dispatched / collected / POS sale): consumes the reservation and writes `sale_issue` movements at the location; cost of sales is posted from the movement by the books worker. A delivery may issue **at dispatch** (default) or **at delivery** (configurable per company, see the delivery design).
* **Release** (cancelled, payment failed, expired, re-sourced): marks the reservation released/expired with its reason; no movement.
* **POS** at a till: reserve and issue are one step at the till's location, and negative stock follows the location's policy.

### 7.4 Returns and credit notes

`sale_return` movements at a **chosen location** with a **disposition**: restock (sellable location), quarantine (inspection location), damaged/scrap (write-off). Replaces `credit_note_restock` and the return receipt's direct stock change, both of which gain a location.

### 7.5 Adjustments, write-offs, counts

Documents with mandatory reason codes (the existing `WRITE_OFF_LABELS`, `manual_adjustment`, `physical_audit`, `damage_writeoff` map to these), an approval trigger above a configured value or quantity, and a location. The catalog's "edit stock quantity" on the product form becomes a **shortcut that creates an adjustment document at the default location** (or asks for a location when the company has several); it can no longer set a number behind the ledger's back (it already goes through `applyStockDelta`; this makes it a proper document).

### 7.6 Transfers

§4.6. Permissions are split: request, approve, ship, receive are different rights (a store manager can request; the warehouse ships; the receiving branch receives).

### 7.7 Low stock and reorder

Reorder level and reorder quantity become **per `(product, location)`** (the product's `low_stock_threshold` is the company default until overridden). The low-stock screens and alerts work per location, and a transfer can be proposed from a location with surplus to one below its level (a suggestion, not automatic).

### 7.8 Reservation expiry

A worker task `stock-reservation-expiry` (every minute) releases holds whose `expires_at` has passed and whose order is still unpaid; it replaces `releaseFailedPaymentReservations`. Each release writes the reason `expired` and the order timeline records `stock_released` with its time.

## 8. State machines (summary)

| Document | States |
|---|---|
| Receipt | `draft → posted` · `posted → reversed` (by a new document) |
| Adjustment / write-off | `draft → (pending_approval) → posted` · `draft/pending → cancelled` |
| Count | `draft → counting → counted → (pending_approval) → posted` · `→ cancelled` |
| Transfer | `draft → requested → (approved) → shipped → partly_received → received → closed` · `→ cancelled` (before ship) · `shipped → lost` |
| Reservation | `held → partly_consumed → consumed` · `held → released` · `held → expired` |

Every transition: server timestamp, actor, reason where required, a decision-log entry, and (for order-linked ones) an entry in the order's timeline.

## 9. Everything that must change (the integration map)

| Area | Today | After L-0 |
|---|---|---|
| `inventory/service.ts` (`applyStockDelta`, `adjust`, `receive`, `writeOff`, `audit`, `batchAdjust`, `runOp`) | Per-product row, text journal | Thin facade over `StockService` that posts stock documents; same method names during the transition |
| `inventory/reservation-service.ts` | Counters on the product row | Sourcing + reservation ledger + sharded balances; same entry points (`reserveForOrder`, `fulfilOrder`, `releaseOrder`, `releaseFailedPaymentReservations`) |
| Catalog (`createProduct`, `updateProduct`, import) | Writes `stock_quantity`; opening stock via `applyStockDelta` | Opening stock = `opening` document at the default (or chosen) location; the form's stock field = adjustment shortcut; import takes an optional location column |
| Storefront (`cart-quantity.availableOf`, cards, product page, sitemap, `listLiveProductsByIds`) | `stock − reserved` from the product | `StockAvailability` for the shop's channel; the browser still receives one number per product (`stockQuantity`/`reservedQuantity` shape kept for the cart code) |
| Orders (`write-service`) | Reserves by product | Reserves with sourcing; order lines record location and reservation; order stages timestamped (see timeline doc) |
| Quotes | Reads product stock for availability hints | `StockAvailability` for the `sales_order` channel |
| Returns / credit notes | `return-receipt-service`, `credit_note_restock` | Return receipt document with location + disposition |
| Vendors | `rgn-service` (goods received), `purchase-return-service` | Receipt / purchase-return documents with the receiving/dispatching location |
| Pricing (kits) | Component reads | Component availability per location |
| KRA eTIMS (`item-service`) | Stock master and stock IO from `products.stock_quantity` | Per branch where a branch acts independently (stock IO per registered branch), else the company total |
| Finance (inventory posting) | Trigger on `inventory_movements`; running totals under the product lock | Trigger on `stock_movements` (plain insert); worker applies totals; events carry `location_id` and the branch dimension |
| Analytics / reports | Valuation and stock by product | By location and by branch; valuation = Σ on-hand × cost per location |
| Admin screens | Stock levels, ledger | Stock levels by location (matrix), locations, transfers, counts, receipts, movement ledger with filters; low stock per location |
| Delivery (next module) | — | Delivery from a location; van locations for runs; return of failed deliveries to a location |
| Permissions | `products:adjust_stock`, `inventory:adjust` | Added: `stock:read`, `stock:locations:manage`, `stock:adjust`, `stock:transfer:request/approve/ship/receive`, `stock:count`, `stock:post_backdated` (see §11) |
| Numbering | `stock_receipt`, `stock_adjustment`, `stock_write_off`, `stock_count` | Add `stock_transfer`, `stock_issue`, `stock_return_receipt`, `stock_opening` |
| Reason codes | Write-off labels | Catalogue entries for every stock document kind |

## 10. Migration (the hard part)

Principles: **expand → verify → contract**; reversible until the last step; no downtime; a company with one location sees nothing change.

**Step 0 — Prepare.** Add the new tables and the `stock_per_location` company setting (off). Create each company's **default location** (code `MAIN`, name "Main stock", kind `warehouse`, attached to the default branch).

**Step 1 — Backfill.** In batches (keyset by product id, not one transaction): for each product, create `stock_balances(product, MAIN, 0)` from `products.stock_quantity` / `reserved_quantity`; create one `opening` movement per product so that Σ movements = on-hand; copy the historic `inventory_movements` into `stock_movements` with `location = MAIN`, mapping change types, with `recorded_at = created_at` and a flag `migrated = true`; convert open reservations: for each unsettled `order_reservation` with no matching fulfilment/release (the journal tells which), create a `stock_reservations` row (`held`, purpose `order_line`). The old tables stay untouched.

**Step 2 — Shadow.** The new write path runs **beside** the old one: every old write also writes the new ledger (a dual-write inside the same transaction behind a flag). A comparison job proves, per product, `old stock = Σ new on-hand` and `old reserved = Σ new reserved` continuously, and reports mismatches with keys. The gate to go on: zero mismatches over a full business cycle and a full load test.

**Step 3 — Flip reads.** Readers move one at a time to `StockAvailability` (the shop first, then quotes, eTIMS, analytics, admin), each with its own test. `products.stock_quantity`/`reserved_quantity` become a **maintained total** (a trigger on `stock_balances` keeps them equal to the sums), so any reader not yet moved stays correct.

**Step 4 — Flip writes.** The facade stops writing the old journal; the old triggers (`finance_capture_stock_movement`, `finance_capture_cost_change`) are replaced by their `stock_movements` equivalents in one migration; the books' running totals move to the worker.

**Step 5 — Contract.** After a release cycle with no mismatch: drop the dual-write and the flag, make `products.stock_quantity`/`reserved_quantity` read-only projections, and later remove them (a final migration, after every reader is proven off them). The old `inventory_movements` is kept read-only as history (and the books' references to its ids stay valid), then archived by policy.

**Rollback:** until Step 5, turning the flag off returns reads and writes to the old path (the old tables are still being written). After Step 4, rollback is a documented procedure (re-derive the old counters from the ledger), tested in CI.

**Data checks (SQL, run at every step and in CI on a seeded database):** `Σ stock_movements.quantity per (product, location) = stock_balances.on_hand`; open reservations per product equal the old reserved; no negative balances; every historic movement mapped exactly once; counts of rows by type before and after.

**Specific risks and answers**

| Risk | Answer |
|---|---|
| Millions of products/movements: backfill locks | Keyset batches of 5,000, short transactions, resumable, throttled; runs from the worker with progress and a pause control |
| Orders being placed during the migration | Step 1 is repeatable; Step 2's dual write starts *before* the final catch-up pass; the comparison job is the proof |
| A product deleted/restored (`product_deleted`/`product_restored` movement types) | Mapped to `delete_adjust` with the product's soft-delete state preserved; tests cover a deleted product with stock |
| The books' history refers to movement ids | `finance_inventory_events.movement_id` keeps pointing at old ids; new events point at `stock_movements.id` (a `movement_source` column says which) |
| Integer vs decimal quantities | Already `numeric(14,3)` (migration 0065); the new tables use the same |

## 11. Security, access and audit

* **Permissions** (new, each checked on the server): `stock:read`, `stock:locations:manage`, `stock:adjust`, `stock:transfer:request`, `…:approve`, `…:ship`, `…:receive`, `stock:count`, `stock:post_backdated`. Existing `products:adjust_stock` and `inventory:adjust` map onto `stock:adjust` (a migration grants the new key to roles that hold the old, so nobody loses access).
* **Location scoping:** a user may be limited to a set of locations (or to their branches' locations); without `reports:all_branches`-style rights they see and act only there. Transfers cross scopes by design: the sender sees the shipment, the receiver sees what is coming.
* **Every stock change** records the actor, the reason where required, the time (server), the correlation id and a decision-log entry; documents are immutable once posted (corrections are new documents).
* Back-dating a posting needs its own permission and a reason, and is refused in a closed period (the books' period lock already exists).
* No client-supplied quantities, locations or costs are trusted: the server re-derives costs, checks location access and the document's state.
* Stock figures are commercially sensitive: exports are audited; the shop shows availability only as "in stock / low / out", never the exact figure unless the company chooses to.

## 12. Experience (screens)

* **Stock levels:** the matrix `product × location` (paged by product, columns for the locations the user may see), filters by location/category/low/negative, the movement ledger of a cell, quick actions (adjust, transfer, count).
* **Locations:** create/edit, kind and channel switches, deactivate with blockers explained.
* **Transfers:** a board (requested/shipped/in transit/received), a form with product lines by autocomplete, receive with per-line quantities and discrepancy reasons.
* **Counts:** create (cycle/full, blind/open), a mobile-friendly counting list (large numbers, barcode/SKU scan later), variance review and approval.
* **Receipts, adjustments, write-offs:** documents with reasons and attachments (photos for damage).
* **Order screen:** a "Stock" panel showing the location, the reservation state and its timestamps; a re-source action with a reason.
* **Shop:** availability by the channel's locations; "collect from <branch>" availability for pickup.
* All screens: loading, empty, error and success states, confirmation before destructive actions, 390 px to desktop, no horizontal scroll, touch targets ≥ 40 px, selection inputs through the shared autocomplete (never native selects), per the project rules.

## 13. Failure modes

| Failure | What happens |
|---|---|
| Two baskets want the last unit | One shard locks; the other either takes another shard or is told the line is short; never both |
| A webhook is delivered twice | The reservation/consume key makes the second a no-op |
| A transaction aborts halfway | Everything (balances, movements, reservations, document state) rolls back together |
| The books worker is down | Sales and deliveries continue; events queue with backoff; the dashboard shows lag; nothing is lost |
| A count is posted after sales happened | The variance accounts for movements since the snapshot |
| A transfer is never received | It stays in transit, ageing on the dashboard, with an owner and a path to resolve (receive late or write off with approval) |
| Integrity check finds a drift | A finding with exact keys; no silent repair; a correction document with approval |
| A location is deactivated while holding stock | Refused, naming what blocks it |
| A reservation outlives its order | The expiry job releases it; the integrity job flags orphans |
| Clock changes on a server | Business times come from the database (`now()`), not the app server; back-dating needs a permission |

## 14. Order of work (inside L-0) and gates

| Slice | Delivers | Gate |
|---|---|---|
| **L-0a** | Locations, sharded balances, movement ledger, the stock service, backfill + **shadow dual-write** + the comparison job, `StockAvailability` (read-only) | Shadow shows zero mismatch on the seeded database and in a load test; one-location companies unchanged |
| **L-0b** | Reservation ledger, sourcing, allocation with `SKIP LOCKED`, order wiring (reserve/issue/release), expiry job | Concurrency test: 200 baskets, hot products, zero oversell/deadlock, p95 ≤ 50 ms; idempotency under duplicate webhooks |
| **L-0c** | Documents: receipt, adjustment, write-off, return receipt, opening; reasons and approvals; vendors/returns/credit-note wiring; books worker and new trigger | Books reconcile to ledger value to the cent on the test suite |
| **L-0d** | Transfers and transit; counts | Conservation property holds (on-hand over all locations unchanged by transfers); a count under concurrent sales is exact |
| **L-0e** | Channel/sourcing rules UI, per-location reorder, storefront availability and pickup availability, location scoping of users, screens | e2e at desktop and phone width for every screen |
| **L-0f** | Cut-over (Steps 3–5), removal of the dual write, retirement of the product counters | A release cycle with zero mismatch; rollback rehearsed |

Each slice ships with unit, integration, API and e2e tests, docs and the permissions it adds. Property tests cover the invariants: conservation of stock across any sequence of documents; `reserved` never above `on_hand`; reserve → release returns to the start; transfers conserve.

## 15. Not in L-0

Bins, putaway and zones inside a location (the `parent_id` column is reserved); batches, lots, serials and expiry (FEFO); FIFO and landed-cost layering; wave picking and pick tasks (a delivery's pick list comes with the delivery module); demand forecasting; stock reservations for projects/work orders beyond "manual"; barcode scanning hardware (the counting screens take typed SKUs first).

## 16. Decisions needed (my recommendation first)

1. **Location kinds** as in §4.1 (`warehouse`, `store`, `van`, `quarantine`, `damaged`, `consignment_in`, `transit`). Anything else you need (for example `cold_room` as a kind, or as a flag on a warehouse)?
2. **Negative stock:** forbidden by default per location; allowed per location (for example a till) with a flag on the movement and a finding. Recommend forbidden everywhere except locations you mark.
3. **Costing in L-0:** company-wide moving average with the cost frozen on each movement (§7.1); FIFO/lots later with batches. OK?
4. **Unpaid shop orders hold stock for how long?** Recommend 30 minutes for card/M-Pesa (matching the payment wait), configurable per company; cash on delivery holds until dispatch.
5. **Shards:** start with one per `(product, location)` and add on measured contention (§5.1). OK, or do you want a fixed small number from the start?
6. **Location scoping of users** (§11): by branch, or by an explicit list of locations per user? Recommend by branch with explicit overrides.
7. **Safety stock** (stock kept back from sale): per product per location, default 0. Needed in the first version?
8. **Who owns stock in transit** for the books: the sending branch until received (recommend) or a company transit account?
9. **Split fulfilment in the shop:** may one shop order be supplied from two locations (two deliveries), or must it come from one (the customer pays one delivery charge)? Recommend one location unless none can cover the whole order.
10. **How far back must history be migrated** into the new ledger? Recommend all of it (it is a copy, and finance already references it), with the option to archive older than N years later.

## 17. Decisions taken

None yet for L-0 beyond what the owner decided for delivery (2026-10-27): **stock per location is built first**.
