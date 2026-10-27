# Delivery — Module Design (DRAFT, nothing built)

Status: **draft for correction**. Written 2026-10-27 after the owner's answers (see "Decisions taken"). Read it, correct it, then it is built in the slices of §16. Companion designs: [stock-locations.md](./stock-locations.md) (L-0, the prerequisite) and [order-stage-timeline.md](./order-stage-timeline.md) (every stage of an order, including every delivery stage, is timestamped). It extends, and does not replace, [sales-order-blueprint.md](./sales-order-blueprint.md) (§ fulfilment: delivery, pick, pack, ship, goods issue) and uses [pricing-module.md](./pricing-module.md), [approvals-module.md](./approvals-module.md), [core-finance-module.md](./core-finance-module.md) and [vendor-management-module.md](./vendor-management-module.md).

Where it lives in the product: **a sub-module of Sales** (nav *Sales & Fulfillment*), as pricing is. Per the standing rule, no new top-level group is added for it.

## 1. What exists today (so we do not pretend to start from nothing)

An order carries `shipped_at`, `delivered_at`, a courier name, a tracking number and a shipping fee that is whatever the caller passes (there is no rate rule; the shop charges none). The order status has `shipped` and `delivered`. There is no delivery document, no zone, no rider, no proof, no per-location stock (stock is one pool per product), no way to quote a charge at checkout. Everything below is new.

## 2. Design stance

