# Van sales and pre-sales (V-0..V-12)

**Status:** decisions taken 2026-11-23 on the owner's instruction ("I want the two modes built, comprehensively, working together or on their own, married into the current system"); defaults chosen where the owner left a choice open and listed in section 16. **Nothing built yet.** **Owner:** Selling documents (a new group *Van sales* under **Sales**; no new top-level nav group).

## 1. What this is, and why

A distributor, a bakery, a gas or beverage company, a wholesaler or a shop with outside reps sells **where the customer is**, not at a counter. Two ways of doing it exist, and most companies use both:

| Mode | What happens at the customer | Stock moves | Money |
|---|---|---|---|
| **Van sell** (sell and deliver) | The rep sells from the stock on the van and hands the goods over on the spot. | Out of the **van** at the visit. | Cash, M-Pesa, card, or on the customer's account (credit invoice). |
| **Pre-sell** | The rep takes an order; goods come later, on a delivery day. | Reserved at once, issued when delivered (from the warehouse by a delivery run, **or from a van on the customer's next route day**). | Usually on account, or paid on delivery. |

Both have the same problems that a counter does not: **the stock and the cash are away from the company all day**, in the hands of one person, often with no signal. So the design is about **custody and reconciliation** (stock and cash are signed out, counted back, and every difference is a named, approved, recorded thing), **routes** (who visits whom, when, and did they), and **working without a connection**.

**Work together, or alone.** The two modes are two switches in one setting. A company may use van sell only (a rep with a loaded van), pre-sell only (a rep on a motorbike or on foot, no van, no cash), or both on the same day: the rep takes tomorrow's orders and sells from the van today, and **the load for tomorrow is planned from the orders already taken plus the usual top-up**.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Van** | A vehicle that sells. In the system it is **one stock location of kind `van`, one till (register), and optionally one vehicle** from the delivery register, held together by a `vans` row. |
| **Rep** | A person who sells outside. A user with `van_sales:sell`, recorded as a **sales rep** with their modes, limits and home branch. |
| **Route** | A named round (*Kiambu Monday*): a branch, a default van, a default rep, a list of customers in order with the days they are visited, and the products the van carries (par levels). |
| **Van day** | One rep's one outing on one route on one date: planned, loaded, out, back, reconciled, closed. The record that ties stock, cash and visits together. |
| **Visit** | One call on one customer in a van day, with its time, place and outcome (sold, order taken, no sale and why, shut, skipped). |
| **Load** | Stock moved from the warehouse onto the van (a transfer, with the load sheet). A **top-up** is a second load during the day; an **unload** brings the rest back. |
| **Drop** | A pre-sold order that is to be handed over at a stop of a van day. |
| **Par level** | The quantity of a product a route's van should start the day with. |
| **Van pack** | What the phone keeps for the day so it can sell with no signal (section 9). |

## 3. How it marries the current system

Nothing here is a second system. Each part uses what exists and extends it in the places the table says.

| Need | Existing building block | What is added |
|---|---|---|
| Where the van's stock is | `stock_locations` (kind `van` already exists), balances, movement ledger, reservations | A van is one location; **van stock never counts for the shop or other channels** (its channels are `van_sale` only, section 5.1). A reservation or sale can be **pinned to one location** (`fromLocationId`). |
| Loading, topping up, unloading | `TransferService` (asked, shipped into transit, received, short resolved) | A transfer may carry a `van_day_id`; the **load sheet** and **return sheet** are prints of it; the rep **signs for** it. |
| Selling for cash from the van | `CashSaleService`, shifts, tenders, POS receipt series, Z report, variance and close approval | The van's **till is a register of the van**; the van day **opens the shift** (counted float) and closing the day closes it. The sale is issued from the van's location. |
| Selling on account from the van | Credit sale / direct invoice services with the customer's price list, credit limit and blocks | Same services, issued from the van's location, with the visit and van day on the order. |
| Taking an order | Sales order service (pricing, discounts, permissions, approvals) | The order carries `source = van_presell`, the visit and the rep; the delivery date is the stop's next van day or a chosen date. |
| Delivering a pre-sold order | Delivery module (own riders, runs, vehicles, proof of delivery, door payment) | **Two ways**: a normal delivery run (rider, from the warehouse), or **a drop on a van day** (the rep delivers it from the load, with the same proof rules). |
| Money collected on account | Customer receipts and allocations in finance | A **collection** at a visit is a receipt allocated to open invoices, counted in the van day's cash or M-Pesa. |
| Returns from the customer | Counter returns, credit notes, return receipts | Taken at the visit; resaleable goods go back to the **van**, damaged ones to the branch's damaged location. |
| Working offline | The offline till: IndexedDB, signed outbox, shift token, sync, review | Extended to **known customers, credit and pre-sell orders** (section 9). |
| Phone app | The rider app (`app/rider`): own sign-in, PIN, runs | A **rep app** (`app/rep`) in the same style. |
| Approvals, decision log, order timeline, number series | Kernel services | New kinds: `van_day`, `van_load`. Every stage timestamped (section 14). |

## 4. The model

### 4.1 Vans and reps

- `vans` (company, branch, name unique per company, `location_id` unique → `stock_locations`, `register_id` unique → `registers`, `vehicle_id` nullable → `delivery_vehicles`, `max_cash` nullable, `active | stopped`, version). Creating a van **creates its location (kind `van`, not sellable to shop channels, code `VAN-…`) and its register in one transaction**; the three can never drift. A van with stock, an open day or an open shift cannot be stopped.
- `sales_reps` (company, `user_id` unique per company, name, phone, home branch, `modes` subset of `van_sell`, `pre_sell`, limits: `max_discount_percent`, `max_credit_per_day`, `may_override_price`, `may_sell_on_credit`, `active | paused | ended` with reason). A rep who leaves is *ended*, never deleted. Pausing or ending is refused with a day open, naming it.

### 4.2 Routes

- `sales_routes` (company, code, name, branch, `mode` one of `van_sell | pre_sell | both`, default van, default rep, active, version).
- `route_stops` (route, customer, sequence, visit days as a weekday mask, `every` weeks (1, 2, 4), optional pin and note, active). One customer may be on several routes; the same customer twice on one route is refused. Customers not on any route can still be sold to if the setting allows an **off-route sale** (it is recorded as such).
- `route_par_levels` (route, product, par quantity in the base unit). Used by the load planner (section 6.2).

### 4.3 The van day

`van_days`: number from the `van_day` series (`VDY-{BRANCH}-{YY}-`), company, route, van (nullable: a pre-sell-only day has none), rep, date, `mode`, `status`, `shift_id` (set when the van sells for cash/credit), `load_document_id`, timestamps for every step, `declared_*` and `expected_*` figures at close (kept so the report never changes), version.

States: `planned → loading → out → returning → reconciling → closed`, and `cancelled` (only before `out`). Each step is one function, one transaction, stamped with time and actor, and refused with plain words if its condition is not met (section 7).

### 4.4 Visits

`van_visits`: van day, customer, planned sequence, `status` (`planned`, `arrived`, `done`, `skipped`, `closed_shop`), `outcome` (`sold`, `order_taken`, `sold_and_ordered`, `collected_only`, `no_sale`), `no_sale_reason` from a **reason catalogue** (kernel reason-codes), arrival and departure times (server time; device time kept beside), the arrival **position** and its distance from the customer's pin (a figure, never a block unless the setting says so), notes. The documents made at a visit (`orders`, receipts, returns) point to the visit.

### 4.5 Orders

`orders` gain nullable `van_day_id` and `visit_id`, and `source` takes `van_sell` and `van_presell` (the existing source set is extended with a check). A pre-sold order also has `deliver_on_day_id` (the van day it will be delivered from) or goes the delivery-run way.

### 4.6 Pre-sell deliveries on a van day

`van_drops` (van day, order, stop, `state` `planned | delivered | partly | refused | failed`, reason, delivered lines). Stock for a drop is **reserved against the warehouse when the order is taken** and **moved onto the van by the load** (the load transfer lists the drop's lines, so the order's stock is on the van, and the reservation moves to the van location with it, using the existing `resource` move). Delivering consumes it from the van.

## 5. Stock on the van

### 5.1 Isolation

A van's location sells to the channel `van_sale` only (a new value of the channel list; existing locations are unchanged). `StockAvailability` therefore never counts it for the shop, quotes or warehouse orders, and the van's rep sees **only the van's stock** when selling. A sale from the van passes `fromLocationId`; sourcing then considers that one place and no other. It never silently takes from the warehouse.

### 5.2 Never negative, never lost

`allow_negative` is false on a van. A rep cannot sell what is not on the van; the phone says so with the quantity left. (Offline sales that arrive when the stock is short are parked and reviewed, exactly as the offline till does.)

### 5.3 Reconciliation

At the end of the day the **rest is unloaded** (a transfer back, received by the warehouse keeper) and the **van's location is counted** (a stock count on the van location, by a second person). Expected is the ledger: opening + loaded − sold − delivered drops + returned-good − unloaded. A **variance** per product is shown with its value at cost; a shortage needs a reason and, above the company's limit, an **approval**; it is then posted as a stock variance and, by the setting, charged to the rep (a receivable on the rep) or written off. An overage is booked the same way. **The van day cannot close until the van is empty or the rest is explicitly left on the van** (a setting: some companies keep stock on the van overnight, signed for).

## 6. Planning

### 6.1 The plan

A **van day** is made from a route on a date (one per rep per day, per van per day, enforced by unique indexes). The visit list is the route's stops due that day (by weekday and `every`), in sequence; the planner may add, remove or reorder. The **route screen** shows the day's due stops and any customer **overdue** (not visited in more than their interval).

### 6.2 The load planner

Suggested load = **par level − what is already on the van** (never below zero) **plus the drops** (the lines of pre-sold orders for stops of the day). The screen shows the suggestion, what the warehouse has, and any product that cannot be fully loaded (short, with the amount). The planner edits it and presses **Load**. Loading is a transfer: asked → shipped (stock leaves the warehouse into transit) → **received by the rep on the phone by signing** (stock arrives on the van). Only then can the day go **out**.

### 6.3 Top-up

During the day the rep asks for more (a request with the products); the planner approves and a second load follows the same steps. The van day keeps every load and its time.

## 7. Conditions (each is refused in words)

- **Out** needs: a signed load; an open shift with a counted float (if van sell); the van not on another day; the rep active and permitted for the route's mode.
- **Sell** needs: the day is `out`; the customer is not blocked; for credit, the customer's credit rules and **the rep's own limit for the day**; prices from the server (a typed price needs `may_override_price`, a discount needs the discount right and stays inside the rep's limit); an off-route customer only if allowed.
- **Visit** done needs an outcome, and a reason for *no sale*.
- **Back** needs every visit finished or skipped with a reason, and every drop with a result.
- **Close** needs: unload received (or the keep-on-van rule), the van counted, variances decided, the shift closed through the till's own close (count, variance, approval if over the limit), every offline sale from the phone synced or discarded with a reason, no parked sale.
- **Cash limit**: when the van's cash passes `max_cash` the phone says to make a **cash drop** (a paid-out in the shift, to the safe or bank run, witnessed later); the supervisor sees it live.

## 8. Money

- **Tenders** are the till's (cash with change, M-Pesa, card). M-Pesa on a van goes through the same recording as the counter (the code is the reference); nothing is trusted from the phone alone.
- **Credit** is an invoice from the van (the credit sale service), with the customer's terms. **Collections** (a receipt, allocated to open invoices, oldest first or chosen) are taken at a visit and counted in the day's cash or M-Pesa.
- **Reps and the books.** Van cash is in the van's register/shift, so the till's Z report and the finance posting are unchanged. Stock on the van is stock in a branch location, so the books' stock value is right all day. Shortages follow section 5.3.
- **Commission** (V-10): per rep, a percent of sales, or a rate per unit or per case, with an optional bonus for visit strike rate, computed on a **closed** day only and paid through the same payment-run machinery as rider pay. Off by default.

## 9. Working offline

The phone must be able to **sell, take orders, collect and record visits with no signal** for the whole day, and bring everything in safely. This extends the offline till (`offline-selling.md`), keeping its safety rules.

1. **At the start of the day, online**, the phone downloads the **van pack**: the van day, the route and its customers (name, phone, pin, balance, credit limit, blocked state, terms), the products on the van and their quantities, **each customer's price per product as the server works it out today** (tax included), the rep's limits, the ways of paying, and the visit list. It also holds the **day token** (a secret kept with the day, from which each document gets a signature), as the shift token does for the till.
2. **Offline**, every sale, order, collection, return and visit is written to the **outbox** with its key, lines, prices shown, tenders, time on the device and a **device reference** the customer is given on a provisional slip (a numbered, signed text; the real tax receipt follows).
3. **On sync**, one document at a time, in order, each checked as the offline till checks (signature, the sender's own day, repeat keys, limits), then made through the normal services:
   - **A sale the customer already paid for** is accepted at the slip's price (never charge more), with any difference to today's price flagged.
   - **A credit sale** is accepted (the goods are gone) and flagged if it takes the customer over their limit or if they were blocked in the meantime; a **limit on credit that may be given offline in one day** (a setting) stops the phone selling more on account without a signal.
   - **An order** (pre-sell) is **priced by the server** on arrival (the customer has paid nothing), and any difference from the phone's figure is shown for the rep to see.
   - **Stock short** parks the document, exactly as the offline till, for a person to resolve.
4. **The day cannot close while anything from the phone is waiting**, and a supervisor may discard a stuck item with a reason.

Offline selling for van days has its **own setting** (default off) on the same screen as the till's, and the same plain-words statement of what it means.

## 10. The phone app (rep app)

`app/rep`: own sign-in and PIN like the rider app, installable (PWA), built for a thumb in sunlight.

- **Today**: the day, the load, the cash so far, visits done of total, a clear **next stop**.
- **Route**: the stops in order with distance, the customer's balance and last order date, **navigate**, **call**, **WhatsApp**; skipped and overdue clearly marked.
- **At a customer**: *Sell*, *Take order*, *Collect*, *Return*, *No sale*. The sale screen starts from **what this customer usually buys** (last order and their typical quantities, one tap to repeat) and the van's stock; big quantity steppers, instant total, the customer's own prices, payment in two taps (cash with change, M-Pesa code, card, on account), a receipt that can be printed, shared by WhatsApp or SMS as a link (the shop's tracked/receipt link), or both.
- **My van**: what is on it, what I sold, what I should be holding in cash.
- **End of day**: *Return to depot*: a summary of stock and cash expected, the unload, the declaration.
- **Calm states**: offline banner with the count waiting, sync with a clear result, errors that say what to do.

Everything the app does is a server action with its own permission; nothing it sends is trusted (prices, ids, totals are recomputed).

## 11. The office screens (Sales › Van sales)

*Van days* (the live board: each van's day, progress, cash, stock, last seen, alerts), *Plan a day*, *Load planner*, *Reconciliation* (stock and cash variances to decide), *Routes* (with stops and par levels), *Vans*, *Reps*, *Visits and orders taken*, *Reports*, and *Settings*. Lists are paged on the server (keyset); lookups are Autocomplete (never a native select). Every screen is a server component with a client island for what is interactive, and each is documented in the implementor guide.

## 12. Reports (V-11)

Per day, rep, van, route and customer: sales (cash, M-Pesa, credit), orders taken, **strike rate** (visits with a sale or order of visits made), **drop size**, **lines per call**, **visits against plan**, time at customers, **stock variance** and **cash variance** with value, **returns** and their reasons, **collections** and the aged debt of each route, **pre-sell fill rate** and the time from order to delivery, and van **running costs** (the delivery module's fuel and vehicle costs by vehicle, which a van's vehicle already ties to). Exports as CSV; every figure explained in words.

## 13. Permissions

`van_sales:read`, `van_sales:manage` (vans, reps, routes), `van_sales:plan` (days, loads), `van_sales:sell` (the rep's rights: held by reps only), `van_sales:reconcile` (count, decide variances), `van_sales:settings`, `van_sales:report`, and `van_sales:offline` (its own, held by no other). Server actions check them; the rep app sees only the rep's own days (the server finds the rep from the signed-in person, never from an id the phone sends).

## 14. Stages are timestamped

Every stage of a van day (planned, loading, loaded, out, each visit's arrival and outcome, each sale and order taken, each drop, back, unloaded, counted, variance decided, closed, cancelled) is an append-only event with a server time, the actor, the device time kept beside it, and a reason where one is needed. Orders taken or sold on a visit emit their own timeline events with `source = van`. The tests assert the stage, the time and the reason for failures too (a refused sale, a skipped stop, a refused load).

## 15. Data and indexes (summary)

New tables: `van_sales_settings`, `vans`, `sales_reps`, `sales_routes`, `route_stops`, `route_par_levels`, `van_days`, `van_visits`, `van_drops`, `van_day_events` (append-only, trigger), `van_loads` (links a transfer to a day), `van_stock_variances`, `van_offline_documents` (as `offline_sales`), `van_commission_rules`, `van_commissions`. New columns: `orders.van_day_id`, `orders.visit_id`, `stock_documents.van_day_id`. New numbering kinds `van_day`, `van_load`. Unique indexes for one open day per van and per rep, one stop per customer per route; indexes for every list (by day, by status, by route and date, by customer for the next visit). Every query is company-scoped; no list is unbounded.

## 16. Decisions taken (defaults; change them by telling me)

1. **One van = one location + one till** (not a mobile "cash box" invented for vans), so every till rule, report and the books' posting are reused.
2. **Van stock is isolated** from shop and warehouse availability.
3. **A rep may be both modes or one**; a route is `van_sell`, `pre_sell` or `both`; a day without a van is allowed (pre-sell only).
4. **Pre-sell stock is reserved at the warehouse at order time and moves onto the van with the load**; the alternative of a normal delivery run stays available per order.
5. **Offline is its own switch**, default off, with the plain-words statement; it covers known customers, credit and orders, with limits.
6. **Shortages**: the company chooses per setting between *charge the rep* and *write off*; both need a reason, big ones an approval.
7. **Stock may stay on the van overnight** only if the setting allows; default is unload daily.
8. **Commission is optional and off by default**, calculated on closed days only.
9. **No GPS block**, only a recorded distance (a company may turn on *must be near the customer* later).
10. **No new top-level navigation group**: *Van sales* sits under **Sales**.

## 17. Slices

| Slice | What | Verified by |
|---|---|---|
| **V-0** | Permissions, nav and SEO entries, `van_sales_settings` and its screen, number kinds, pure rules (visit due dates, load suggestion, expected stock, variance, rep limits) | Unit; database for settings; e2e for the screen |
| **V-1** | Vans (location + register in one transaction), reps, with lookups | Unit, DB, API, e2e |
| **V-2** | Routes: stops, visit days, par levels; due-today and overdue lists | Unit, DB, e2e |
| **V-3** | The van day: plan, state machine, events, locking and versions | Unit, DB (every refusal and stage time), e2e |
| **V-4** | Loading: load planner, load as a transfer, signing, top-up, `fromLocationId` pinning through sourcing, van channel isolation | DB (stock, reservations, isolation), e2e |
| **V-5** | Van sell: cash and M-Pesa through the till in the van's shift, credit invoice from the van, rep limits, visits, off-route rule | DB, API, e2e |
| **V-6** | Pre-sell: orders on a visit, pricing, reservation, drops on a van day, delivery-run alternative, delivery proof | DB, e2e |
| **V-7** | Collections and returns at a visit; cash drops and the cash limit | DB, e2e |
| **V-8** | The rep app (phone-first), online | e2e on phone width; screenshots |
| **V-9** | Day end: return, unload, van count, variances, approvals, rep charge or write-off, the shift's close, close of the day | DB, e2e |
| **V-10** | Offline van pack: snapshot, outbox, signing, sync, review; commission (optional) | Unit, DB, browser with the connection cut |
| **V-11** | Reports and CSV | DB, e2e |
| **V-12** | Implementor guide (all eight parts) and sales talk track, platform SEO entry, a last end-to-end trace of a day from plan to close | Docs build, nav test, e2e |

Each slice ships with its own unit, database, API and browser tests, the implementor guide change, and a hand-over that says what was looked at on a phone and a desktop.

## 18. Not in scope (first release)

Route optimisation by traffic (the delivery planners are reused for the order of stops, straight-line), van-to-van transfers mid-day (done as unload and load), consignment stock at the customer, promotions that need the full web basket, offline returns for credit notes, a printer protocol other than the browser's (the receipt link can be shared), and multi-currency days.
