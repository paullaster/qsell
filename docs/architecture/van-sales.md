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

New tables: `van_sales_settings`, `vans`, `sales_reps`, `sales_routes`, `route_stops`, `route_par_levels`, `van_days`, `van_visits`, `van_drops`, `van_day_events` (append-only, trigger), `van_loads` (links a transfer to a day), `van_stock_variances`, `van_offline_documents` (as `offline_sales`), `van_commission_rules`, `van_commissions`. New columns: `orders.van_day_id`, `orders.visit_id`, `stock_documents.van_day_id`. New numbering kind `van_day` (a load is a stock transfer and takes the transfer series, so there is no `van_load` kind). Unique indexes for one open day per van and per rep, one stop per customer per route; indexes for every list (by day, by status, by route and date, by customer for the next visit). Every query is company-scoped; no list is unbounded.

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

## 19. As built

### V-0 (2026-11-24)
- **Pure rules** (`src/lib/van-sales/`, 40 unit tests): `settings` (reading and refusing the company's settings, which route modes need which switch), `visits` (weekday masks, every 1, 2 or 4 weeks counted from the week a stop starts, due and overdue), `load` (par less what is on the van, plus drops, against the warehouse), `reconcile` (expected on the van, variance and its worth at cost, who bears it, when a second person must decide), `rep-limits` (discount, credit per day, price change, in words).
- **Data:** `van_sales_settings` (migration 0212): both modes off by default, check constraints for every value, a version for two people at once.
- **Server:** `VanSalesSettingsService` (read, save with a reason, the version on screen and a decision-log entry holding the old and new values), actions behind `van_sales:settings`, wired in the container. Reason list `van-sales-reasons`.
- **Permissions:** `van_sales:read`, `manage`, `plan`, `sell`, `reconcile`, `settings`, `report`, `offline`. Administrator gets all but `sell`; `sell` is given to reps by hand.
- **Numbering:** kind `van_day`, standard series `VDY-{YY}-`.
- **Screen:** *Settings › Sales › Van sales* (large tappable choices, no drop-downs, a clear reason and Undo), and its place in the Sales settings menu.
- **Docs:** Guide 16, and a pointer in Guide 13.
- **Not yet:** the platform SEO entry and the main *Van sales* navigation group arrive with the first screen that belongs in them (V-1), because a navigation module and its SEO entry must exist together. Switching a mode off while a route or van day uses it is refused from V-2 and V-3, when those exist.

### V-1 (2026-11-24)
- **Data:** `vans` and `sales_reps` (migration 0213). A van holds its stock location and its till (both unique to it), a vehicle that can be behind one active van at a time, a cash limit and a status; a rep holds the person (unique per company), modes, limits and a status. A stopped van and a paused or ended rep must have a reason (checks); a rep's modes are only van sell and pre-sell; discount 0 to 100; credit and cash limits not negative.
- **Server:** `VanService` (create makes the location, the till and the van in one transaction, so none can exist without the others; change under a version; stop and resume with a reason, refused while the van has stock or a shift open or its vehicle went to another van) and `RepService` (staff only, once each; change, pause, end, resume). Both page by keyset with a search and a status filter and write the decision log. The location carries the channel `van_sale` only, so `StockAvailability` for every shop, quote, order and counter channel never counts it.
- **Guards:** Stock › Locations (change, make default, stop, use again) and Registers (switch off, change branch) refuse a van's location or till and say where to do it.
- **Lookups:** `van-branches`, `van-cash-accounts`, `van-vehicles` (in use and free), `van-staff` (staff not yet reps), each behind `van_sales:manage`.
- **Screens:** Sales › Van sales (home, with a switched-off notice), Vans, Sales reps. Navigation under Sales; the platform SEO entry of Sales names the new sub-module and its search words.
- **Decision:** the screens always show, with a notice when both modes are off, because a navigation item cannot depend on a database setting; vans and reps may be set up before the modes are switched on.
- **Not yet:** a rep cannot be given a default van or a route (V-2); stopping or pausing is refused while a van day is open (V-3, when days exist).

### V-2 (2026-11-25)
- **Data:** `sales_routes`, `route_stops`, `route_par_levels` (migration 0215). A route has a unique code and name, a branch (fixed), a mode, an optional usual van and rep, a status with a reason when stopped, and a version; a pre-sell route cannot have a van (a check). A stop holds a customer once among the active stops of a route (a partial unique index), the weekday mask (1 to 127), every 1, 2 or 4 weeks, the start date, a note and its place; a stop is taken off (`active = false`), never deleted. Usual stock is one quantity above nothing per product per route.
- **Server:** `RouteService` (create, change, stop and resume under a version; add, change, move, reorder and take off stops with the route row locked so two people adding at once get distinct places; set usual stock as a whole; the customers due on a date through the pure `dueStops`). Guards: a mode cannot be switched off while a route in use needs it, a van or rep cannot be stopped or ended while a route in use depends on it, and a route is put back only when its van, rep and mode are still good. Product ids are text, not UUIDs: the usual-stock reader accepts any non-empty id and the service checks the product exists.
- **Lookups:** `van-vans` (in use, filter by branch), `van-reps` (selling), `van-customers` (in use, not walk-in, filter `route` hides those already on it), `van-products` (kept in stock, filter `route` hides those already on its list), each behind `van_sales:manage`.
- **Screens:** Sales › Van sales › Routes (list and add) and a route's page (the route, its customers in order with up, down, change days and take off, the usual stock of the van, and who is due on a date). Navigation entry *Routes*; the Van sales home gains a Routes card.
- **Not yet:** overdue customers (they need the visits of a van day, V-3), the load planner that tops a van up to these quantities (V-4), refusing to stop a route while a van day is open (V-3).

### V-3 (2026-11-25)
- **Data:** `van_days`, `van_visits`, `van_day_events` (migration 0216). A day has its number (own series `VDY-{YY}-`), route, branch, rep, van (none for a pre-sell day, a check), date, mode, state (planned, loading, out, returning, reconciling, closed, cancelled), a reason when cancelled (a check), the till shift (set when it goes out, later) and a version. **A rep, a van and a route are each unique per date among days not cancelled** (partial unique indexes): this replaces the design's "one open day per rep", because a planner must be able to plan the week ahead. A visit is unique per day and customer, with its state, outcome and times (for later slices). The history is append-only, enforced by a trigger.
- **Rules (pure):** `days.ts` holds the states and the only allowed moves (`DAY_MOVES`), what is open, when the visits may be arranged, the words of every state and history entry, which modes a rep lacks for a route, and the reading of a request to plan a day (not a past date). Later slices add their steps through the same table.
- **Server:** `VanDayService` plans a day in one transaction (route in use and its mode on; rep selling and doing what the route needs; van in use, in the route's branch, none for a pre-sell route; the due customers copied in order; the number; the history entry), arranges the visits under the day's row lock, cancels with a reason under a version, and lists days by keyset on (date, id). `openDayOf` is the one question the route, van and rep services ask before they stop, pause or end.
- **Lookups for planners:** `van-plan-routes`, `van-plan-reps`, `van-plan-vans`, `van-plan-customers` (hides customers already on the day), behind `van_sales:plan`, so a planner without the right to set up vans and routes can still plan.
- **Screens:** Sales › Van sales › Van days (list, filters, Plan a day) and a day's page (the day, visits with add, up, down and take off, history, cancel). Navigation entry *Van days*; the home gains a Van days card.
- **Not yet:** the steps after planned (loading V-4, out and selling V-5, collections V-7, the count and close V-9) and **overdue customers** on the routes screen, which need visits that have been done.

### V-4 (2026-11-25)
- **Data:** `van_loads` (migration 0217): a day's link to its stock transfer, with the kind (the day's load or a top-up), the place it came from, who signed for it and when, whether the office signed on the rep's behalf (and the reason, required by a check), and whether it was called off. A day has one load still wanted (a partial unique index); top-ups are several. The transfer holds the stock and its steps, so the ledger, the in-transit place and the transfer rules are the existing ones, not a copy.
- **Server:** `VanLoadService` wraps `TransferService` (create and ask for, approve, send, receive, cancel) and adds what belongs to the day: the planner (`suggestLoad` over the route's usual stock, what is on the van and what the chosen warehouse holds that is not promised), a refusal before the transfer is made when the day already has a load (so a refusal leaves nothing behind) and a clean-up if the load cannot be tied to its day, signing by the rep or by the office with a reason, and a history entry for every step through the shared `recordDayEvent`. A day with stock loaded is not cancelled until it is back (not sent: called off; on its way: signed or settled; on the van: returned by a transfer).
- **Screens:** on a day's page, *Make up the load* (planner with a chosen warehouse, quantities to change and products to add), *Loads* (each load's step and the one next action) and *On the van now*. New lookups `van-load-sources`, `van-plan-products`.
- **Change from the plan:** pinning a sale or a reservation to one stock location (`fromLocationId` through sourcing) was listed here; it is built with V-5, where selling from the van first needs it, because nothing in loading uses it and it touches the order-writing path.
- **Not yet:** the day going out (V-5), the unload at the end and the count of the van (V-9), the drops of pre-sold orders in the suggestion (V-6), a rep's request for more stock from the phone (V-8).

### V-5a (2026-11-25): sending the day out and the visits
- **Data:** migration 0218 adds to `van_visits` the position the phone gave on arrival, the distance in metres from the customer's pin, the phone's own time (kept beside the server's), and checks that a visit with no sale has its reason, that a position has both parts and a distance is not negative.
- **Pure rules** (`run.ts`): the float, a position, the metres between two places, the rule for being near a customer (record only, or required), the moves a visit can make, how a visit ends and the reason it needs, and the conditions for a day to go out (a signed load for a day with a van; a day that only takes orders goes straight out, so `DAY_MOVES.planned` now includes `out`).
- **Server:** `VanRunService`. The rep sends the day out: it opens the van's till shift with the counted float (or reuses a shift the rep already opened on that till for this day, so a retry never makes a second), ties it to the day and records `day.out`. The visits: arrive (position, distance, device time), finish with no sale, skip, shop closed, add on the road. A rep runs only their own day; every step goes through `recordDayEvent`.
- **Screens:** *Send the day out* (ready or not and why, the float, the button) and, on each visit, the rep's buttons and what happened there; an add-on-the-road form with its own lookup `van-rep-customers` (behind `van_sales:sell`).
- **Decision:** the reason for finishing a visit with no sale or skipping is the rep's own words (3 to 300 characters), not yet a company-controlled list; a catalogue can replace it without changing the data.
- **Not yet:** selling at a visit (V-5b), finishing a visit as sold, collections and returns (V-7), the rep's phone app (V-8).

### V-5b (2026-11-25): selling from the van
- **One-place stock:** a sale may name the place its stock comes from (`fromLocationId`), carried from the sale through the order writer and the reservation into the candidate query. With it, only that place is tried, whatever its channel and sellable flag; short stock there is a refusal.
- **Data:** migration 0219 `van_day_orders` ties each van sale (an ordinary cash or credit sale) to its day and visit, once per order, kind cash or credit, total not negative. The day's sales and takings are read from it and from the sales' tenders.
- **Server:** `VanSaleService` (price, sell, forDay, tenderChoices). Cash: `CashSaleService.complete` with the rep as the actor (their shift is the van's till shift). Credit: `SalesOrderService.place(..., 'credit_sale')` with a total check against the rep's daily credit. Rep rights are checked first (price, discount, credit). A retry with the same key finds the sale already made.
- **Visits:** a visit with sales finishes as `sold`; with none, only as `no_sale`.
- **Screens:** Sell form on an arrived visit (products on the van, quantities, price or discount where allowed, payment buttons, change), and the Sales panel. New lookup `van-stock-products`.
- **Not yet:** receipt printing from the van screen (the receipt is in Cash Sales and is reprinted from there; V-8 brings the phone app), pre-sell orders and drops (V-6), collections and returns (V-7).

### V-6a (2026-11-25): orders taken at a visit
- **Data:** migration 0220 lets `van_day_orders` hold `order` beside `cash` and `credit`. Visit outcomes `order_taken` and `sold_and_ordered` were already allowed by the visit's check.
- **Pure:** `readOrder` (visit, lines with no price or discount, the day needed, the retry key).
- **Server:** `VanSaleService.order` places an ordinary `sales_order` through the same order writer (priced by the server, stock held at the warehouse, the company's approval and credit rules), tied to the day and visit, a retry finding the order made. The scene check is shared with selling: day out, mode allows it, visit under way, customer can be sold to. Finishing a visit works out the stored outcome from what was taken at it. The day's list marks orders and totals them apart from money taken.
- **Screens:** the same form as selling with *Take an order* (any product, quantity, needed-on date, no payment), and an *Orders for later* line on the Sales panel. New lookup `van-rep-products`.
- **Not yet (V-6b):** drops, that is delivering a pre-sold order on a van day: planned from the orders of the day's customers, their stock moved onto the van by the load, delivered, partly, refused or failed, with a reason; and the load planner adding the drops.

### V-6b plan (2026-11-25): drops, from what the existing code does
A drop is delivering a pre-sold order from the van on a van day. Reading the code showed what it has to fit:
- **Delivery documents already exist** (`deliveries`: create from an order, release, pick, pack, ready, dispatch, deliver, fail, reattempt, return, cancel), with proof, customer messages, order-stage events and the stock issue. A drop should be one of these, driven by the rep in one go at the visit, not a parallel mechanism. A delivery can only be created for an order that has an `order_deliveries` row (method, branch, destination, charge); a staff sales order taken at a visit has none, so the drop needs one written (own fleet, the day's branch, the customer's address, no charge) through `OrderDeliveries.record`, which wants a planned delivery as its input.
- **Stock:** a sales order holds stock at the warehouse. A transfer's ship step refuses stock that is held (free = on hand minus held), so the lines of a drop cannot be loaded while the order still holds them there. The sequence has to be: at ship, release the order's hold for the drop's lines and mark the drop on the way; at the rep's signature, hold the arrived stock on the van for the order (the one-place hold built in V-5b); if the rep signs for less, the drop is short and says so; at delivery the stock issue consumes the van's hold. A failed ship puts the warehouse hold back; a refused or failed drop puts the order's hold back at the warehouse and the stock returns by the unload (V-9).
- **Order of work:** (1) `van_drops` and adding or removing a drop for orders of the day's customers, (2) the load planner adding the drops' lines, (3) the hold moving at ship and at signature, (4) the delivery document written for the order and driven to delivered, part-delivered, refused or failed at the visit, (5) the screens, tests and guide. Each of these needs its own database tests for the stock sequence, which is where the risk is.

### V-6b (2026-11-25): deliveries from the van (drops)
- **Data:** 0221 `van_drops` (day, visit, order, state, where the stock is, the hold's channel, reason, the delivery it made; one live drop per order; a reason for refused or failed) and 0222 lets a visit finish as `delivered_only`.
- **Stock:** `StockReservations.setAsideIn` lets go of an order's holds without a cancellation entry. At ship, `VanDropService.setAsideForLoad` sets aside the hold of each planned delivery whose whole order the load covers (so the transfer's check of free stock passes) and marks it on its way; a failed ship puts the hold back (`putBack`); at the rep's signature `holdOnVan` holds the stock on the van for the order with the one-place hold from V-5b, or marks the delivery short. Orders whose stock was already issued are refused at planning.
- **Delivering:** `VanDropService.deliver` writes the order's own-fleet delivery with `planStaffOrder` when added, and at the visit creates the delivery document and carries it release, pick, pack, ready, send, delivered in one go; every step already done is skipped on a retry. Readiness (paid or paid at the door) is the delivery module's own, checked at release. `close` records refused or not delivered with the reason; the stock stays held on the van for the unload (V-9).
- **Visits:** a visit with an open delivery cannot be finished; one with only deliveries finishes as delivered. Orders taken at a visit now carry the day's branch so a delivery can be planned from it.
- **Screens:** the Deliveries panel (planner: add an order with `van-day-orders`, take off; rep: Deliver, Refused, Could not deliver) and the stock state of each.
- **Not yet:** payment at the customer on delivery (the collections in V-7), partial acceptance and return of goods at the door, putting a refused order's hold back at the warehouse when the van is unloaded and refusing to end the day with deliveries open (V-9).