1. **A delivery is a document, not an order status.** One order can have several deliveries (partial, back-ordered, split by location); one delivery can carry lines of several orders for the same customer and address. The order's delivery status is *derived* from its deliveries.
2. **One document, four ways of delivering.** Own riders, third-party courier, customer collects, scheduled visit (installation). They differ in the steps and who acts, not in the data: the same `delivery` with a *method profile* that says which states and proofs apply.
3. **Everything is a recorded event.** Attempts, hand-overs, proofs, cash movements are append-only rows with a reason and an actor; state changes go through a state machine (the kernel's kit), never by editing a status.
4. **Money is first-class.** The charge a customer pays, the cost we pay a courier or rider, and the cash a rider holds are three different ledgers that must reconcile.
5. **The charge goes through the pricing engine.** The delivery fee is a price like any other: quoted before payment, explained by a trace, shown and charged identically.
6. **Works with bad connections.** The rider app is offline-first; every write from a phone is idempotent by a client-made id.
7. **Configurable, not coded.** Zones, rate cards, slots, reasons, billing trigger and approval limits are data an administrator changes, with a reason, recorded in the decision log.

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Fulfilment method** | `own_fleet`, `courier`, `pickup`, `scheduled_visit`. |
| **Delivery** | The document that moves goods (or a crew) to one address for one customer, from one stock location. |
| **Delivery line** | A quantity of one order line on a delivery. |
| **Run (trip)** | A rider's and vehicle's outing on a day: an ordered list of stops (deliveries), a cash float, a start and an end. |
| **Shipment** | The hand-over of a delivery to a courier: waybill, tracking, label, courier cost. |
| **Attempt** | One try at the door, successful or not, with its reason. |
| **Proof of delivery (POD)** | Code, signature, photo, or sign-off that the right person received the right goods. |
| **Zone** | A named delivery area (Westlands, Kisumu CBD, Nyali), optionally a polygon or a list of towns/estates. |
| **Charge policy** | The rule that turns an order and an address into a delivery charge (§5). |
| **Slot** | A bookable delivery window with a capacity. |
| **Cash custody** | The cash a rider has collected and not yet handed in. |

## 4. Fulfilment methods

| Method | Who acts | Main states | Proof | Cost side |
|---|---|---|---|---|
| **Own fleet** | Dispatcher, picker, rider | released → picking → packed → ready → on a run → out for delivery → delivered / failed | Code or signature or photo (configurable per company/zone) | Rider pay, fuel/vehicle (optional) |
| **Courier** | Dispatcher/packer; courier outside | released → picking → packed → handed to courier → in transit → delivered / failed / returned | The courier's own status/POD, kept as received | Courier invoice → payables |
| **Pickup** | Counter staff | released → picking → packed → ready for collection → collected | Collection code or ID check | None |
| **Scheduled visit** | Scheduler, crew | scheduled → crew assigned → on site → completed (checklist) → signed off | Customer sign-off, photos, checklist | Crew time, travel |

A delivery's method is chosen at checkout (shop) or on the order (staff) from what the company offers for that address and items; staff may change it before dispatch with a reason.

## 5. The delivery charge

### 5.1 Charge methods (configurable, switchable)

A **charge policy** names one *method* and its parameters. The business can have several and say which applies when (branch, channel, customer group, dates), exactly like a price list is scoped. Methods in the first version:

1. **Zone rate card**: each zone has a fee; optional weight bands (0–5 kg, 5–20 kg…), optional per-extra-kg, optional minimum.
2. **Distance**: base + fee per km from the dispatching location to a map pin, with a cap and a maximum range.
3. **Flat / weight only**: one fee, or fee per weight band, everywhere.
4. **Order value tiers** (a modifier on any of the above): free over X, half over Y.

Policies are effective-dated, with the same lifecycle as price lists (draft → in force → retired), a priority, and a conflict check when two could tie. The **method in force can be changed at any time** (a different method for the festive season, for one branch, for one customer group) without touching orders already placed: an order stores the charge it was given and its trace.

### 5.2 Quoting

* The shop asks for the address first (area picker with search, optional map pin), then shows the methods available (delivery, collect) with their charge and earliest slot, **before payment**. Changing the address or cart requotes.
* Staff orders and quotes show the charge with "Why this charge?" as prices do.
* The charge is a *charge line* on the order, with its own tax class (delivery is a service: KRA tax code configurable, default the standard rate), kept in the order's totals, never a hidden mark-up on goods.
* **What the customer pays and what delivery costs us are separate** (§10): the margin on delivery is reported, never mixed into the goods margin.
* Free-delivery promotions use the discount engine (P-2's open "free shipping" item); coupons and rules can waive or cut the charge, never below a configured floor without approval.

### 5.3 Addresses (no postcodes)

Kenyan addresses are descriptive. The address holds: county, town, area/estate (picked from the zone list), a free-text description (landmark, building, floor), the contact person and phone (the number on the delivery, which can differ from the contact and payment numbers), an optional map pin (latitude/longitude, accuracy), and delivery instructions. A pin is *optional at first* and mandatory only for distance charging. An address outside every zone is "not deliverable" with the words to say so, or "ask us" if the company allows quoting by hand.

## 6. Documents and states

### 6.1 Tables (summary)

`delivery_zones`, `delivery_zone_areas`, `charge_policies`, `charge_policy_rates` (effective-dated rows, as price list lines), `delivery_methods` (what the company offers, per branch), `delivery_slots`, `deliveries`, `delivery_lines`, `delivery_events` (append-only), `delivery_attempts`, `delivery_proofs`, `runs`, `run_stops`, `shipments`, `couriers` (a vendor, §10), `rider_profiles`, `cash_custody_entries` (append-only), `delivery_costs`, `delivery_reasons` (uses the controlled reason catalogue).

Every table has `company_id`; the numbers (delivery, run, shipment) come from the number series. Every state change writes the decision log with its reason.

### 6.2 Delivery states (own fleet shown; the other methods use subsets, §4)

```
draft → released → picking → packed → ready → on_run → out_for_delivery ─┬→ delivered
                      │                                                    ├→ failed_attempt → (re-attempt: ready) | returned_to_stock | cancelled
                      └→ short (partial pick: back-order the rest) ←       └→ refused / damaged (partial accept)
```

* **Blocks** (delivery block, credit hold, payment pending) hold a delivery at `draft` with a reason, an owner and a release path, as the blueprint says.
* **Partial delivery and back-order** are normal: a pick short by 3 creates a delivery for what is there and leaves the rest open on the order (re-planned or cancelled, each with a reason).
* **Order delivery status** is computed: not started, partly delivered, delivered, with delivery exceptions.
* **Every state, attempt and hand-over carries a server timestamp**, the actor, the source and (for failures, blocks, cancellations) a reason, and each is also an event on the order's timeline ([order-stage-timeline.md](./order-stage-timeline.md)): `released_for_fulfilment`, `blocked`/`unblocked`, `pick_started`, `picked`, `packed`, `ready`, `dispatched`, `out_for_delivery`, `delivery_attempted` (with result and reason), `delivered`, `delivery_failed`, `returned_to_stock`, `collected`. A rider's phone time is kept as `client_time` for the record but never decides order or SLA; the server time does. Time in each stage (pick-to-dispatch, dispatch-to-door, attempt-to-attempt) is derived from these events and feeds the SLAs of D-5.

### 6.3 Attempts and failures

Each try is an attempt with: time, rider, place (pin), result (delivered / customer absent / refused / wrong address / unreachable / damaged / not safe / other), photo, note. After a failure the delivery returns to `ready` for another attempt (limit configurable), is rescheduled by the customer through their tracking link, goes back to stock, or is cancelled, each with a reason code and an owner. Perishables get a short, explicit deadline.

## 7. Stock: prerequisite and rules

**Prerequisite (build first): stock per location**, designed in [stock-locations.md](./stock-locations.md) (L-0). A delivery leaves a named branch or warehouse, so stock must be per location. L-0 provides the sharded per-location balances, the movement and reservation ledgers, sourcing (which location supplies a line), transfers with stock in transit, counts, and van locations. Delivery needs from it: reserve per location, issue per location, return to a location, and "which location can fulfil these lines". Delivery work does not start until L-0's slices L-0a to L-0c (reserve, issue, return) are done. The order timeline ([order-stage-timeline.md](./order-stage-timeline.md), slice T-0) is built before both, since every stage they add emits into it.

Rules once it exists:

* **Reservation** at order time (as today), per location, converted to a movement on **goods issue**.
* **Goods issue posts when the delivery is dispatched** (leaves the location), by default; configurable to "when delivered" for businesses that want stock to stay until the door. Cost of sales posts with the issue (finance already posts from the ledger).
* A failed or returned delivery receives stock back by a **return receipt** to a chosen location (with a disposition: restock, scrap, quarantine for perishables).
* Pickup: goods issue when collected.
* A scheduled visit issues the materials it uses.

## 8. Dispatch and runs

* **Dispatch board** (admin, desktop and tablet): deliveries ready by day, zone and slot; drag to a run; per-run totals (stops, weight, volume, value, cash due); late and at-risk flags. Assignment is manual first.
* **Run**: rider, vehicle, date, start location, ordered stops, planned window, cash float given, actual start/end, odometer (optional). Closing a run reconciles stops and cash (§10).
* **Capacity and slots**: slots have capacity by count, weight or vehicle; same-day cut-off times; lead times per zone and per item (fresh fish, made-to-order, large items).
* **Route order**: manual drag, "nearest next" suggestion from pins; optimisation sits behind a port later (no vendor chosen).
* **Couriers**: a courier adapter port (create shipment, label, track, cancel, POD) with a manual adapter first (tracking number typed in) so nothing waits for an integration. Webhooks/polling update the delivery; an unreachable courier never blocks the sale (the blueprint's rule).

## 9. The rider app

A mobile web app (installable, offline-first) at `/rider`, for people with the `deliveries:rider` permission, seeing **only their own runs**.

* Today's run: stops in order, address, instructions, call and WhatsApp buttons (the delivery contact, not hidden numbers), navigate (opens the phone's maps).
* At the door: confirm items, take **proof** (customer code sent by message, signature, photo; chosen per company/zone), mark delivered, partial accept, or fail with a reason and a photo.
* **Collect payment**: cash (recorded into custody) or an M-Pesa prompt to the customer's number (the checkout's pay-from-another-number feature already exists), with the payment confirmed by the server, never by the app.
* Works offline: every action is queued with a client-generated id and replayed (idempotent); the server decides on conflicts and says so. A clock-skew check rejects impossible times.
* Safety: no customer data of other runs; sessions expire; location is recorded **per attempt and per stop only** (no continuous tracking unless the company switches it on and tells the rider).

## 10. Money

Three ledgers that must reconcile:

1. **What the customer pays for delivery** — the charge line on the order, revenue in a delivery-income account (configurable per branch/method), taxed per its class, invoiced with the order or per delivery (§11).
2. **What delivery costs us** —
   * *Courier*: a courier is a **vendor**; a shipment accrues a cost, the courier's invoice is matched to the shipments (the supplier-invoice module already matches).
   * *Own fleet*: rider pay per delivery, per run, per day, or commission, as the company sets; settled by the finance payment-run machinery; fuel and vehicle costs optional.
3. **Cash collected at the door** — a **custody ledger** per rider: float issued, cash collected per delivery, M-Pesa collected (does not enter custody), cash handed in (counted, with a witness), variance. A variance above a limit needs approval; a persistent one raises a finding. Handing in posts the cash to the till/bank account chosen; nothing is trusted from the app alone.

Reports: delivery margin (charge minus cost), cost per delivery by zone/rider/courier, on-time rate, failure reasons, cash outstanding by rider, courier invoice variance.

## 11. Accounting and KRA

* **Billing trigger is configurable**: at order, at dispatch, or at delivery (default: at the order for shop orders already paid; at delivery for credit and cash-on-delivery sales). With partial deliveries the billing document follows the delivery.
* The **delivery note** is a printable document (not an invoice) with QR/code for the proof.
* KRA signing extends to the billing document as the blueprint says; the delivery charge is a normal taxable line. Failed and returned deliveries produce credit notes through the existing credit-note flow.
* All postings go through the existing finance posting services; none is written by this module directly.

## 12. Customers: tracking and messages

* A **public tracking page** by an unguessable token (not the order number alone): state, estimated window, rider first name and a masked phone, map pin only when "out for delivery", POD when delivered, reschedule and "I'm not available" buttons within rules.
* **Messages** on events (order confirmed, packed, out for delivery with the code, delivered, failed with reschedule link) through the communications port. Email exists; **SMS/WhatsApp ports are to be added** (the provider is a decision, §17). Messages are rate limited per number and carry only what the page shows.
* The existing "Track my order" modal reads the same data.

## 13. Exceptions, approvals and governance

All through the existing engines, configured not coded:

* Approvals: delivery-fee waiver above a limit, charge override, cash variance, redelivery that costs us, release of a block, cancelling a delivery after dispatch, writing off a lost delivery.
* **Reason codes** (controlled catalogue) for every failure, cancellation, waiver and variance.
* **SLAs**: a delivery late past its window raises a task to the dispatcher, then the supervisor (the approvals escalation machinery is reused).
* Decision log entries for every policy, zone, rate and slot change.

## 14. Security and privacy

* New permissions: `deliveries:read`, `deliveries:manage`, `deliveries:dispatch`, `deliveries:rider` (own runs only), `deliveries:cash` (custody and hand-in), `delivery_rates:manage`, `couriers:manage`. Every action checks on the server; every query is company-scoped.
* Customer address, phone and pin are personal data: masked in lists and rider views of other runs, never in URLs, exports audited, retention configurable (Kenya's Data Protection Act applies).
* Proof tokens and tracking tokens are random, single-purpose, expiring; a code is compared in constant time and attempts are rate limited.
* The rider app trusts nothing it sends: the server re-derives amounts, checks the rider owns the stop, and the stop is in the right state.

## 15. Scale and reliability

* Volumes follow the blueprint (≈ 900k orders a day, peaks ≈ 50k an hour): deliveries are keyset-paged by (day, zone, id); dispatch boards read a narrow index (state, day, zone, slot); events are append-only and partitioned by month when volume needs it.
* Rider traffic is bursty and spiky at shift start/end: the app syncs in small idempotent batches; the server is idempotent by (rider, client id).
* Notifications and courier calls go through the outbox with retries; a failure never blocks a state change.
* Geo: zones are named areas first (indexed lists), polygons later; distance uses stored pins and a straight-line/road factor first, a routing provider later behind a port. No geo extension is required for the first versions.
* Every state machine has a property test; load gates at the end of each phase as in the blueprint.

## 16. Phases

| Phase | Delivers | Gate |
|---|---|---|
| **T-0 (prerequisite, small)** | The order stage timeline: every order stage timestamped from initiation, failures included ([order-stage-timeline.md](./order-stage-timeline.md)) | Every transition in the existing paths produces one event; a refused checkout leaves a trace |
| **L-0 (prerequisite)** | Stock per location: balances, reserve/issue/return per location, transfers, location on documents ([stock-locations.md](./stock-locations.md)) | Reserve/issue/return correct under load; existing orders migrate to a default location |
| **D-0** | Zones, charge policies (all methods, switchable), delivery methods offered per branch (pickup included), the shop's address-first checkout with the quote, charge line on order/quote with trace, pickup with collection code | A charge quoted at checkout equals the charge on the order and invoice |
| **D-1** | Delivery document, partial/back-order, dispatch board, runs, goods issue, order delivery status derived, public tracking page, messages (email first), manual courier adapter, delivery note | An order is delivered in parts, stock and books are right at each step |
| **D-2** | Rider PWA: run, proof, failures, re-attempt, reschedule, offline queue | A run completed offline syncs without duplicates or loss |
| **D-3** | Door payments (cash and M-Pesa prompt), cash custody and hand-in, courier cost and invoice matching, rider pay settlement, delivery margin reports | Custody, cash account and bank reconcile to zero variance in the tests |
| **D-4** | Scheduled visits: appointments, crews, checklists, sign-off, materials issued | A visit completes with sign-off and posts materials |
| **D-5** | Slots with capacity, cut-offs, SLAs and escalation, courier API adapters, optimisation port, analytics | On-time and capacity rules hold under load |

Each phase ships with unit, integration, API and e2e tests (desktop and phone), docs and the permissions it adds, per the project rules.

## 17. Decisions taken (2026-10-27)

1. **All four fulfilment methods** are in scope: own riders/vehicles, third-party couriers, customer collects, installation / scheduled visits.
2. **The charge method is configurable and switchable at any time**: zone rate card, distance, flat or weight only, plus order-value tiers; scoped by branch, channel, customer group and dates (§5).
3. **Customer side, operations and money are all in scope**, built in the order L-0 → D-0 → D-1 → D-2 → D-3 (then D-4, D-5).
4. **Stock per location is built first** (L-0).

## 18. Still to decide (my recommendation first)

1. **Billing trigger default**: at dispatch for credit sales, at order for paid shop orders, at delivery for cash on delivery (as §11). OK?
2. **Rider pay model** to support first: per delivery, per run, per day, commission on order value. Recommend per delivery and per day, others later.
3. **SMS / WhatsApp provider** for messages: which do you use (Africa's Talking, Twilio, WhatsApp Business API, other)? D-1 ships with email and a port.
4. **Couriers** to integrate first (after the manual adapter): which ones do your clients use?
5. **Map provider** for the address picker and distance (Google Maps, Mapbox, OpenStreetMap-based), and whether the shop may require a map pin.
6. **Proof of delivery default**: customer code by message (recommend), with photo as fallback; signature optional.
7. **Cold chain** (fish): a temperature/time-out-of-fridge limit per item, recorded at hand-over? Not in D-1; say if it must be.
8. **Is the delivery contact allowed to differ from the buyer and the payer** (yes in this design: three phone roles: contact, delivery recipient, payer).
