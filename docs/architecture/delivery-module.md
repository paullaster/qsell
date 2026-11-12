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


## 19. Decisions taken (2026-11-01) and the D-0 plan

**Decisions**

1. **Billing trigger default**: at the order for paid shop orders, at dispatch for credit sales, at delivery for cash on delivery (as §11). Configurable.
2. **Maps are plug and play.** Every map capability (search an address, suggest places as people type, turn a pin into an address and back, distance and travel time between two points) sits behind one **geo port**. A provider is one adapter that implements the port, registered by name and chosen with the `GEO_DRIVER` setting (as `MEDIA_DRIVER` chooses storage). No component, server action or rule imports a provider; adding a provider changes nothing else. A built-in adapter that needs no key and no network (straight-line distance with a road factor, and the company's own zone and area lists for place search) always exists, so delivery works with no map provider configured.
3. **The shop asks for the address or a pin first**, and from that decides the **nearest branch**, measured from each branch's own pin. That branch processes the order, and the delivery charge is worked out from the distance between that branch and the customer. Only branches that can cover the order are candidates (stock per location, L-0 sourcing); if none can cover all of it, the nearest branch that can cover the most is used and the rest is split by the existing sourcing rules, with the choice and the reason recorded on the order.
4. **The delivery contact, the recipient and the payer can all differ** (three phone roles).

**D-0 slices**

| Slice | Delivers | Gate |
|---|---|---|
| D-0a | Geo foundation: coordinates on branches (with a screen to set the pin), pure geo maths (distance, nearest), the geo port, its registry and the built-in adapter | Nearest and distance are correct and deterministic; the built-in adapter passes the same contract tests any adapter must pass |
| D-0b | Zones and areas; delivery methods offered per branch; charge policies and rates (all methods, effective-dated); admin screens | A policy in force is found by branch, channel, customer group and date; conflicts are refused |
| D-0c | The quote: branch choice (nearest that can cover), charge by the policy, trace, floor and caps | The same inputs always give the same charge; the trace explains it |
| D-0d | The shop: address-first checkout, map picker through the port, three contact roles, the charge before payment; charge line on order, quote and invoice with its tax | A charge quoted at checkout equals the charge on the order and the invoice |
| D-0e | Pickup: collect from a chosen branch with a collection code | A code collects once, by the right person |


## 20. D-0a as built (2026-11-01): the geo foundation

**Pure maths** (`src/lib/geo.ts`): `readGeoPoint` (typed or reported numbers to a checked point, six decimals), `straightLineKm` (great circle), `estimatedRoadKm` (straight line times the company's road factor, rounded to 10 m so the same two places always give the same number), `rankByDistance` (nearest first; places with no pin set aside; ties keep the order given).

**The port** (`src/server/ports/geo.ts`): `searchPlaces`, `resolvePlace`, `reverse`, `distancesFrom(from, to[])` (one call however many branches), and `capabilities` (what the provider can do, and `clientMap`, the public description of how the browser draws its map). "Nothing found" is an empty answer, never an error; `GeoUnavailableError` means the provider could not be reached.

**Adapters** (`src/server/adapters/geo/`): the built-in adapter (no key, no network, estimates the road, no address search) and the registry. **To add a provider**: write an adapter that implements `GeoPort`, run `runGeoPortContract` from its test with a fake transport, add one line to `GEO_ADAPTERS`, set `GEO_DRIVER`. No screen, action or rule changes. `GEO_ROAD_FACTOR` (1 to 3, default 1.3) sets the built-in estimate.

**The service** (`src/server/domains/geo/service.ts`, `container.geo`): the only way rules ask for a map answer. The chosen provider gets 2.5 seconds; when it fails or is slow the built-in estimate answers and the answer says `degraded: true`, so a map outage never stops a sale and the quote's trace can say which source it used. `nearest(from, candidates)` ranks branches by the provider's distance (road when it can) in one call.

**Branch pins** (migration 0114, `branches.latitude/longitude/pin_label/pin_set_at/pin_set_by`): both numbers or neither and a place that exists (database check). Set or removed on **Settings, Branches** by typing the numbers or using the device's location (checked on the server again; never trusted from the browser), with the permission `branches:manage`, this company only, and a decision-log entry holding the old and new place. A branch with no pin is left out of the nearest-branch choice, and the screen says so.

**Not built yet (D-0a):** a real map provider adapter and the map picker in the browser (the port and `clientMap` are ready for them; D-0d draws the picker), and place search from the company's own areas (D-0b, with zones).

**Verified.** Unit: the maths, the built-in adapter, the registry, the service (fallback, timeout, nearest, ties). Contract: `runGeoPortContract` on the built-in adapter. Integration: the database rule, the actions (permission, company scope, validation, decision log), the list. E2E: setting a pin by typing and by device location, refusing a non-place, changing and removing it, on desktop and phone.


## 21. The customer gives a pin or writes the address (2026-11-01)

On the shop, the customer may **pick a pin on the map or write the address by hand**, whichever they prefer. Both must work everywhere a delivery is priced:

* **A written address** (county, town, area or estate, a description) is matched to a zone through the zone's **areas**: the same words, ignoring case, spacing and punctuation. An area belongs to one zone only, so a written address never has two answers. An address that matches no area has no zone: the quote says so, and a policy that does not need a zone (distance, flat) can still price it.
* **A pin** is matched to a zone by the zone's **coverage circle** (a centre and a radius) when it has one, and always gives a **distance** from each branch's own pin. The nearest circle wins (the smallest radius on a tie, then the code), so a pin never has two answers either.
* **With no pin, a written address has no distance**, so a distance policy cannot price it. The shop then asks for a pin (or for the area), and says why in plain words; it never guesses. A company that prices by distance can require a pin at checkout; one that prices by zone, flat or weight does not need to.
* A pin and a written address given together are both kept. The pin decides the distance, the nearest branch and, when it falls inside a coverage circle, the zone (it is the more exact of the two); otherwise the written address decides the zone. The written address is what the rider reads.


## 22. D-0b, first part, as built (2026-11-01): zones, places and methods

**Tables** (migration 0115): `delivery_zones` (code, name, optional coverage circle kept whole by a database check: all of centre latitude, centre longitude and radius, or none; `version` for optimistic edits; stopped, never deleted), `delivery_zone_areas` (county, town, area, and the three keys they are matched by; one set of keys belongs to one zone in a company, by a unique index; at least one word, by a check), `delivery_methods` (one row per branch and method: own fleet, courier, pickup, scheduled visit; offered or not, the least preparation time in minutes, a note for staff).

**Rules** (`src/lib/delivery-zones.ts`, pure): place names reduced to keys (case, accents, punctuation, spacing, the word "county"); `matchArea` picks the most specific area that covers an address (area, then town, then county; the weights are powers of two so no two different sets of words score the same); `zoneForPin` picks the circle holding a pin (nearest centre, then smaller circle, then code); `resolveZone` lets a pin in a circle decide and falls back to the written address; readers for a zone, an area and pasted lines (up to 200).

**Domain** (`src/server/domains/delivery/`): `DeliveryZones` (create, update with the version the person saw, stop and restart, add places in bulk with a skipped list naming the zone that already has a place, remove a place, page a zone's places, `resolve` for an address and/or a pin in one indexed read plus the few circles) and `DeliveryMethods` (read many branches in one query, set one method with an upsert). Every change is company-scoped, in one transaction with its decision-log entry; a repeat of the same method setting writes no new entry.

**Screens**: **Delivery, Delivery zones** (list with search and "show stopped", a form with the optional circle, a places panel per zone to add one by hand or paste many, remove with a confirmation) and **Delivery, Delivery methods** (every branch with its four methods, each saved with its own button). Permissions `deliveries:read` and `deliveries:manage` (admins). The zone picker `delivery-zones` is registered as a lookup source for the charge screens that come next.

**Verified.** Unit: key reading, matching, circles, the readers, the method settings. Integration: the database rules (circle, empty place, method and time checks), two people editing one zone, two zones adding one place at the same moment (exactly one gets it), resolving an address and a pin, another company's data never seen, the permission each action asks for and a refusal without it, paging with no repeats, the lookup source. E2E: both screens on desktop and phone, with layout checks.

**Next (D-0b, second part):** charge policies and rates (zone rate card, distance, flat or by weight, order-value tiers), scoped by branch, channel and customer group like price lists, effective-dated, with conflict checks and the same lifecycle.


## 23. Charge policies: design (2026-11-01)

Informed by the owner's earlier map and pricing service (see the memory note "Pisces map service reference"): the same pricing dimensions, made deterministic and data-driven.

**Guarantees** (each has a test): (1) **The same inputs always give the same charge.** No randomness, and the clock is passed in. (2) **Quote equals charge**: the charge and its trace are stored on the order with the policy id and version; nothing is recomputed later. (3) **Never a guess**: when a charge cannot be worked out (no zone, no pin, out of range, too heavy, no rate for the weight) the answer is a refusal with a reason code and plain words, never a default price. (4) **The browser supplies only the customer's side** (written address, pin, cart); the server chooses the branch and its pin, the zone, the route, the policy and the weight. (5) A map provider only ever supplies a distance and a time; it never decides a price. (6) The trace explains every shilling, in order, and its steps add up to the amount.

**Methods.** `zone_rate` (a rate card: a fee per zone and weight band, with an optional default row for any zone), `flat` (the same card with default rows only: one fee, or a fee per weight band, everywhere) and `distance` (distance bands, each with a base fee and a rate per kilometre beyond the start of the band; optionally a rate per minute of travel; a maximum range). The three differ only in how the base fee is found; everything after it is shared.

**The shared steps, always in this order:** base fee, weight surcharge (distance method only; the card methods price weight in their bands), time-of-day / day-of-week / season surcharges (fixed or a percentage of the subtotal before any surcharge, so the order they are listed in cannot matter), minimum and maximum charge, order-value tier (a percentage off the capped charge; 100 is free delivery), rounding (to a unit the company chooses, nearest or up).

**Distance** is the longer leg, one way, or round trip (a policy choice); the maximum range is on the one-way distance. A written address with no pin can be priced by distance only when the geocoder placed it; the quote then says the distance is approximate.

**Time rules** use the company's time zone and are data, not code: days of the week, a window of the day (it may cross midnight: 22:00 to 06:00 belongs to the day it began), and a date range (it may cross the new year: December to February).

**Scope and choice** reuse pricing's scopes (branch, channel, customer group, customer, country, sales type), its specificity weights and its tie check: among policies in force whose scope and dates match, the most specific wins, then the higher priority, then the newest start, then the code (as price lists do). Activating a policy that would tie with one already in force is refused, naming the other.

**Lifecycle**: draft, in force, retired. A policy in force cannot be edited; make a new version (copy to draft), or retire it. Every change has a reason and is in the decision log. A quote simulator shows the charge and the trace for any address, pin, weight, order value and time before a policy goes live.

**Slices**: D-0b2a the pure engine (this section); D-0b2b the data model, lifecycle and actions; D-0b2c the screens and the simulator.


## 24. D-0b, second part, as built (2026-11-01): charge policies, the quote and their screens

**Engine** (`src/server/domains/delivery/domain/`, pure): `quoteCharge` works the charge out and explains every step; `choosePolicy` and `wouldTie` reuse pricing's scopes, specificity and tie rule; `validatePolicy` decides what may go live; `readPolicyInput` turns what the browser sent into a policy (size limits, plain-language errors, dates as business-time days: a first day starts at local midnight, a last day includes the whole day). The promises of section 23 each have a test, including one that checks that a policy that passes validation can always be priced unless an input it needs is missing.

**Data** (migration 0117): `charge_policies` (code and version, status, scope, dates, the distance and rounding settings; bands, order-value steps and time rules as small lists) and `charge_policy_rates` (the fees of a rate card). The database keeps one draft and one version in force for each code, and checks the basics (status, method, currency, dates, charges).

**Life of a policy** (`ChargePolicies`): draft, saved with a revision check; a new version copies a policy in force or retired into the next draft; **putting a draft in force** needs a reason, a sound policy, zones that are in use, and nothing in force that would tie with it, and in the same transaction retires the version it replaces; retire needs a reason; a draft can be discarded and nothing else can be deleted. Each step is in the decision log with its reason. Permission `delivery_rates:manage` writes; `deliveries:read` reads and tries.

**The quote** (`DeliveryQuotes`): from a branch and the customer's address or pin it finds the zone, measures the distance from the branch's own pin (a map service with the built-in estimate to fall back on; for a written address with no pin, the address is placed on the map and the distance is marked approximate), chooses the policy and returns the charge with its trace, the zone, the route and which policies were looked at and why each won or lost.

**Screens**: **Delivery, Delivery charges**: the list (in force and drafts, retired, all), an editor (basics, who it is for, the three methods, limits and rounding, discounts for bigger orders, extra charges for busy times), the lifecycle buttons (put in force and retire ask why first), and **Try a delivery charge**, which asks the server what an order would be charged and shows the steps. Selection uses pickers (no native select); scope pickers use delivery-specific lookup sources behind `deliveries:read`.

**Verified.** Unit: the engine, time rules, selection, validation, the reader, the form conversions. Integration: the whole lifecycle, two people at once (saving a draft, putting one in force), ties, stopped zones, company isolation, the quote end to end including the map fallback, permissions. E2E: write, refuse, put in force, try, version and replace, on desktop and phone.

**Known limits.** (Both of these were closed in §25: rate cards can be pasted, and D-0c puts the charge on the order.) At the time: a rate card was edited row by row; the charge was not yet applied to an order: D-0c chooses the nearest branch that can cover the order and D-0d puts the charge on the shop checkout, the order and the invoice, with its tax.


## 25. D-0c as built (2026-11-01): the branch that delivers, the charge on the order, and the rate card paste

**Stock locations and branches.** A branch has one or more stock locations; a location belongs to one branch or to none (company stock, such as a central warehouse). What a branch can deliver is the free stock (on hand less reserved) in **all** of its own active locations that sell to the order's channel and may dispatch deliveries, **plus** the company stock that belongs to no branch, which every branch can draw on. Another branch's locations are not counted: moving stock between branches is a transfer, not a sale (`StockAvailability.byBranch`, one query however many branches and products).

**The choice** (`src/lib/branch-choice.ts`, pure). Of the branches that can cover the whole order, the **nearest to the customer**. When none can, the one that covers the most (lines, then units), and of those the nearest; the rest is sourced by the stock rules from other locations. A branch is left out, and the reason kept, when it does not offer the method (`delivery_methods`), has no map pin while the customer's position is known, or holds none of the goods. Ties go to the branch code, so the answer never depends on the order the rows were read in. When the customer's position is not known (a written address the map could not place), the branch is chosen by what it holds, and the reason says so. Reasons: `only_candidate`, `nearest_covers_all`, `nearer_lacked_stock` (with the nearer codes), `best_cover`, `position_unknown`; each has a sentence for people.

**The plan** (`DeliveryPlans.plan`, `container.deliveryPlans`). From the basket, the channel, the method and the customer's pin or written address it places the customer (a pin as given; an address on the map, marked approximate), ranks the branches by the map service's distance in one call (the built-in estimate answers when a provider is down, and the plan says `degraded`), chooses the branch, then asks `DeliveryQuotes` for the charge **from that branch** under the policy that applies to it, channel, customer group and time. It never takes a branch, a policy or an amount from the browser. A plan that cannot be made says why in words: `no_destination`, `no_branch` (naming each branch and why it was left out), or the quote's own reasons (`no_policy`, `out_of_range`, ...). If the branch that is nearest has no policy in force, the plan refuses and says so rather than quietly using a farther branch with another price list: a missing policy is a setup mistake to see.

**On the order** (`OrderWriteService.createOrder({ delivery })`). Before stock is held, the plan is made; the chosen branch becomes the order's branch (stock is held at that branch's locations first, the order number series and approvals use it), the charge becomes its `shipping_fee`, and `total = subtotal + tax + charge`. A plan that fails refuses the order with the code `delivery_unavailable` and nothing is held or saved. In the order's own transaction `order_deliveries` gets one row (method, branch, where to, the **choice** with every branch considered and why, and the **charge** with its steps), a `delivery.branch_chosen` entry goes to the decision log, and the timeline gets **`charge_quoted`** with the reason in words. `charge_quoted` is a non-tracking stage: like the stock stages it does not change where the order is. The row cannot be edited afterwards (a database trigger; a removed branch only loses its link), so a later change to a policy, a zone or stock never alters what an order was told. An order without `delivery` behaves as before.

**Weight and tax.** The weight of an order is the sum of each product's base-unit weight times its quantity; a product with no weight counts as nothing, and the screens that set weights should be filled in for charges by weight to be right. The charge is carried as the order's shipping fee and posted as before (to the service-charge account); **tax on the charge and its line on the invoice are D-0d**.

**Rate cards can be pasted** (`ChargeRatePaste`, `src/lib/rate-card-paste.ts`). Rows copied from a spreadsheet (tabs), or typed with semicolons or commas; a header line is skipped; up to 1000 fees at once. Each line with a mistake is named with its number and why; zone codes are matched on the server (`matchZoneCodesAction`, `deliveries:read`, this company only), and an unknown or stopped zone is said apart. The card changes only when every line is sound and every zone matched ("Replace the fees" or "Add to the fees"). A long card shows its first 50 rows and the rest on request.

**Not built yet (D-0c):** the shop's address-first checkout and the map picker (D-0d); the tax on the charge and the charge line on the invoice (D-0d); collection from a branch with a code (D-0e; the plan refuses `pickup` for now); showing the choice on the admin order page (it is on the timeline, in words).

**Verified.** Unit: the branch choice (nearest that covers, passed-over branches, partial cover, exclusions, no position, ties and order independence, words), the paste reader. Integration (database): choosing among branches with several locations each and company stock, a location that may not dispatch deliveries, partial cover, branches with no pin or without the method, the same answer every time, an address the built-in map cannot place, no policy; an order placed with delivery (branch, fee, total, record, timeline order `order_placed`, `charge_quoted`, `stock_reserved`, the hold at the chosen branch's location, the decision log), a caller who passes a different branch or amount, a refused delivery leaving no order, an order without delivery unchanged, and the record's immutability; zone-code matching (case, unknown, stopped, other company, bad input, permission). E2E: pasting a rate card on desktop and phone.


## 26. D-0d as built (2026-11-02): the map service, the shop checkout, tax on the charge

### 26.1 Choosing the map service (Delivery, Map service)

**What an administrator sees.** Four services side by side, each laid out with the same rows: what a month costs **at the shop's own volume**, price and billing, reliability, how it has actually behaved **for this shop**, limits, search while typing, road distance and time, Kenyan places and addresses, what its terms ask, best for, watch out for, and links to the provider's own pages. The shop's volume is filled in from its last 30 days of orders and its branches; the administrator can change the numbers to plan for growth, and can enter a shillings rate to see costs in KES. Notes that are our judgement and not the provider's statement are marked "our view".

**Facts and where they come from** (`src/lib/geo-providers.ts`, checked 2026-11-01, each with its source linked on the card):
- **OpenStreetMap** (Nominatim for places, OSRM for roads, Leaflet in the browser): free on the public servers, with no uptime promise. Nominatim allows at most one request a second for the whole business, requires results to be cached and an identifying user agent, and **forbids search as people type**; the tile servers allow normal viewing only (no bulk download), require attribution and a referrer, and promise nothing; the OSRM demo server is for light use with no guarantees. So the adapter spaces public requests a little over a second apart, remembers answers for a day, identifies the business with the contact email the administrator gives, and searches only when the shopper presses Search. Pointed at a server of your own or a paid host running the same software (the three addresses are settings), it is not slowed and allows search as people type.
- **Google Maps Platform**: pay by use after a monthly free allowance; at the basic edition 10,000 free calls a month for Geocoding, Route Matrix and Dynamic Maps, then about US$5 per 1,000 geocodes and route elements and US$7 per 1,000 map views, cheaper at higher volume (tiers in the catalogue, read from Google's pricing page). A 99.9% monthly uptime target with service credits of 10%, 25% or 50%. A billing account and key are needed, and its terms limit storing results. **Its connection is not installed yet**: it is shown for comparison and cannot be chosen.
- **Mapbox**: shown for comparison only. The prices found in public sources disagreed, so **no number is shown**; the card links Mapbox's own page. Not installed yet.
- **Built-in estimate**: free, always there, straight line times a road factor; it is also what every other service falls back to.

**Cost estimate.** `estimateCost` turns orders, branches, lookups per order, delivery prices per order and map views per order into the calls each service bills for (address lookups, route-matrix elements, map views) and charges Google's tiers graduated (free allowance, then each band at its own rate). OpenStreetMap shows "free" but a **volume fit**: about 1,000 requests a day is light, above that "plan to move to a paid host", above 5,000 "weak" (these thresholds are our rule of thumb, stated as such).

**Evidence from the shop's own use.** Every call to the map service is counted by provider, kind and hour (`geo_usage`, one row per hour, never per call): how many worked, how many failed or fell back to the estimate, how long they took, and the shares answered within half a second, one second and two and a half seconds (the longest a shopper is made to wait). The card for a service shows these once it has been used, over the last 30 days.

**Choosing.** Settings are version-checked (two people saving get one winner), need a reason of a few words, are checked on the server (https only; not this machine or a cloud metadata address; a contact email for OpenStreetMap), and go to the decision log with the old and new service. **Try it now** runs three real steps with the form's settings without saving: find a place, name a pin, measure a road (Nairobi to Nakuru, checked for believability), each timed, spaced eight seconds apart. A service that fails its try can still be saved, because delivery falls back to the estimate rather than stopping a sale, but the screen says what failed first. The choice is remembered for 30 seconds by the services (a save clears it at once); a saved choice that can no longer be built falls back to the estimate. Needs `deliveries:read` to see and `deliveries:manage` to change or try.

**Adding another provider** is still one adapter, its contract tests, one line in `GEO_ADAPTERS`, and an entry in the catalogue (with its prices and its settings form fields).

### 26.2 The shop checkout (address first)

**The section** ("Show us where to deliver", inside Delivery address): the shopper drops a pin on the map (Leaflet with the chosen service's pictures and its attribution), searches for a place **by pressing Search** (never as they type on the free servers), uses the device's location, or just writes the area; the address above gains an "Estate or area" field. A pin names itself (the service's reverse lookup) and one button fills the written address from it. Someone else can be the recipient (name and mobile number, checked on the server) and a note can be left for the rider; the payer is the existing "number to pay from". The map cannot be used by keyboard, so the written address and "use my location" are always offered beside it.

**The charge before payment.** After a short pause, whenever the place, the way of delivering or the basket changes, the browser asks `shopQuoteDeliveryAction` for the delivery. The server prices the basket the way the shop prices an order (the same price lists, customer and branch), breaks kits into their parts, chooses the nearest branch that can cover it (D-0c), works the charge under the policy that applies and answers with the branch, why, the charge with its tax, how it was worked out, and a caution when the distance is a guess (a written area placed on the map) or only an estimate. An answer to an earlier question is never shown for a later one. The summary shows "Delivery from <branch>" and a total that includes it, and the button says what will be paid.

**The order carries what was shown.** The checkout sends the charge the shopper saw (`expectedCharge`). The order's own charge is worked out again, on the server, at placement; if it is not the same to the cent, the order is **refused and nothing is saved** with "the delivery charge is now X and not the Y you were shown" (`delivery_changed`), and the screen prices it again. So a stale screen, a changed policy or a price-list difference can never charge an amount that was not shown. The shopper's browser supplies only the basket's ids and quantities and the place; never a branch, a price or a charge.

**Gate.** The shop offers a way of delivering only where a branch really offers it **and** a charge policy in force covers that branch for the shop. A method switched on before its charges exist never stops anyone checking out; a shop with neither is unchanged.

**Limits.** The search and pin lookups and the delivery price are rate limited per address (`shop_map_search_ip`, `shop_delivery_quote_ip`).

### 26.3 Tax on the charge, and what the order records

A charge policy now has a tax rate and says whether its amounts already include the tax. The charge splits to the cent into **net** (kept as the order's shipping fee), **tax** (added to the order's tax, so the books, the invoice and the total agree) and **gross** (what the customer pays for delivery); `order_deliveries` keeps all three, the rate, who receives it and the note for the rider. The split, the amount and the rate are frozen by the database trigger; the recipient and the note may be corrected before dispatch. A check constraint keeps net plus tax equal to the amount.

### 26.4 Known limits

- **eTIMS / KRA.** The tax-invoice payload is built from the order's product lines and the order total; delivery is not sent as a line. This was already so for any shipping fee, but delivery charges are now real, so **the delivery line must be added to the KRA payload before delivery charges are used on invoices that are signed**. Not done here; flagged.
- The invoice and the invoice PDF show the shipping fee as a row and the tax in the tax total; the delivery tax is not yet a separate line.
- Saved addresses do not yet keep a pin.
- The Google and Mapbox connections are not installed; the screen shows them for comparison.
- A map picker needs a map service with a picture server (OpenStreetMap); with the built-in estimate there is no map, and shoppers write the area or use their location.
- Cash on delivery billing at delivery, pickup with a collection code (D-0e), rider and run dispatch are later slices.

### 26.5 Verified

Unit: provider catalogue and cost arithmetic (tier boundaries, monotonic), volume fit, settings checks (https, blocked hosts, tile placeholders, country codes), usage summaries, the OpenStreetMap adapter against fake servers (headers, spacing, caching, chunking, unroutable places, failures), the registry and service (recording, choice, fallback), the delivery tax split, the checkout input (delivery, recipient, amounts), branch choice. Integration (database): saving the choice (reason, validation, version conflict, two at once, decision log, effect on the services), usage counting and metrics, trying a service, permissions; orders with tax (added and included), the shown-charge guard, recipient and note, the shop quote equal to the order's charge, refusals in words, the gate, search and pin naming. E2E: choosing a service with the cost screen on desktop and phone; the shop checkout from a written area, then a device-location pin, a recipient, the charge and its tax shown before payment and the order carrying exactly that.


## 27. Delivery on the invoice and at KRA (2026-11-02)

**The setting** (Delivery, Delivery invoicing; `delivery_billing_settings`, one row for each company, version-checked, a reason of a few words, decision log `delivery.billing_changed`; `deliveries:read` to see, `deliveries:manage` to change):

| | On the same invoice (`with_goods`, the default) | On its own invoice (`separate`) |
|---|---|---|
| Invoice | One tax invoice. Delivery is a line beside the product lines. | The products' tax invoice as before, plus a second tax invoice for the delivery service. |
| Tax shown | Subtotal (products and delivery, before tax), then **VAT on products**, **VAT on delivery (16%)**, **Total VAT**, then the total. | Each invoice shows its own VAT; together they are the order. |
| Number | One. | Two, both from the **same tax invoice series** (one legal sequence); the delivery invoice is its own document of the order. |
| KRA | One signing, with the delivery service item as a line. | Two signings, each its own document in the signing log (`order:<id>:tax_invoice`, `order_delivery:<id>:tax_invoice`), each with its own receipt. |

An order with no delivery charge, a free one, or an older order with a shipping fee and no delivery record is laid out exactly as before in either mode (the old "Shipping" row is kept for the last).

**One plan for every output** (`src/lib/delivery-invoicing.ts` `planInvoices`, read by `invoicePlanFor`): the invoice, its email, the PDF and what is sent to KRA all come from it, so they cannot disagree. The order keeps `subtotal` (products before tax), `tax` (products and delivery), `shippingFee` (delivery before tax) and the total; the delivery's own net, tax, gross and rate are kept on its record. Tax on the products is the order's tax less the delivery's. A layout whose invoices do not add up to the order, to the cent, is refused and never issued. A proforma is one request for payment, so it always shows delivery with the goods.

**What KRA is sent.** eTIMS takes registered items, so the delivery service is a **product the company chooses** (a service item created under Products and registered under KRA, eTIMS items). The delivery line is that item, quantity 1, at what the customer pays for delivery (tax included), like the product lines; the tax class comes from the item at KRA. The goods line amounts, the total and the frozen record of what was sent (used by credit notes) are as before, with the delivery line in them when it is on the invoice. Signing is **refused, in words, and nothing is sent** when no item has been chosen (`DELIVERY_ITEM_NOT_SET`) or when the item's tax rate is not the tax the delivery was charged (`DELIVERY_TAX_MISMATCH`: KRA works the tax from the item, so a mismatch would sign a wrong tax). The settings screen names charge policies in force whose tax differs from the item's before an invoice is refused, and says whether the item is registered.

**The separate delivery invoice.** Issued when the goods invoice is issued (generating the goods invoice starts the delivery invoice too, in the background, numbered once; asking again returns the same number). It can be downloaded or emailed on its own (document type `delivery_invoice`, "Tax Invoice: Delivery Service"). Its KRA status is kept on the delivery record (`order_deliveries.invoice_kra_status`), so it never overwrites the order's own KRA status, which is the goods invoice's.

**Limits.** The credit note's goods lines keep their old behaviour (see §27.1). Orders invoiced before this layout existed have no delivery line to credit. Google and Mapbox adapters, D-0e and rider dispatch are later.

**Verified.** Unit: the plan in both modes (tax parts add up, subtotal plus tax is the total, free and no delivery unchanged, old shipping row kept, rounding to the cent, refuses a plan that does not add up). Integration (database, a pretend KRA that keeps what it is asked to send): the setting (default, save with reason, validation, stale version, two at once, log, tax mismatches named, permissions); one invoice (the lines KRA is sent, the total, the layout, the document and the tax parts, refusal without an item, refusal on a tax mismatch); two invoices (what each sends and the totals adding up to the order, each its own document in the log, the delivery status on the delivery record, both issued from the one series once, titles, nothing to give when delivery is with the goods); an order with no delivery unchanged. E2E: the settings screen on desktop and phone (default, the example for each choice, saving with an item and a reason, kept after reload).


### 27.1 Credit notes, the order screen and the timeline (2026-11-02)

**Credit notes follow how the invoice was issued, not today's setting.** The tax invoice's record keeps `deliveryBilling` (the mode) and `deliveryServiceProductId` in its `meta`; `invoicedLayout` reads them and `src/lib/delivery-credit.ts` (pure) turns them with the delivery record into a credit target.

| Invoiced | Credit |
|---|---|
| On the same invoice | Delivery is one more creditable line of the goods invoice ("Delivery", quantity 1, what the customer paid with tax), found by the delivery service item, and sent to KRA against the signed line. It is a service: nothing is expected back into stock, and it earns no rebate or loyalty points, so those use the goods lines only. |
| On its own invoice | The goods invoice's creditable total is the order total less delivery. The delivery is credited in full (`issueForDelivery`, one line, once) in a credit note of its own against `order_delivery:<id>:tax_invoice`, signed against the delivery invoice's number. It goes through the same approval workflow (`credit_note.requested`, payload `delivery: true`). A line for the delivery on the goods invoice is refused. |
| Before delivery had a layout, or no charge | Nothing of delivery to credit; as before. |

The credit-note panel shows the delivery line (same invoice) or a "Credit the delivery invoice" block (own invoice), with the reason and note given above it.

**Order screen.** Orders whose delivery is billed apart show **Delivery Invoice PDF** and **Email Delivery Invoice** beside the tax invoice buttons (`deliveryInvoiceAvailableAction`, `orders:read`).

**Timeline.** The delivery invoice's KRA result is on the order's timeline as `delivery_invoice_signed`, `delivery_invoice_failed` (with the reason code and message) and `delivery_invoice_skipped` (migration 0123 adds them to the stage check). They are non-tracking stages and change no column, so `orders.kra_transmission_status` stays the goods invoice's.

**Known, not changed here.** A goods line is credited at its line price (before tax for a tax-exclusive product), as credit notes always did; the delivery line is credited at what was paid (tax included), which is how it is invoiced and sent to KRA. Aligning goods credits with tax-inclusive amounts is a separate change to the whole credit-note flow.

### 27.2 The delivery service item is a service (2026-11-02)

The item that stands for delivery on an invoice must be a **service**. What makes a product a service is its `inventory_kind` (`service`, stored on the product so the stock ledger can rely on it); it is not read from the business classification, because a classification is a name the seller can rename and retype.

The two are connected by a starting point. A **business classification** has `default_inventory_kind` (migration 0126; "Behaves as" on the screen: Inventory item, Non-inventory item or Service). A new product takes it unless the caller names a kind, and the product form presets the Stock behaviour tab from it. Changing a classification's behaviour changes only products made afterwards; a product keeps its own kind and can still be changed until it has stock or documents.

What a service needs: no stock, **no cost of goods** (an empty cost is stored as 0; goods still must give one) and, when its classification is not sold from the shop, **no selling price**. A classification that is sold from the shop still asks for a price. Delivery fees come from the charge policies, never from the item's price; the item supplies its name, tax rate and KRA registration (§27).

The delivery invoicing screen offers only services, and saving refuses anything else. An item chosen before this stays working at signing; the screen flags it ("This item is not a service") so it can be replaced.

Not done: a CSV import with a blank "Inventory_Kind" still means Inventory; it does not look at the classification.

## 28. D-0e as built (2026-11-03): collecting an order from a branch

**What the shopper sees.** At checkout, "Collect from a branch" is offered when at least one branch offers collection. Choosing it removes the delivery address and shows the branches that offer collection **and hold every line of the basket** (`DeliveryPlans.pickupPoints`), each with its address, phone, landmark, how soon an order is ready (the branch's preparation time) and any note. A branch without everything is shown but cannot be chosen. Collecting is free: the quote is a zero charge with no policy (`ChargeRecord.policy` and `QuoteResult.policy` are null for collection), the order summary says "Collect from <branch>: Free". After paying, the confirmation page and **Track my order** show the branch and a six-character **code** (`ABC-DEF`); once collected they show "You have collected this order" and no code.

**What the server decides.** The browser sends only `pickupBranchId`. `planPickup` checks, again at the moment the order is placed, that the branch belongs to the company, is active, offers collection, and holds the whole order (with the per-location ledger on; without it there is no stock by branch). The order's shipping address is written by the server as "Collect at <branch>, <street>"; the customer's own saved address is never touched. The checkout parser (`parseCheckoutInput`) accepts an empty address only for collection.

**The code.** Six characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0, O, 1, I, L), drawn without bias (`src/lib/collection-code.ts`). It is made in the order's own transaction, so there is never an order without its code. At rest it is **sealed** with the data-encryption key (so the customer can be shown it again) and kept as a **keyed hash** over `orderId:code` (so a typed code is checked without opening anything, in constant time). Neither the decision log nor the timeline contains it. A pickup order needs `DATA_ENCRYPTION_KEY`, as payment credentials do; without it the order is refused rather than storing the code in the clear.

**The table** `order_collections` (migration 0128): one row per collected order with `status` (`waiting`, `ready`, `collected`, `locked`, `cancelled`), the sealed code and its hash, wrong tries, and who handed it over, when and how. Database checks make the invalid states unstorable: *collected* means a time, a person and a way; an ID hand-over names the ID; a branch with orders cannot be deleted.

**At the counter** (`OrderCollections`, panel "Collection" on the admin order screen):

| Step | Permission | Rules |
|---|---|---|
| Mark ready | `deliveries:handover` | Records `ready` on the order's timeline. Refused for an unpaid, cancelled, refunded or approval-held order. |
| Hand over with the code | `deliveries:handover` | Typed any way (capitals, spaces, hyphens). **Once**: the collection row is locked, so two counters typing the right code at once hand it over once. A wrong code is counted, recorded as a failed `delivery_attempted` stage with its reason, and after **five** the code is locked. The order becomes `delivered` with `collected` on its timeline. |
| Hand over after an ID check | `deliveries:handover_override` | For a customer with no code (or a locked one). Needs what ID was seen and why; both are kept in the collection row, the timeline and the decision log. |
| Give a new code | `deliveries:handover_override` | Needs a reason; the old code stops working, tries start again, a locked order opens. The new code is shown to the staff member once. |

The customer's own look-up (`trackedCollectionAction`) uses the same proof as tracking an order (order number plus the email or phone it was placed with) and is limited by address and by order number (`collection_lookup_ip`, `collection_lookup_order`) so a number and contact cannot be guessed. Managers and administrators have both permissions by default.

**Stock.** Unchanged: stock for the order is consumed when payment succeeds, as for every order. The design's "goods issue when collected" belongs to the goods-issue slice of D-1, which makes the moment configurable for all orders.

**Verified.** Unit (`collection-code`, the checkout parser), integration (planning and the pick checked on the server, the order and code made together, the code never in the clear, unpaid and cancelled refused, ready then once-only hand-over including a race, wrong tries and the lock, ID check, a new code, company isolation, database checks, permissions, the customer's look-up) and end-to-end on desktop and phone (checkout, the customer finding the code, the counter, the ID check).

**Not built yet.** The code is not emailed or texted (there is no message to the customer when an order is ready; that is D-1's messages). An order that is never collected is not expired or cancelled. Someone other than the buyer can collect only by showing the buyer's code or by an ID check at the counter; there is no "authorised collector" field.

## 29. D-1a as built (2026-11-03): the delivery document

**What it is.** A *delivery* is one go at getting some or all of an order to the customer: picked, packed, sent out, delivered. An order that is delivered by the shop's own riders or by a courier can have several (what is on the shelf now, the rest later). Orders that are collected from a branch have no delivery document: they have the collection code (§28). Visits come in D-4.

**Tables** (migration 0129): `deliveries` (number from the `sales_delivery` series, `DLV-{YY}-…`; the method, branch and destination copied from the order's delivery record; recipient, notes, courier and tracking number; a `version` for the two-people-at-once check; the time of each step), `delivery_lines` (planned, picked, delivered per product, in the product's base unit, with checks that picked never exceeds planned and delivered never exceeds picked) and `delivery_events` (the delivery's own history: kept, a trigger refuses any change or delete). A finished delivery (delivered, returned or cancelled) cannot change state, even straight in the database.

**States** (`src/lib/delivery-document.ts`, the only place that says what may follow what):

```
draft → released → picking → packed → ready → out_for_delivery → delivered
                      ↺ record what was picked (until it is packed)
out_for_delivery → failed_attempt → ready (try again, at most 3 times) | returned
draft, released, picking, packed, ready → cancelled
```

**Splitting an order.** `allocate` gives a delivery everything the order has left, or what is asked for, never more than is left of each product. The order is locked while a delivery is made, so two people asking at once cannot take the same goods (the second is told there is nothing left). Quantities are checked against the product's unit (no half a piece). **A short pick** (less picked than planned) is recorded, and the difference is open on the order again, to go on another delivery or be cancelled; what is delivered is what was picked. A returned or cancelled delivery gives its goods back to the order the same way.

**The order's delivery status is never stored.** `orderDeliveryStatus` works it out from the deliveries: not started, on its way, partly delivered, delivered, needs attention (a failed attempt). The order's own status becomes *shipped* when something is sent out, and *delivered* only when **every product is delivered in full**; before that a delivery that arrives records the new stage `part_delivered` ("Part of your order delivered", migration 0129 adds it to the stage check), which does not move the order's status.

**Every step** (`DeliveryDocuments.step`) locks the delivery, checks its version when the screen sends one ("Someone else changed this delivery… reload"), checks the rules, changes it and writes its event and the order's stages in **one transaction**: `released_for_fulfilment`, `pick_started`, `picked`, `packed`, `ready`, `dispatched` and `out_for_delivery`, `delivery_attempted` (failed, with its reason), `delivered` or `part_delivered`, `delivery_failed`. Cancel, return and a failed attempt also go to the decision log with their reason. Releasing and sending out are refused for an order that is unpaid (a sale on account is paid later), cancelled, refunded or waiting for approval. Failure reasons come from a list (nobody there, refused, wrong address, unreachable, damaged, not safe, other, which needs words); returning and cancelling need a reason; a courier delivery says which courier has it.

**Permissions.** `deliveries:read` to see; `deliveries:fulfil` for every step (administrators and managers have it). The list, each delivery and the order's own panel are read behind `deliveries:read`; the buttons are shown only to people who can use them, and the server checks again.

**Screens.** Delivery › **Deliveries**: a list, newest first, kept to the server (keyset paging, search by delivery number, order number or customer, a state picker). Each delivery has its own screen with what it carries, the steps that fit its state, who receives it and its history. The order screen has a **Deliveries** panel: the order's delivery status, what is left of each product, its deliveries, and a form to make another from what is left.

**Not built yet (the rest of D-1).** Stock does not move with these steps: it is still consumed at payment, and returning a delivery does not put stock back (so `returned_to_stock` is not recorded); the configurable goods issue and the return receipt with a disposition are the next slice. No dispatch board, runs or riders (D-1c, D-2), no public tracking page or messages to the customer (D-1d), no delivery note (D-1e), and a courier's status is typed in rather than received. A delivery is accepted whole: partial acceptance at the door (refused or damaged items) comes with the rider app.

## 30. D-1b as built (2026-11-03): when stock leaves, and goods that come back

**The setting.** *Delivery › Stock timing* (`stock_settings.issue_moment`, migration 0130) says when the stock of an order that is **delivered** (own riders or a courier) leaves the shelf: **at payment** (the default, and what every shop did before; nothing changes until a shop chooses otherwise), **when a delivery goes out**, or **when a delivery arrives**. Orders that are collected, and visits, are always issued at payment. Choosing anything but "at payment" needs stock to be kept by location (the ledger), because only the ledger can issue part of what an order holds; until then the choice is refused in words and the setting reads as "at payment" whatever it says. Changing it needs `stock:cutover`, is written to the decision log, and applies to orders paid from then on: an order paid earlier has nothing held, so its deliveries issue nothing a second time.

**How it works.** At payment, `fulfilOrder` leaves a delivered order's holds in place (and clears their expiry, so a paid order's hold does not lapse) when the shop issues later. Each delivery step that is the chosen moment (`dispatch` or `deliver`) then calls `StockReservations.consumePartIn` inside the step's transaction: it issues what that delivery carries (picked, or planned, less what it has already issued), from the order's holds in their fixed order, as a `sale_issue` at the place each was held. A hold issued in part stays open for the rest (`partly_consumed`); the move is keyed by delivery, so the same part posted twice moves stock once; a product the order holds nothing of is left alone. The delivery line records what was issued (`delivery_lines.issued`, never more than was picked) and the order's timeline gets `stock_issued` with the delivery and the step. The old journal keeps its single line per order and product, now adding each part to it, since the books and credit notes read it.

**Goods that come back.** A returned delivery is *received*: product by product, how many came back (no more than left the shelf, or was picked) and what to do with them, with one receipt for each product, kept (`delivery_returns`, an append-only trigger). The choices follow what happened to the stock: **back on the shelf** (the delivery issued it: a `sale_return` at the place it was held, and `returned_to_stock` on the order's timeline) or **damaged** (counted back, then written off, so the sale's cost is undone and the loss recorded; written off the books if it never left them); **keep for the order** when the stock was issued some other way (at payment) or never issued. Goods counted back or written off are **held again for the order**, since the order is owed them: without a hold, the next delivery would take them off the shelf with nothing on the books to say so. If the shelf cannot cover the hold (spoilt goods with nothing to replace them), nothing is received and the person is told why. A write-off is also in the decision log with the note.

**Not built.** Switching an existing company from "at payment" to a later moment does not move orders already paid. Counters mode (no ledger) is always "at payment". A damaged return posts the write-off as a plain stock movement; its accounting treatment follows what the books already do for write-offs. Receiving is per product, all at once or in turns, but not corrected afterwards: a mistake is put right with a stock adjustment.

## 31. D-1b, finished (2026-11-04): older orders, corrections, and how returns relate to finance returns

**Orders already paid.** Delivery › Stock timing has an *Orders already paid* panel once a later moment is chosen. An order paid before the choice had its stock taken off the shelf at payment. For goods that have not left yet, `StockReissue` counts the stock back (`sale_return`, the old journal given back) and holds it for the order's deliveries, so the order behaves like one paid today. What counts as "gone" follows the choice: with *when a delivery goes out*, deliveries that are out, failed or delivered; with *when it arrives*, only delivered ones (so goods on the road are counted back, and issued again when they arrive). Left alone: collected orders, orders not paid or cancelled, orders any delivery has issued under the new rule, and orders with a return receipt. It is done in batches of orders (each its own transaction), once for each order and product (a second run finds nothing), and an order that cannot be done (its stock place was stopped, say) is skipped with its reason and passed over, so one bad order never holds up the rest. Needs `stock:cutover`; each order is in the decision log.

**Corrections.** A return receipt is never edited. *Correct this receipt* undoes exactly what the receipt did (the movements are reversed with adjustments, the holds made again are given back, the old journal takes the goods again; the receipt stored its own list of these) and does the corrected receipt, in one transaction, as a new revision with its reason; the earlier one stays on record and shows on the screen. It is refused once the goods have gone out again (a hold the receipt made has been used), since putting it right would change what was shipped; a stock adjustment puts that right. The first receipt's key is `…:r1`, each correction's `…:rN`, so every movement is once for each revision.

**Returns here and in finance (checked).** The finance return receipts (`return_receipts`) are goods coming back *after a sale* because of a credit note: the customer sent them, the sale stands undone, money goes back. A returned *delivery* is goods that never reached the customer: the sale stands and the goods are owed again. Different causes, so different documents. What they now share: **the same words** for what is done with the goods (*Put back into stock*, *Quarantine (not for sale)*, *Scrap / write off*, from `return-form.ts`; a delivery adds *Keep for the order*), and the same meaning: good goods go back on the shelf, goods to look at go to a quarantine place (a location of kind quarantine, near the branch; refused in words if the company has none) and are never sold from there, scrap is written off. The old *Back on the shelf* and *Damaged* became *return_to_stock* and *scrap* (migration 0131 renames them). Not shared: a delivery return has no *condition* or *return to supplier*, and does not create a credit note. A credit note raised for goods that a returned delivery never delivered is a finance question for the people who raise it; the two documents do not look at each other yet.

**Also fixed.** The old settlement journal now gives goods back when they are counted back, so a return followed by a second delivery does not count the same goods twice (credit notes read that journal).

## 32. D-1c as built (2026-11-04): dispatch board, runs and couriers

**Runs** (`delivery_runs`, `delivery_run_stops`, migration 0132; numbers from the `delivery_run` series, `RUN-{YY}-…`). A run is a rider's trip from one branch on one day: rider, vehicle, notes. Planned → on the road → completed (or cancelled before it goes). A ready delivery of the run's branch, carried by the shop's own riders, is put on at most one run at a time (a unique index on live stops); stops are put in order (move up or down, or *Nearest first*, a suggestion from the branch's pin and each stop's pin; stops without a pin go last), and a person's order is the order. **Starting a run sends every delivery on it out together in one transaction**, through the same `dispatch` step as a delivery sent on its own, so each delivery's history, the order's timeline, stock (when it is issued at dispatch) and the customer messages are the same; if one is refused (its order was cancelled or is not paid) none goes and the message names it. **Closing** needs every delivery to have a result (delivered, or tried and failed); deliveries that did not get through leave the run and can go on another. Each run is locked while it changes, has a version for two people at once, and every change is in the decision log. Totals per run: stops, items, worth (at the order's own prices) and weight (of what has one).

**The dispatch board** (`deliveries:dispatch`, granted to administrators and managers): *Ready to go* (own-fleet deliveries marked ready and on no run, oldest first, with how long each has waited and a flag at a day), *Runs to do*, a form to plan a run, and *With couriers*. Three reads however much there is. Late and at-risk flags beyond waiting time need delivery windows, which come with D-5.

**Couriers.** `CourierPort` (`book`, `track`, `cancel`) with a **manual adapter**: the courier's name and tracking number are typed in when the parcel is sent out, and the shipment (`delivery_shipments`, one per delivery) records them. The courier's news is typed in too (*Record the courier's news*, on the board or the delivery's screen): *still with them* adds a note or a new tracking number to the history; *delivered* completes the delivery (who received it); *a problem* is a failed attempt with the courier's words. Each is the delivery's own step in one transaction with the shipment's state, so they never disagree. A courier we cannot reach never blocks the sale. A courier's own API is an adapter behind the same port (D-5); an id the registry does not know falls back to manual, so a retired adapter never strands a delivery.

**Not built.** Rider accounts and a rider's own phone (D-2: the run names a rider as text for now). Cash due on a run (D-3). Capacity, slots and promised windows (D-5). Dragging stops (the up and down buttons do the same and work from the keyboard).

## 33. D-1d as built (2026-11-04): the tracking page and messages to the customer

**The tracking link.** Every order has one link, `/track/{token}`, made the first time it is needed (`order_tracking_links`, migration 0133). The token is 24 random bytes in base64url (32 characters); it is kept **sealed** (so the same link can go in a later message) and as a **keyed hash** (so it is found without opening anything). A token that is not 32 characters of that alphabet is turned away before the database is asked. The page is looked up and limited by address and by link (a fingerprint of it, never the link) before anything is shown; it is `noindex`, disallowed in `robots.txt`, and its data streams in behind the heading rather than holding the page up. A link can be **turned off, or turned off and replaced**, by someone who may fulfil deliveries, with a reason (in the decision log); the old link stops working at once, and a turned-off link keeps a token nobody holds so an old link can never come back. The order's own screen shows the link with a copy button and how often it has been opened.

**What the page shows** (`TrackedOrders`, one view for the page and for *Track my order*): the order number and when it was placed, one line about where the whole order stands, each delivery with the steps it has been through (being prepared, ready to go, on its way, delivered), what is in it, the courier's name and tracking number for a courier delivery, who received it and when, and what is still to be sent. **Never** an address, a phone number, a price, a rider, a branch (but the one to collect from) or a stock detail; a draft or cancelled delivery is the shop's own business and is left out. An order that is collected shows its branch and state, and never its code (the code stays behind order number plus contact). *Track my order* now shows the same view once the order number and contact are right, with a link to keep.

**Messages.** A delivery step that the customer should hear about queues a message **in the same transaction** (`delivery_messages`): going out, delivered (or *part delivered* when more is still to come), a failed attempt (with the reason in the customer's words and whether it will be tried again) and a return. One message for each thing that happened (the key is the delivery, the kind and the attempt), so a repeated step is not a second message. They are sent after, by the step itself and by a background sweep every minute, claimed with a lease so two senders never send the same one; a mail that cannot be sent waits 5, 10, 20, 40 minutes and, after five tries, stays visible as *not sent* on the delivery's screen (with the address shown as its first letter and its domain). A message **never undoes the step** and carries only what the page shows. An order with no usable email address is recorded as not sent, with why. Email only for now: the SMS and WhatsApp ports are still to be added, and the message kinds, wording and keys do not change when they are.

## 34. D-1e as built (2026-11-04): the delivery note

`GET /api/admin/delivery/deliveries/{id}/note` (needs `deliveries:read`; the company is set on the server; `?inline=1` to print) draws an A4 PDF from a plain document (`DeliveryNoteDocument`, so the layout can change without touching the rules): the company, the delivery and order numbers, where it goes (the order's street, and the delivery's area and town), who receives it and their phone (the delivery's own, else the customer's), any note for the rider, the courier and tracking number for a courier delivery, **what is to be carried** (what was picked once counted, the plan before), **no prices** (it travels with the goods), and a box for the receiver's name, signature and date, filled in once delivered. A draft or cancelled delivery has no note. The delivery's screen links to it to print or download.

## 35. D-1 is finished

D-1a the delivery document, D-1b stock timing and returns (with corrections, orders already paid, and the finance returns checked), D-1c the dispatch board, runs and couriers, D-1d the tracking page and messages, D-1e the delivery note. **Still ahead:** D-2 the rider app (accounts for riders, proof of delivery, offline), D-3 door payments and cash custody, D-4 visits, D-5 slots, SLAs and courier APIs; SMS and WhatsApp for messages; and the question of what happens when a credit note is raised for goods a returned delivery never delivered.

## 36. D-2a as built (2026-11-04): riders, with their own account or as staff, and the rider app's door

**Two kinds of rider, chosen by the company.** *Delivery › Riders* (`riders:manage`) has one setting, `delivery_rider_settings`: **staff** (a member of staff rides with the account they already have) and **riders with an account of their own** (an account made only for riding), either or both. Staff only until the company says otherwise. A kind cannot be switched off while people of that kind are riding or paused (the screen says how many); at least one kind must stay on. A change is versioned (two people at once) and in the decision log.

**The rider.** `delivery_riders` is one row per person per company: the account (`user_id`), the `kind`, the name they go by (kept here so runs and lists never need the account), phone, vehicle, an optional home branch, and `active` / `paused` / `ended` with a reason for the last two (a check constraint) and the time it changed. A rider who leaves is *ended*, not deleted, and can be resumed (so a run they carried keeps its rider). Pausing or ending is refused while they have a planned or started run, naming how many. Every change is in the decision log.
* **Staff rider:** the account must be an active member of staff (a role flagged staff, or super admin) and not already a rider; the screen's picker (`delivery-staff`) offers only those.
* **Own account:** made from the Riders screen with a name, an email, a phone and a first password; the account has the new non-staff role **`rider`** (seeded, no permissions), so it can open the rider app and never the back office. It is created as every admin-made account is: email vouched for, **must choose its own password at first sign-in**. The company can set a new first password later (own accounts only; staff change their own). If the rider row cannot be saved, the account just made is removed again.

**Why the rider app does not use a permission.** The permission engine is for staff, and a separate account is not staff. So the app lets someone in by their **own row in `delivery_riders`** (`DeliveryRiders.forUser`): riding, on a kind the company still uses, with an account still switched on, and, for a staff rider, still staff (a separate rider must still hold the `rider` role). The design's `deliveries:rider` permission is therefore not used. Which rider, and which company, are never taken from the phone.

**Runs and riders.** `delivery_runs.rider_id` (nullable) names the rider's row; `rider_name` stays and is the name **as it was when the run was made or given**. A run is given to a rider from the list at planning (`delivery-riders` picker: riding riders of used kinds), or to a typed name for someone not using the app (that run is not in any rider app). A planned run can be given to someone else (`assign_rider`); once it has gone out it cannot.

**What the rider sees** (`RiderRuns`): their own runs (to do, then the last five finished) and, for one run, its stops in order with the receiver's name and phone, the address (street from the order, area and town from the delivery), the note, what to hand over (counted quantities) and three links: **call** (`tel:`), **WhatsApp** (`wa.me`, a local 07… number read as Kenyan) and **navigate** (`geo:` at the pin, or at the written address; iOS has no `geo:` handler, so the written address stays on screen beside it). Every read is bound to the rider the server found for the signed-in account: another rider's run is "not found", not "forbidden", so its existence is not revealed. Customer details appear only on a stop of the rider's own run.

**The app** (`/rider`, `/rider/runs/{id}`): phone-first, noindex, a web manifest at `/rider/manifest.webmanifest` (open to the phone without cookies, named after the company) so it can be added to the home screen. `proxy.ts` now also guards `/rider`: sign in, and change a temporary password first. Sign-in sends a `rider`-role account to `/rider`; a staff rider may follow a `/rider` link from sign-in. The pages stream behind Suspense.

**Not built yet (the rest of D-2).** At the door: marking delivered with proof, failing with a reason and a photo, attempts and proofs (D-2b); re-attempt, reschedule, partial acceptance (D-2c); the offline queue and a service worker (D-2d). The rider app is read-only until then. Signing in with a phone number and PIN instead of an email is not built (a casual rider needs an email today).

## 37. D-2b as built (2026-11-04): at the door

**What the rider does.** On a run that the office has sent out, each stop that is still *out for delivery* has two buttons. **Delivered** asks who received it, the proof the company asks for, and an optional note and photo. **Could not deliver** asks why (the same seven reasons the office uses, with words required for "another reason") and an optional photo. When every stop is delivered or failed, the rider can **finish the run**, which closes it exactly as the office's *Close the run* does (stops not delivered leave the run). The office still starts the run: that sends the deliveries out and issues the stock, so the dispatcher keeps that decision.

**Proof, chosen by the company** (*Delivery › Riders › Proof at the door*, a column on `delivery_rider_settings`, versioned and in the decision log): nothing, **the customer's code**, **a photo**, or **code or photo**. A signature is not built; the list can grow. A failed attempt is never held up by proof. The code is six digits, made when an own-fleet delivery goes out (kept if it goes out again), sent in the "on its way" message and shown on the customer's tracking page, and **never sent to the rider's app**. Five wrong codes at one delivery stop code entry (`deliveries.code_tries`, each wrong try in the decision log), so six digits cannot be guessed; the office can still deliver it from its own screen. A delivery that went out before codes were switched on has no code, so a photo stands in (`ruleFor`) rather than stranding the rider.

**One try, once.** `DoorWork` (`deliver`, `fail`, `finish`) takes the rider the server found for the signed-in account, never an id from the phone; the run must be the rider's and on the road, the stop live on it, and the delivery out for delivery (another rider's stop answers "not found"). Everything is one transaction: the delivery's own step (so its event, the order's timeline, stock and the customer's message are the same as when the office does it), the **attempt** (`delivery_attempts`: number per delivery, result, who received it, note, place, rider, run) and its **proofs** (`delivery_proofs`: `code` matched, or a `photo`). Both tables are append-only (a trigger refuses any change or delete). The phone makes a **key** once per try (`client_key`, unique per company): the same key sent again answers as the first time and changes nothing, so a dropped connection or, later, a replayed queue cannot deliver twice. The phone's clock is kept beside the server's (`client_time`) only if within a day of it, and never orders anything. The place is saved only with the try (when the phone allows it), not tracked in between.

**Photos.** The phone shrinks the photo (1600 px, JPEG) and posts it to `/api/rider/proof-photo` (a route handler, since a photo can be larger than the action body limit; only a rider may use it). It is stored privately with purpose `delivery_proof`; the try names it by id and the server accepts it only if the rider uploaded it, it is private and of that purpose, and no proof uses it yet (one photo vouches for one door), then marks it kept so the sweep leaves it. The office opens a photo through a short-lived signed link after a `deliveries:read` check (`proofPhotoLinkAction`); the page never holds the address of the file.

**What the office sees.** The delivery's screen has **At the door**: each try with its number, result, rider, time, who received it, the note, "Customer's code matched", an *Open the photo* button and a link to where the rider was. The tracking page shows the customer their code while the delivery is out; the "on its way" message carries it too.

**Verified.** Unit tests for the proof rules and the message; 17 database tests (`door.integration.test.ts`: delivered, the same try twice, another rider's stop, wrong codes and the five-try lock, photos from another person or used twice, code-or-photo, failure with a reason and the order's stage, a second attempt after the rider closes the run, finishing, append-only, the phone's clock, the setting); browser tests in `rider-app.spec.ts` (code refused, wrong, right; failure; finishing; what the office sees; desktop and phone).

**Not built (the rest of D-2).** Re-attempt on the same day by the rider, rescheduling by the customer and partial acceptance of the goods (D-2c); the offline queue and a service worker (D-2d: the key is already there); signature proof; cash collected at the door (D-3). The photo is not shown in the product media library by design, but it is stored in the same table with purpose `delivery_proof` and, once kept, is listed there for people who may open the media library. Proof photos use the installation's media storage: with none set up, the rider is told photos cannot be saved yet, and the company should choose "code" or "none" until it is.

## 38. D-2c as built (2026-11-04): part of it taken, and another day

**Partial acceptance.** At the door the rider can say **the customer took only part of it**: for each product, how many were taken, and for a shortfall why (*the customer did not want it*, *it was damaged*, *it was not what was ordered*, or words of their own). The rules are in `src/lib/delivery-acceptance.ts` (every product answered, no more than carried, a reason for a shortfall, nothing taken at all is not a delivery: the rider records "could not deliver" instead). It is the same one transaction as a delivery in full (§37), and the attempt's result is `part_accepted`; the line by line (carried, taken, reason) is kept in `delivery_attempt_lines`, append-only like the attempt.
* **The delivery is delivered.** `delivery_lines.delivered` is what the customer took. A delivery that arrived commits **only what was taken** (`orderDeliveryStatus` and the allocation of new deliveries), so what was not taken is **open on the order again** and the order is *partly delivered* (stage `part_delivered`, never `delivered`) until it is brought another way or cancelled.
* **Stock.** When stock is issued on arrival, only what was taken is issued. When it was issued as the delivery went out (or at payment), the part not taken comes back through the same *Goods that came back* receipt as a returned delivery (`receiveReturn`, `correctReturn`), limited to the shortfall, with the same choices (back on the shelf, set aside, scrap) and once per product.
* **Not decided.** Whether the part not taken is credited on the customer's invoice (a credit note for undelivered goods) is the open finance question already noted in §31; nothing is credited automatically.

**Another day.** After a failed attempt with tries left, **the customer** can choose another day on their own tracking page (`rescheduleByLinkAction`, the link is the proof, limited by address and by link like viewing), and **the office** can do the same from the delivery's screen (*Day it is wanted*). The day must be after today and within two weeks (`checkRescheduleDay`); it is kept on the delivery (`deliveries.scheduled_for`), recorded in its history (as the customer's, with no account behind it, when they asked) and shown on the dispatch board ("Wanted 12 Nov") and the tracking page. It puts the delivery back to ready exactly as *Try again* does (same limit of three tries); it does not hold dispatch back, the board shows the day and the dispatcher decides. Dispatching clears it.

**Migration 0137** (`delivery_attempt_lines`, `deliveries.scheduled_for`, the append-only trigger).

**Not built.** A rider's own "try this stop again" in the same run (the office sends a failed delivery out again on a new run); reminders on the wanted day; time windows and slots (D-5); offline queue (D-2d).

## 39. D-2d as built (2026-11-04): working without signal

**What the rider can do with no signal.** A run that was opened while there was signal still opens; the buttons at the door still work; and what is done is saved on the phone and sent when the signal returns, once.
* **The screens are kept** by a service worker (`public/rider-sw.js`, scope `/rider`, registered by the rider layout). The network always goes first, so a rider with signal sees what the shop has now; the phone's copy is used only when the network does not answer. It keeps only successful answers for `/rider` pages and the app's own files, never a redirect to sign-in, never `/api`. The home screen asks it to keep each run still to do (`keepRunScreen`), so a run is there even if it was not opened. When a different rider signs in on the same phone, the kept screens are dropped (`OfflineBar`).
* **The work is kept** in IndexedDB (`door-queue.ts`): one item per try (delivered with who received it, the code, what the customer took; not delivered with its reason; or finish the run), with the **photo as a file**, the **place and the phone's time taken at the door** (not at sending), and the **key the try was given when its form opened**. With no signal, or if a send fails for no signal, the form saves the item instead of failing, and the stop says *Saved on this phone, waiting to be sent*. The run can be finished from what the phone knows (every stop still to do has an item waiting); that is saved too.
* **Sending** (`send-queue.ts`, pure rules in `src/lib/rider-queue.ts`): oldest first, a run's stops before its finish; the photo first (its id is kept, so a retry does not send it twice), then the action with the same key. The shop's answer is read: sent, or already sent before (a repeat of a try is answered as the first time, so an answer lost on the way never makes two deliveries) removes the item; a refusal with a reason (not found, not allowed, bad input, conflict) is the shop's decision, so the item is kept with its reason for the rider to read and dismiss (the stop is open again); not signed in waits for sign-in; anything else waits 5 s, 10 s, 20 s ... up to 5 minutes and stops there so a dead connection is not hammered. It runs when a rider screen opens, when signal returns (waits ignored), every 20 s while online, and when something is saved. After something is taken the screen is read again.
* **Each rider's items are their own.** Items carry the rider's id; another rider on the same phone neither sees nor sends them, and the shop checks the rider and the run on every item as it does for any try.
* **Known limits.** The customer's code is checked by the shop when it arrives, so a wrong code typed offline comes back as a refusal to read (and counts against the five tries). A screen never opened with signal is not on the phone. Background sync (sending while the app is closed) is not used: sending happens when the app is open. The browser can clear site data on a phone short of space, which would lose unsent items; the screen says how many are waiting.

**Verified.** Rules tests (`rider-queue.test.ts`), and a browser test (`rider-app.spec.ts`, "without signal") that opens a run, goes offline, reloads from the phone's copy, marks the stop delivered and finishes the run, sees that the shop has heard nothing, comes back online, sees the run complete, and sees exactly one try on the delivery. It runs against a **production build** (set `E2E_PRODUCTION_SERVER=1` with `E2E_REUSE_SERVER=1` and a server started with `next start -p 3100` and the e2e environment, with any SMTP settings since a production server refuses console mail); the development server does not serve pages that can start without it, so the test is skipped there.

**Not built.** Phone number and PIN sign-in; sending in the background; a cap on how long unsent items may wait.

## 40. D-3 plan and D-3a as built (2026-11-05): cash at the door

**Decisions (2026-11-05).** (1) An order can be paid at the door **both** ways: the office marks a delivery (built, D-3a) and a **Pay on delivery** option at checkout (D-3b). (2) Cash in a rider's hands is booked in **one "cash with riders" account**, with a **custody ledger** that says who holds what; the hand-in moves it to the till or bank chosen. (3) M-Pesa at the door **reuses the checkout's STK prompt** (D-3c): the server confirms with M-Pesa, never the app, and the money goes straight to the company's M-Pesa account, so it never enters custody.

**Slices.** D-3a cash at the door, custody ledger, books (this section). D-3b checkout option. D-3c M-Pesa prompt at the door. D-3d hand-in: counted, with a witness and a variance, approval above a limit, posting to the till or bank. D-3e courier cost and invoice matching, rider pay settlement, delivery margin reports.

**D-3a: how it works.**
* **Setting** (*Delivery › Door payments*, `door_payments:manage`, `delivery_door_settings`, versioned, decision-logged): a payment method of kind **cash**, switched on. Its account is "cash with riders". Until it is chosen, no delivery can be marked.
* **Marking** (`DoorPayments.mark`, `door_payments:allow`, on the delivery's screen, with a reason; `unmark` before it goes out): the rules are in `src/lib/door-payment.ts` (`markProblem`): the shop's own rider; before it goes out; the order unpaid, not on account, nothing tendered by gift card or points, in the company's currency; and **the delivery carries the whole order**, so the money is one amount collected in one go. The delivery and the order are locked while it is checked. The **amount due is the order's total, read here** (never from the phone). Who allowed it and why are kept on the delivery, in its history and in the decision log. A marked delivery may be released and sent out unpaid (`orderReadinessProblem(…, { paidAtDoor })`); an unmarked unpaid one still cannot.
* **Collecting** (`DoorWork.deliver` with `cashCollected`): the rider sees *Collect KSh X in cash* and must say they collected **exactly** X (`collectedProblem`, to the cent): short or over is refused with the amount; a customer who cannot pay it all means "could not deliver". A delivery paid at the door is taken **whole** (no partial acceptance; refused with that reason). In **one transaction**: the delivery's own step, the attempt, the **custody entry** (`cash_custody_entries`: collected, positive, key `collect:<delivery>` unique so it happens once, rider, order, currency; a trigger refuses any change or delete, and checks keep the signs and the links honest) and the order's **`payment_confirmed`** stage through the cash method (`payment_method_id`, `payment_method = cash_at_door`, reference `DOOR-<delivery number>`). If the cash cannot be taken (the order was paid some other way meanwhile, or the setting was removed) the whole try is undone: the delivery is not marked delivered. After the commit the order's stock is settled and the sale is queued for the books (`applyOrderPayment` → a `cash_sale` posting, debiting the cash method's account); if that fails, **Finish any collection not yet booked** (or `finishPosting`) does it again, safely.
* **What the office sees:** *Door payments* shows what each rider holds now (collected less handed in), what they collected today, and the custody ledger newest first (paged). The delivery's screen shows *Paid at the door* with the amount. The rider's home says how much cash they hold.
* **Offline:** the cash amount rides in the queued item and is checked by the shop when it arrives (a wrong amount comes back as a refusal to read).

**Verified.** Rules tests (`door-payment.test.ts`); 14 database tests (`door-payments.integration.test.ts`: the setting, marking and its refusals, going out unpaid, exact collection, custody and books queued, a repeat takes nothing twice, partial refused, a failed stop takes nothing, all-or-nothing when the order was paid meanwhile, the setting removed, append-only, paging); browser test in `rider-app.spec.ts` (desktop and phone: the office chooses the method and marks a delivery, the rider collects, wrong then exact, the home says what they hold, the books state, the office sees it).

**Not built yet (D-3).** The hand-in and variance (D-3d: until then nothing reduces a rider's custody, and there are no adjustments); the checkout option (D-3b); M-Pesa at the door (D-3c); a door-paid delivery for an order split over several deliveries; foreign-currency orders; courier cost, rider pay and margin reports (D-3e).

## 41. D-3d as built (2026-11-05): handing the cash in

**The flow.** A rider brings the cash they hold to the shop. Someone with `door_payments:handin` opens *Delivery › Door payments*, presses *Record a hand-in* on the rider's card, and enters what was **counted**, the **till or bank account** it goes into, a **witness** (another member of staff: not the person recording and not the rider) and, if the count is out, **why**. The rider is expected to hand in **everything they hold**; the screen says how much and shows the difference as it is typed. The rules are in `src/lib/door-payment.ts` (`handInProblem`, `handInCheck`, `custodyWrites`, `handInLines`).

**Differences.** The company sets (*Differences at a hand-in*) the **largest difference allowed without approval** (default nothing) and the **account a difference is written to** (for example cash over and short). Exact, or out by no more than the limit: it **posts at once** (a difference needs words and the account). Out by more: it is saved as **waiting for approval**; **nothing is posted, the rider still holds the cash**, and the rider can have only one waiting hand-in (a unique index). A person with `door_payments:approve`, **never the one who recorded it**, approves (it posts then) or refuses with a reason (it is kept, the rider can be counted again). If the rider's cash changed while it waited (they collected more), approving is refused ("refuse it and count again"), so a count is always against what it was counted against.

**What posting does** (`DoorHandIns`, one transaction, the rider and the hand-in locked): the **custody ledger** gets a `handed_in` entry (minus what was counted) and, for a difference, an `adjusted` entry (the difference, with its reason), so the rider holds **exactly nothing** afterwards, over or short; both **bank ledgers** move (the account riders' cash is held in loses what the rider held; the till or bank gains what was counted); and, once the books are live, a **balanced journal** (`cash_hand_in:<id>`): debit the till or bank's books account with what was counted, credit the "cash with riders" account with what the rider held, and a shortage debits the difference account (an excess credits it). Nothing is written to the books directly by this module: it goes through the posting engine, like a cash count. The hand-in has a number (`HND-{YY}-…`, series `cash_hand_in`), is made waiting and decided in the same transaction when it needs no approval, and every step is in the decision log.

**Kept for good.** `cash_hand_ins` cannot be deleted; a waiting one can only be decided (a trigger refuses any other change), and a decided one never changes. Custody entries and bank ledger entries are kept as before.

**Permissions.** `door_payments:handin` (record), `door_payments:approve` (approve or refuse), `door_payments:manage` (the screen, the setting, the differences). Administrators have all three. Migration **0139** (`cash_hand_ins`, the limit and account on `delivery_door_settings`, `cash_custody_entries.hand_in_id`, the guard trigger).

**Verified.** Rules tests (11 in `door-payment.test.ts`); database tests in `door-payments.integration.test.ts` (exact; within the limit, short and over; waiting and approved; refused and counted again; stale approval refused; refusals for the witness, the account, the amount, no cash and no difference account; append-only; a balanced journal when the books are live; paging; the riders with cash); browser test in `rider-app.spec.ts` (the office sets the differences, counts a short hand-in with a witness, it waits, the recorder cannot approve it, another administrator approves it, and the rider holds nothing; desktop and phone).

**Not built.** Part of a rider's cash handed in (the float a rider keeps), a printed hand-in slip, foreign currency, and the rider seeing their own hand-ins. Not yet: D-3b (checkout option), D-3c (M-Pesa at the door), D-3e (courier cost, rider pay, margin reports).

## 42. D-3c as built (2026-11-05): M-Pesa at the door

**The flow.** For a delivery marked to be paid at the door (§40) the rider chooses **Cash** or **M-Pesa**. With M-Pesa they confirm the number the customer will pay from (the receiver's own number is filled in) and press *Send the M-Pesa prompt*. The shop's **own payment engine** sends the STK prompt (the checkout's `startOrderPayment`, source `rider_app`), and the **platform, not the app, confirms it**: the confirmation pays the order the way any M-Pesa payment does, and the sale is booked to the company's **M-Pesa account**. The money **never enters the rider's custody**. The rider's screen asks the shop every 4 seconds while a prompt is out; when the order is paid it says so and takes no cash. Opening the form again (a reload, the app reopened) picks up a prompt that is already out.

**What is checked** (`DoorMpesa`, rules in `src/lib/door-payment.ts`: `promptProblem`, `promptState`): the stop is the rider's own, on a run that is on the road and out for delivery; the delivery is marked to be paid at the door; the order is not paid; **what the order has left to pay is exactly what was marked** (otherwise "ask the office"); the number is a Kenyan mobile number; no more than **three prompts** per delivery and none while one sent less than 90 seconds ago is unanswered; and the limits that protect a customer's phone (`payment_prompt_phone`, and a new `door_prompt_rider` per rider). The amount and the order are the shop's: the phone says only which stop and which number. Which rider asked for which prompt, and the last three digits of the number, are kept (`delivery_door_prompts`, migration 0140, append-only); the whole number is on the payment attempt. The order is set to be paid with M-Pesa (`payment_method = mpesa_daraja`, no method id) so the books find the M-Pesa method.

**Delivering.** A door delivery whose order is already paid (by M-Pesa at the door, or some other way meanwhile) is delivered with **no cash asked for and none taken**; a rider who still claims cash for it is refused ("already been paid"), and a part taken is still refused (§40). An unpaid one needs the exact cash as before. The prompt needs signal: offline, the button says so and the rider can take cash or wait.

**Verified.** Rules tests (14 in `door-payment.test.ts`); 31 database tests in `door-payments.integration.test.ts` (five for M-Pesa with the payment start stood in for: a prompt and who asked, failed then another then none after three, paid by the platform with no cash and nothing in custody, paid some other way, and the refusals); a browser test (desktop and phone): the rider chooses M-Pesa, cannot confirm until it is paid, is told when a prompt cannot be sent, finds a prompt that is out, sees it paid when the platform confirms it, and delivers with no cash. The prompt itself is not sent to Safaricom in the tests (the test shop has no M-Pesa connection); that is the checkout's own path.

**Not built.** The rider asking the customer to pay for part of an order; a prompt to a customer's number from the office; showing the rider the M-Pesa receipt number. Not yet: D-3b (checkout "Pay on delivery") and D-3e (courier cost, rider pay, margin reports).

## 43. Pay on delivery at checkout, as built (2026-11-05)

**What the shopper sees.** When the company has switched it on, a shopper who chose **delivery by the shop's own riders** is offered **Pay on delivery** beside the other ways to pay (not for a courier, collection from a branch, another currency, or an order above the company's limit). The button says *Place my order*. The order is placed with **nothing to pay now** and no payment started; its confirmation says "You pay when your order arrives. Have KSh X ready for the rider, in cash or by M-Pesa, and keep your phone on." (the tax invoice buttons are hidden until it is paid).

**What the company decides** (*Delivery › Door payments › Pay on delivery at checkout*, `door_payments:manage`, `delivery_door_settings.pay_on_delivery` and `pay_on_delivery_max`, versioned and decision-logged): on or off, and the largest order taken this way (empty: no limit). It needs cash at the door chosen first, since that is where the money is booked. Off by default.

**The server decides, not the page** (`src/lib/pay-on-delivery.ts`, `DoorPayments.checkPayOnDelivery`): when the order is priced and before any stock is held, an order to be paid on delivery is refused (code `pay_on_delivery`, in words for the shopper) unless the offer is on, delivery is by own fleet, the currency is the company's, and the total (as priced by the server) is within the limit. The checkout only shows or hides the option.

**What happens next.** The order is **unpaid** (payment method `pay_on_delivery`), stock is held as for any order, and its sale is booked when the money arrives, as for any cash sale. When the office makes its delivery, the delivery is **marked to be paid at the door as it is made** ("The customer chose to pay on delivery at checkout"); if it cannot be (it does not carry the whole order) the delivery's screen says "Not marked" and releasing it says what to do. Until marked, such a delivery cannot be released or sent out. The rider then collects cash or an M-Pesa prompt exactly as in §40 to §42, and the order is paid, booked, and in custody (cash) or in the company's M-Pesa account.

**Two guards worth knowing.** (1) The M-Pesa prompt at a door points the books at the M-Pesa method through the order's payment-method **id** and leaves the order's own words ("pay on delivery") alone, because the sweep that gives back the stock of an order whose *online* payment failed looks at those words: a customer who cancels a prompt at the door must not make the shop give back goods that are still on the truck (a test proves it). (2) After a failed prompt the order can still be paid in cash.

**Verified.** Rules tests (`pay-on-delivery.test.ts`); 37 database tests in `door-payments.integration.test.ts` (six for this: the setting, placing an order and the refusals for the delivery method, currency, limit and switch, the delivery marked as it is made, an unmarked one refused with its words, cash paying it, and a failed prompt not releasing stock); the whole run of unit and database tests (219 files, 2,193 tests); browser tests on desktop and phone: the office chooses how cash is received and lets shoppers pay on delivery, the shopper places the order from the real checkout, the confirmation says what to do, the delivery is marked for the door, and the rider takes the cash.

**Not built.** A per-customer rule (only repeat customers, or a deposit); a limit per day; letting a shopper change their mind to pay online afterwards; showing "Pay on delivery" in the shop's order history in the customer's own words (it shows the order's method as stored); and the invoice for an unpaid order before delivery. Not yet: D-3e (courier cost, rider pay, margin reports).

## 44. D-3e, first part as built (2026-11-06): what delivery costs

**Decisions taken** (the owner left the question unanswered, so the recommendations stand and can be changed): rider pay is **per delivery and per day**; rider pay goes **into the books as an accrual with a payable and is paid out from a screen** (that part is the next slice); a courier's cost is the amount the courier charged, typed in.

**Rider pay** (*Delivery › Delivery costs › What riders are paid*, `delivery_costs:manage`, `delivery_pay_settings`, versioned, decision-logged): an amount for each delivery made and an amount for each day a rider works a run. Either can be nothing. It is **counted as it happens, in the same transaction**: a rider who marks a stop delivered earns the delivery amount; a run that is closed (by the rider or the office) with something delivered on it earns the day amount, **once for a rider and a day however many runs they work**; a stop the office delivered on the rider's behalf earns the delivery amount when the run closes. A stop that could not be delivered earns nothing, and a run with nothing delivered earns no day pay. Each cost has a key (`rider_delivery:<delivery>`, `rider_day:<rider>:<date>`), so a repeat, a replayed queue or a re-close never counts it twice. **A rule changed later does not change pay already earned.**

**A courier's charge** (`DeliveryCosts.recordCourier`, on the delivery's own screen, *What it cost*): for a delivery sent with a courier that has a named courier, the amount charged and a note (waybill, what it was for). A delivery can have several charges (a surcharge).

**The ledger.** `delivery_costs` (migration 0142) holds every cost: kind (`rider_delivery`, `rider_day`, `courier`, `other`), amount, the delivery, run, rider or courier it belongs to, a note, the key and who. **It is kept for good** (a trigger refuses any change or delete) and the checks keep it honest: a cost is positive, a reversal is negative and names the cost it takes back, a rider cost names the rider, a delivery or courier cost names the delivery. **A mistake is taken back** with a reason (`DeliveryCosts.reverse`): a reversing entry for the same amount the other way, once per cost; the first stays on record and is shown as "was taken back". The costs screen lists them, newest first, by kind and day range, a page at a time.

**Verified.** Rules tests (`delivery-cost.test.ts`); 10 database tests (`costs.integration.test.ts`: the rules, pay for a delivery once and none for a failed stop, nothing when the rule is nothing, day pay once for a rider and a day, the office delivering for the rider, a changed rule leaving earned pay alone, a courier's charges, reversals once, append-only and the checks, listing); a browser test (desktop and phone): the office sets the rules, the rider delivers and closes the run, the pay is counted for the delivery and the day, shown on the delivery, and a cost is taken back. The whole unit and database run: 180 files, 1,833 tests.

**Not built yet (the rest of D-3e).** (1) **The books:** posting rider pay as a cost with a payable (two accounts chosen once, a queue that posts and retries like the sales posting), and **paying riders** from a screen (cash or M-Pesa or bank, clearing the payable, one payout per cost). (2) **Reports:** delivery margin (the delivery charge less these costs), cost per delivery by zone, rider and courier, failure reasons, cash held by riders, and a courier's charges against their supplier invoices. (3) On-time rate needs promised windows (D-5).

## 45. D-3e, finished (2026-11-06): rider pay in the books, paying riders, and the delivery report

**In the books** (*Delivery › Delivery costs › In the books*, `DeliveryCostBooks`, migration 0143). The company chooses two accounts once: where rider pay is booked (a cost) and the account that holds what is owed to riders. Pay is **saved first and posted afterwards** from a queue (`delivery_cost_postings`, a worker task every minute, retrying with a growing delay), so a mistake in the accounts can never stop a rider's delivery: a cost earned posts as *debit the cost account, credit what is owed to riders*, and a cost taken back posts the other way, through the posting engine like every other posting. Nothing is posted before the books are live or without both accounts; what waits is counted on the screen, and *Book what is waiting now* does it at once. A failed posting keeps its reason and is tried again later.

**Paying riders** (*Owed to riders*). What is owed to a rider is **all the pay they earned less anything taken back, not yet paid out**. *Pay* takes in every one of those entries in one payout (`delivery_pay_payouts` with its number `RPY-{YY}-…`, and `delivery_pay_payout_items`, one row per cost with a unique cost so **none is paid twice**), by a payment method that pays in cash, M-Pesa or the bank. One transaction: any entry not yet in the books is posted first; the payout takes the entries in; the method's till or bank pays it (its bank ledger moves, as for any cash movement); and, once the books are live, *debit what is owed to riders, credit the till or bank*. A payout and what it paid cannot be changed or removed. If more was taken back than earned (a cost reversed after the rider was paid) the rider is owed less than nothing: nothing can be paid, and it is set against their next pay. Before the books are live a payout still moves the bank ledger and makes no journal; with the books live and no accounts chosen it is refused, rather than paying what was never booked.

**The delivery report** (*Delivery › Delivery report*, `delivery_costs:manage`, `DeliveryReports`). For the days chosen (the last 30 by default, at most a year): deliveries delivered, attempts that did not get through, parts of an order not taken; **what customers paid for delivery** (before tax) **counted once for an order**, on the first of its deliveries that was delivered, so splitting an order does not count its charge twice; **what delivery cost** (rider pay, courier charges, other, reversals counted against them); the **margin** and its share of the charge; and tables **by rider** (delivered, did not get through, pay earned), **by courier** (deliveries, charged), **by zone** (delivered, customers paid, direct cost: pay for a delivery and a courier's charge; pay for a day on a run belongs to the rider, not to a zone), **why attempts failed**, and the **cash riders hold now**. The margin is over the whole period, not matched delivery by delivery.

**Verified.** Rules tests (`delivery-cost.test.ts`, 10); 9 database tests for the books and payouts (`cost-books.integration.test.ts`: the accounts, waiting while the books are not live, a balanced journal, a cost taken back posted the other way, a failed posting kept and retried, what is owed, paying once, a cost reversed after pay set against the next, before the books are live, refused with no accounts, kept for good); 5 for the report (`reports.integration.test.ts`: the charge counted once an order, a split order, a courier's charge and failure reasons, a cost taken back, empty and impossible days); a browser test (desktop and phone): the office chooses the two accounts, pays the rider what is owed, sees the payout, and opens the report. The whole unit and database run: 183 files, 1,857 tests.

**Not built.** Matching a courier's charges to their supplier invoices (there is no link between the two yet, so the report shows what each courier charged and the invoice is matched in Vendor management); fuel and vehicle costs as their own kind (the "other" cost exists but has no screen to type one in); on-time rate (needs promised windows, D-5); a rider seeing their own pay and payouts in the rider app.

## 46. D-4a: booked visits (2026-11-07)

**What it is.** A crew goes to a customer's address at an agreed time for an order, for example to install what was bought (*Delivery › Visits*). One live visit per order (a cancelled one can be replaced; a database index enforces it). Migration 0144: `order_visits`, `order_visit_crew`, `order_visit_items`; a visit can never be deleted (trigger), only cancelled with a reason; checks keep a signed-off visit's sign-off and a cancelled visit's reason from being missing.

**Steps** (`src/lib/visit.ts`, pure): booked → crew assigned → on site → work done → signed off; cancel until the work is done. The crew and the time can be changed until the crew is on site (a reason is needed to move a visit). The work is done only when **every checklist item is ticked**, and the checklist is ticked only on site. The customer's sign-off names who signed (recorded by the crew or the office) and **delivers the order**.

**On the order's timeline** (one writer, same transaction): naming a crew for the first time is *dispatched* (once, however often the crew changes), on site is *out for delivery*, sign-off is *delivered*, and cancelling a visit after a crew was sent is *delivery failed* with the reason `visit_cancelled` and the words given. Every step is also in the decision log. Booking needs an order that may go out (not cancelled or on hold, paid or on account), the same rule as collecting.

**Who may do what.** `visits:manage` (the office): book, name or change the crew, move, cancel, and everything below. `visits:work` (a crew member): only on visits they are on the crew of, start, tick, mark done, record the sign-off; others' visits look as if they do not exist. Edits by two people use a version, so an old copy is refused. Crew must be active members of staff. Times are typed in Nairobi time and kept as instants. Lists are paged by time with a keyset cursor; the crew and items of a page are read in two batched queries.

**Verified.** 10 rules tests; 8 database tests (booking and refusals, the whole walk with timeline and order status, crew and time changes and the one dispatch, old copies and bad crews, cancelling before and after a crew goes, who may act on what and no delete, listing); browser tests on desktop and phone (booking with a past time refused, naming the crew, ticking, work done refused until all ticked, sign-off refused without a name then recorded, found under Signed off; move with a reason and cancel with a reason). Whole run: 186 files, 1,879 tests.

**Not built.** Materials the crew uses issued from stock (the goods of the order are unchanged; a visit's extra materials are D-4b); photos on a visit; crew time and travel as a cost (D-3e's cost kinds exist, no screen types one in); the customer seeing or moving the visit on their tracking page; checking the crew is free at that time; checkout offering "a booked visit" as a method (visits are booked by staff for an existing order); crew seeing only their own list in a rider-style phone page (they use this screen, which shows only theirs).

## 47. D-4b: materials used on a visit (2026-11-07)

**What it does.** While the crew is on site, and until the work is signed off, the crew (or the office) records the materials used on the visit: a product that holds stock, how much (to three decimals) and where it was taken from (the main shelf when left empty). The stock leaves that location **at once**, as a `sale_issue` movement tied to the visit and priced at the product's cost now (`order_visit_materials`, migration 0145; each line moves stock once, keyed by the line). Not enough stock (or a stopped or wrong place) refuses the line in words and **leaves nothing behind**: the line and its stock move are one transaction (a test caught a refusal that had kept the line, and it now rolls back).

**Giving back.** Material not used is given back with a reason: a negative line that points at the one it undoes, a `sale_return` movement to the same place, once and in full. A line that is itself a giving back cannot be given back. Lines are kept for good (database guard: no edit, no delete).

**Who and where.** `visits:work` on the crew's own visits, `visits:manage` on all; the screen shows the lines and the form on the visit's card (*Delivery › Visits*); the pickers (`visit-products`, `visit-locations`) are read with `visits:work` and never hold the whole list.

**Verified.** 3 more database tests (materials on site and not before or after sign-off, stock and cost on the movement, refusals leaving no trace, giving back once and the guard); the browser test (desktop and phone) now also tries more than there is, records 2, and gives them back. Whole run: 186 files, 1,882 tests.

**Not built.** Posting the materials' cost to the books (finance posts sales from the sale itself, not from stock movements, so the cost of materials is in the stock ledger, not yet in the general ledger); materials as part of the invoice; a planned list of materials with the booking; scanning.

## 48. D-5a: delivery slots with capacity, cut-offs and closed days (2026-11-07)

D-5 is built in slices: **D-5a slots** (this section), D-5b promised windows, lateness and escalation, with the slot choice at checkout, D-5c the courier adapter port, D-5d analytics (on-time rate).

**Slots** (*Delivery › Delivery slots*, `delivery_slots:manage`, migration 0146). A slot belongs to a branch: a name, the weekdays it runs on, a window in Nairobi time, **room for so many deliveries a day**, and a **cut-off** (minutes before it starts after which it can no longer be booked). A slot is stopped, never deleted (deliveries promised it point at it); edits use a version and say plainly that deliveries already promised keep the window they were promised. **Days with no slots** (a public holiday, a stocktake) close one branch or all branches; deliveries already promised that day are not moved.

**Booking** (a delivery's screen, *Delivery slot*, `deliveries:dispatch`). The panel shows the branch's slots over a week with the room left in each, and why one cannot be taken (stopped, wrong day, closed, past, cut off, more than 60 days ahead, full). A delivery can take a slot of the branch it leaves from only, until it is out for delivery; booking again replaces the slot it held, and a place can be let go with a reason. The delivery keeps the **window as promised** (`window_start`, `window_end`, set all together or not at all by a database check) and its "wanted on" day is set to the slot's day. Cancelled and returned deliveries no longer take a place.

**Capacity holds under load.** Booking locks the slot while it counts who holds it, so the last place goes to one of two people booking at the same moment (a test books three deliveries into a slot of one at once: exactly one wins). Counts for every slot and day of a screen are one grouped query, behind an index on (slot, day).

**Verified.** 7 rules tests; 6 database tests (making, changing and stopping with versions; the offer by day with room left; the promised window surviving a later change to the slot; capacity, a delivery counted once, letting go, cancelling; the race for the last place; every refusal); a browser test on desktop and phone (a bad slot refused in words, a slot added, a day closed, a delivery promised the slot, the next delivery finding it full). Whole run: 188 files, 1,895 tests.

**Finished (same day): weight and lead times** (migration 0147). A slot can have **a weight limit** for a day (kg): the weight of a delivery is what its lines weigh (quantity times the product's shipping weight; goods with no weight count as nothing), the slot adds up what its deliveries already carry, and a delivery that would take it over is refused ("cannot carry that much more that day"), as is one heavier than the limit alone; the panel shows the weight left. **Lead times** say how long the goods need before they can go, for **a delivery zone** and for **an item** (fresh fish, made to order, large goods), kept in one small table (`delivery_lead_times`) set on *Delivery slots › How long the goods need*, removable with confirmation. A delivery cannot be promised a slot that **starts before the order's time plus the longest** of its item's, its zone's (the zone on its charge) and the branch's own handling time (the existing per-branch method lead time); the refusal names the time and what held the goods up ("will not be ready until Thu 5 Nov, 14:30 (Frozen fish)"). Verified: 11 rules tests, 9 database tests, the browser test (desktop and phone) extended with a bad weight, a bad lead time and a lead time set and removed; whole run 188 files and 1,899 tests.

**Not built.** Capacity by vehicle (a rider's vehicle is only text today); (the shop customer choosing a slot at checkout, the window on the dispatch board and tracking page, and lateness were built in §49 and §50; the company can switch the checkout choice off, §55).

## 49. D-5b (part 1): the promised window, lateness and escalation (2026-11-08)

**The window is shown.** A delivery promised a slot shows its window on the **dispatch board** (a chip: "Promised Fri 6 Nov, 09:00 to 12:00", with *At risk* or *Late* when it is) and to the **customer** on the tracking page ("Promised: ..." until it is delivered).

**Where a delivery stands** (`src/lib/delivery-sla.ts`, pure). Against its window a delivery is *on track*, *at risk* (the end of the window is within the warning time, or the window has begun and it is not on its way), *late* (past the end), *on time* or *delivered late* once delivered; cancelled and returned deliveries are no longer watched. **How far up it has gone:** at risk, late, then *still late: the supervisor is told* once it has been late for the set time.

**The worker** (`delivery-sla-scan`, every minute; migration 0148). It reads only deliveries with a window that has begun or is about to end, and records each level **once for each delivery, level and window** (`delivery_sla_events`, kept for good, a unique key makes a second scan change nothing; a delivery given a new window is watched afresh), with a line in the decision log. Nothing is read or written for deliveries on track. **Settings** (*Delivery slots › When a delivery counts as late*, `delivery_slots:manage`, versioned): the warning time (default 60 minutes before the end) and when a late delivery goes to the supervisor (default 60 minutes late).

**The Late deliveries screen** (*Delivery › Late deliveries*, `deliveries:dispatch`). Everything at risk or late now, the most overdue first, with how late, the highest level reached and when, a link to the delivery, and an **acknowledgement with a note** ("what is being done about it"), kept for good (`delivery_sla_acks`) and covering every level raised for the delivery's current window. The dispatcher sees the first two levels and the supervisor the third on the same screen; there is no separate mail or message yet.

**Verified.** 8 rules tests; 4 database tests added to the slots file (each level raised once and again changing nothing, the decision log, the append-only guards; far, delivered, cancelled and unwindowed deliveries not watched; the list's order, levels and minutes, acknowledgement with a note and its refusals, a new window starting afresh; settings with versions); a browser test on desktop and phone (a late delivery raised, "Promised ... Late" on the board, the late screen, acknowledgement refused without words and then recorded; the settings refused and saved). Whole run: 193 files, 1,934 tests.

**Not built (D-5b part 2 and later).** Telling the dispatcher and supervisor by message (the escalation is a screen, not yet an email or a push); the board using the company's own warning time on every row (it uses the default); on-time rates and the report (D-5d).

## 50. D-5b (part 2): the shopper chooses a delivery time at checkout (2026-11-08)

**What the shopper sees.** Once the price is shown for a delivery (not collection), the checkout lists the next ten days of delivery times from the branch that would send the order, with the earliest free one first ("Earliest: Mon 9 Nov, Morning, 09:00 to 12:00" and a *Choose this time* button). Choosing is optional ("No preference" is the default). A time that cannot be chosen says why; no counts of places left are sent. The list is asked for with the same question as the price and follows it, and a chosen time that stops being free for a new place or basket is dropped.

**What the server does.** `shopDeliverySlotsAction` plans the delivery as the price does (branch, zone, goods) and offers slots using the basket's weight and lead times (`DeliverySlots.offer` with a `basket`). At placement `checkRequest` looks again; a time that has filled, belongs to another branch, or is cut off refuses the order with `slot_unavailable` (a checkout refusal stage) and nothing is saved. The choice is kept in `order_slot_requests` (migration 0149, beside the frozen `order_deliveries`). When a delivery is made, `honourRequest` books it in the same transaction. Cut-offs are judged at the time the shopper chose, not when staff made the delivery; a day that has gone is not booked. If the slot has filled since, the delivery is still made, the request records `unavailable` with the reason, and the delivery screen shows "Customer's time not kept ... Please let the customer know". The sale and the delivery are never held back for a slot.

**Verified.** Unit tests (shop view of slots, checkout parsing), 5 database tests in the slots file, an action test in the delivery orders file, and the checkout browser test on desktop and phone.

**Not built.** No message to the customer when their time was not kept (staff see it on the delivery screen); the order screen does not yet show the request; the customer's tracking page shows the promise only once the delivery holds the slot.

## 51. D-5c: couriers connected to their own systems (2026-11-08)

**Why this shape.** No courier was named, and a real courier's API cannot be coded without its documents and keys. So D-5c builds everything around the connection, and one adapter that any courier whose system speaks JSON over https can be connected to by **settings**, not code. A courier with its own special shape is a new adapter behind the same port (`src/server/adapters/courier/`), added when one is chosen. Before this the port existed but nothing called it.

**The port** (`CourierPort`): `book` (tracking number, tracking link, label), `track` (the courier's latest news, with who signed and a proof link), `cancel`, and `parseWebhook` for news the courier pushes. A failure is a `CourierError` with a plain-words message and whether trying again could help; the courier's own error text and our key never reach a screen or a log.

**Couriers** (`courier_accounts`, migration 0150; screen *Delivery › Couriers*, permission `couriers:manage`). Either **by hand** (name only; news typed in as before) or **courier's system** (`http_json`): its https address, the header that carries the key, three paths (book, ask, cancel; `{tracking}` stands for the tracking number), the cancel method, and a JSON mapping of where its answers keep the tracking number, label, link, status, note, who signed and proof, with which of its words mean booked, in transit, delivered or a problem. Our request to a courier is fixed: reference, recipient name and phone, place, parcels. The key and the secret its news is signed with are **sealed** (as payment credentials are) and never read back; the secret is shown once, when made or renewed, with the address the courier is to push to (`/api/couriers/<24 random bytes in hex>`). Versioned edits, a stop/start, and every change in the decision log (never a secret).

**Safety of the calls.** Only https, only public names and addresses (private, loopback, link-local and `.local`/`.internal` are refused when typed and again, after resolving the name, at the time of every call), no redirects, 10-second limit, answer size capped, the tracking number encoded into the path, links taken from an answer only if https. A pushed message must carry an HMAC-SHA256 of the body in `X-Signature`, compared in constant time; wrong or missing signature is 401, an unknown address 404, and a message that is not news or is for a parcel we do not have is answered 202 and ignored so the courier stops resending. Pushes are limited per source address.

**Sending a parcel.** On the delivery screen a connected courier is chosen from the company's list (a stopped one is refused). Dispatch records the shipment and goes out **at once**; the booking is the worker's job (`courier-sync`, every minute, parcels leased while worked on so two workers never call twice). A booking that fails for a reason that may pass is tried again after 2, 4, 8, 16 and 32 minutes and then left **failed, visible** on the delivery, the dispatch board ("Courier not booked") and with a *Try the courier again* button; one the courier refused is failed at once. The courier being down never stops a dispatch, and typing a tracking number by hand always still works.

**Following it.** A parcel on the road is asked about every 15 minutes at first, then 30, then rarely if it goes quiet (*Ask the courier now* does it at once); news the courier pushes arrives too. Each piece of news is kept in `courier_events` (append-only; the same piece, pushed or asked, counts once) and becomes the delivery's own step in a savepoint: *delivered* completes the delivery (with who signed and the proof link), *a problem* is a failed attempt with the courier's words, anything else is a note. News that the delivery cannot take (it is already delivered) is kept and changes nothing. The customer's tracking page links to the courier's own page when it gave one.

**Cancelling.** A delivery that is cancelled has its parcel cancelled with the courier by the worker (retried like a booking); a parcel never booked is just closed.

**Also finished here (the rest of D-5b).** When the delivery time a shopper chose could not be kept, the customer gets a message (`slot_not_kept`) in the same step, and the order screen shows what the customer chose and what became of it.

**Verified.** Rules (`courier-http.test.ts`), the adapter against a stand-in for the courier's system (`http-json.test.ts`), 10 database tests (`couriers.integration.test.ts`: sealing, versions, booking, failures and retries, asking, pushed news, cancelling, hand-typed news still working), the message words, and the browser tests (`e2e/couriers.spec.ts`).

**Not built.** A specific courier's own adapter (waits for the choice of couriers and their documents); courier invoice matching to the shipments and the courier's cost fetched from its system; printing a label inside our own pages (the courier's label opens from its link); a "send a test parcel" button on the courier screen.

## 52. D-5d: delivery performance (2026-11-08)

**The screen** (*Delivery › Delivery performance*, `deliveries:dispatch`, `DeliveryPerformanceReports`, no migration: it reads what the earlier slices already keep). For the days chosen (the last 30 by default, at most a year) a delivery counts on the day it was delivered.

- **Overall.** Delivered; **delivered on time** (by the end of the window the customer was promised; a delivery promised nothing is left out of the rate, never counted as on time); **delivered at the first try** (no failed attempt before); average time from going out to delivered; how late the late ones were; and from release to delivered. Each rate carries a plain tone (95% and over good, 80% and over to watch, below that poor).
- **By rider.** Delivered, on time, first try and average time on the road, for the rider who handed the delivery over.
- **By courier.** The parcels sent in the days, and what has become of them so far: delivered, on time, average time taken, attempts that did not get through, and parcels that could not be booked or cancelled with the courier's system.
- **Delivery times.** For each slot: the places offered (its capacity for each day in the period it runs and is not closed), the places booked (cancelled and returned deliveries hold none), the days it was full and the share used; and how many times customers chose at checkout and how many of those had gone by the time the delivery was made. The capacity used is today's, so a slot whose capacity was changed shows the new capacity for older days.

All counts are company-scoped, read in parallel, and the rates come from small pure rules (`delivery-performance.ts`). Nothing is stored, so a rate can never disagree with the deliveries it comes from.

**Verified.** Rules tests (`delivery-performance.test.ts`); 5 database tests added to `reports.integration.test.ts` (in time, late and promised nothing counted apart, with the rider's first try; a delivery sent again not counted as first try; a courier's row with a parcel that could not be booked; a slot's places, a full day, a closed day taking the room away, a cancelled delivery freeing a place, and a time chosen that was not kept; empty and impossible days); a browser test (`e2e/delivery-performance.spec.ts`, desktop and phone).

**Not built.** Trends over time (a day-by-day line) and comparing two periods; on-time rate by zone; a rider's own view of their figures in the rider app; the company's own thresholds for good and poor (they are fixed at 95% and 80%); exporting the figures.

## 53. Leftovers pulled in (2026-11-09)

Items the earlier sections list as not built, now built: fuel and vehicle costs (§53.1), a rider's own view of their pay (§53.2), lateness mailed to the dispatchers and supervisors (§53.3), courier invoice matching (§53.4), and the dispatch board using the company's own warning time on every row (§53.5). Still not built: a courier's cost fetched from its own system, a "send a test parcel" button on the courier screen, a specific courier's own adapter, and the ledger posting of materials used on a visit.

### 53.1 Fuel and vehicle costs

Two new kinds of cost, **fuel** and **vehicle** (repairs, service, parking, tolls), beside the existing *other* cost, which until now had no screen (migration 0151 only widens the allowed kinds). *Delivery › Delivery costs › Fuel and vehicle costs* takes the kind, the amount, **what it was for** (required: the vehicle and the trip, kept with the cost) and, optionally, the run it belongs to (a rider's run then carries it). The form carries its own key, so a double click or a retry saves one cost (`running:<key>`, the same unique key every cost has); after a save the form is emptied and gets a new key. A cost typed in this way appears in the list, in the delivery report (new *fuel* and *vehicles* parts of the cost and the margin) and is taken back like every other cost: by a reversing entry with its reason.

**Not booked here.** Fuel and vehicle costs count against delivery in the report and the margin only. They are not posted to the ledger and not paid out to riders (only rider pay is): the company books the receipt as an expense or a supplier invoice, and posting it here as well would count it twice.

**Verified.** Rules tests (`delivery-cost.test.ts`), 2 database tests added to `costs.integration.test.ts` (saved once for a form, tied to a run, in the report, not queued for the books, taken back; every refusal), and a browser test (`e2e/delivery-costs.spec.ts`, desktop and phone). The database tests for costs and the report used the UTC date as "today" and failed between midnight and 3am in Nairobi; they now use the Nairobi day, like the product.

### 53.2 A rider's own view of their pay

*Rider app › My pay* (`/rider/pay`, reached from the rider's home screen). The rider sees **what is owed to them now** (earned less anything taken back, not yet paid out: the same figure the office sees under *Owed to riders*), **what they earned this month**, the **latest 30 pay entries** (each with the delivery, the time and whether it is *Paid* or *Not paid yet*) and **the latest 10 payouts** (number, day, how it was paid, reference). The rider is always the signed-in account's own row, found on the server like every other rider-app action, so there is no way to ask for another rider's pay. An entry the office took back shows as "Taken back by the office"; the office's own reason is not shown to the rider. The page needs signal (it is not kept for offline use; the runs are).

**Verified.** 2 database tests added to `cost-books.integration.test.ts` (only their own pay; owed, taken back without the reason, paid and listed with the payout; empty for a rider who has earned nothing) and the rider-pay browser test extended to open *My pay* on the phone after the run (the entries, not paid yet, no payout, no horizontal scroll).

### 53.3 Mail about lateness (escalation is no longer only a screen)

*Delivery slots › When a delivery counts as late* now also takes **who is mailed**: the dispatchers (told when a delivery is *at risk* and when it is *late*) and the supervisors (told when it has been late for the set time). Up to ten addresses for each, typed with commas; each is checked, lower-cased and kept once (migration 0153 adds the two lists to the versioned settings, with a limit of ten enforced in the database too).

**How it works.** The lateness scan already raises each level once for a delivery and a window. In the same transaction it now queues one notice for each event and address (`delivery_sla_notices`, a unique key on event and address, so a second scan queues nothing). The address is kept as it was when the event was raised, so changing the list later does not change who was told. The worker task that scans then sends what is due (`DeliverySlaNotices.flush`): notices are leased while being sent so two workers never send one twice, a mail that cannot be sent is tried again after 5, 10, 20 and 40 minutes and then left visible as failed, and a mail server that is down never stops the scan. The mail names the delivery, the order, the customer's first name, the branch it leaves from, the window and how late it is, and links to the Late deliveries screen; it carries no address, phone number or payment detail. With no one on the list nothing is queued and the screen works as before.

**Verified.** 3 rules tests (reading and refusing address lists, who is mailed at which level) and 5 database tests added to `slots.integration.test.ts` (one notice for each address and level and once only; nothing queued with an empty list, and a changed list not rewriting who was told; sending once with the screen to open and no personal detail; a failed mail kept, not due again at once, sent when it falls due; refused lists leave the last one). The lateness settings browser test now also refuses a bad address and keeps a good list.

**Not built.** An SMS or push to the dispatcher; choosing people by role instead of typing addresses; the mails of a level are counted on the Late deliveries screen (sent, waiting, could not be sent) but not listed by address.

### 53.4 Courier invoices matched to the charges

*Delivery › Courier invoices* (`delivery_costs:manage`; migration 0154). The office types in an invoice a courier sent (the courier, the number printed on it, its day, its total and an optional note) and matches it to the courier charges we kept for that courier's parcels (the ones typed on each delivery, or fetched from the courier's system). The screen then says where the invoice stands: **nothing matched yet**, **agrees with our charges**, or **short** or **over** (we have fewer or more charges than the invoice) with the difference in shillings. The office decides what to do about a difference; matching changes no charge and posts nothing, and paying the invoice is done in the usual way.

- **Why not a supplier invoice.** Supplier invoices in Vendor management belong to a purchase order and go through the three-way match; a courier's bill has no order. So a courier invoice is its own record, and the link to the books stays where it was.
- **A charge is on one invoice only** (a unique key on the charge, so two people matching at once cannot count it twice), counts only if it is the courier's own charge, is not a reversal and was not taken back, and matching is all or none: one charge that does not belong refuses the whole set, with the reason.
- **Charged to us, on no invoice yet.** The top of the screen lists, by courier, the charges not yet on any invoice (how many and how much): what the courier has charged that no invoice has covered.
- **Mistakes.** A charge can be taken off an invoice; a wrongly typed invoice is **voided with a reason** and its charges are free for another invoice, and its number can be typed again. An invoice's words cannot be changed or deleted, even straight in the database (a trigger allows only the one void, with its reason); each step is in the decision log.
- **The courier list** for the form is the couriers that have charged the company plus the ones connected; the invoice keeps the name as typed. Lists are paged (20 at a time, keyset); up to the latest 100 unmatched charges are offered at a time for matching.

**Verified.** Rules tests (`courier-invoice.test.ts`: reading an invoice, standing, chosen charges), 6 database tests added to `costs.integration.test.ts` (an invoice once for a courier and a number; matching only the courier's own charges with short, agreed and over, all or none, never twice, taking one off; a charge taken back not counted and another company unable to reach anything; voiding, freeing charges and the number, and the log; paging; the invoice cannot be edited or deleted), and a browser test (`e2e/courier-invoices.spec.ts`, desktop and phone).

**Not built.** Reading the courier's own invoice file or fetching its invoices from its system (the invoice is typed in); matching an invoice line by line to parcels by waybill number (the match is by charge); posting or paying the invoice from here.

### 53.5 The dispatch board uses the company's own warning time

The "at risk" and "late" chips on the dispatch board were worked out at the default warning time. The board now reads the company's setting once for the whole board (one read, not one per row) and uses it for every row, so the board and the Late deliveries screen agree. One database test added to `slots.integration.test.ts` (a window 90 minutes from its end is on track at a 60-minute warning and at risk at 120).

## 54. Rider sign-in with a phone number and a PIN (2026-11-10)

**What it is.** A rider with an account of their own signs in to the rider app with their **Kenyan mobile number and a 6-digit PIN** (*/rider/sign-in*), instead of an email and a password. Opening the rider app signed out now leads there; a link underneath offers the email and password sign-in, which still works for everyone (migration 0156: `rider_pins`).

**Who.** Only riders with an account of their own (`separate`, role `rider`). **A member of staff never signs in with a PIN**: the account behind a staff rider can open the back office, and six digits must never open that. The PIN session is also made without staff rights, whatever the account holds. A rider who is paused, has left, whose account is switched off, or whose kind of rider is switched off cannot sign in, even with the right PIN, and that is not counted against them.

**Giving a PIN.** *Delivery › Riders*, on a rider's card: **Give a PIN**. The office is shown six random digits **once**; the PIN is never kept (only a bcrypt hash made with a secret of the server's own, so a copy of the table cannot be tried offline) and is not in the decision log. The rider's phone number must be a Kenyan mobile number and be nobody else's. The PIN is **temporary**: at the first sign-in the rider is taken to *Choose your own PIN* (*/rider/pin*) and the rest of the rider app is closed to them until they have. A new PIN from the office replaces the old and ends the rider's sessions made with it; **Turn off the PIN** removes it; a rider who leaves loses it (freeing the number); changing the rider's phone number turns it off, because a PIN belongs to the number it was given for.

**Choosing one's own.** The rider gives the PIN they have now (so a phone left unlocked cannot change it) and the new one twice. A PIN must be six digits, not one digit repeated, not a run (123456, 987654), not a common choice, and not the end of the rider's own number; it must differ from the old. A wrong current PIN counts like a wrong sign-in. Choosing a PIN ends every other session made with the old one and signs this phone in again.

**Guessing.** Six digits are few, so everything is built against guessing. **Wrong tries are counted under a row lock**, so guesses made at the same moment are counted one after another (a test fires 14 at once: exactly 5 are counted and the rest are shut out). **Five wrong tries in a row shut the rider out** for 15 minutes, doubling with each further wrong try up to four hours, even for the right PIN; the office sees it on the rider's card ("Shut out for ...") and can **Let them try again**. The sign-in is also limited **by address and by phone number** (so many addresses against one number run out as fast as one), and an unknown number takes as long to answer as a known one. A wrong number and a wrong PIN get the same words; only a rider who has been shut out is told for how long. The cost: someone who keeps trying a rider's number can shut that rider out for a while. The limit by address and the office's one-button unlock are the answer; a lock never opens the account.

**Sessions.** A PIN session carries when its PIN was set. The ordinary check of a session (every minute at most) ends it if the PIN has since been replaced, turned off or removed, so a lost phone is dealt with by giving a new PIN or turning it off.

**Verified.** 8 rules tests (`rider-pin.test.ts`: the number in any written form, what a PIN may be, the lock times), 11 database tests (`rider-pins.integration.test.ts`: the PIN kept only as a hash and not in the log; the number written any way; wrong answers all alike; the lock, the unlock and the lock running out; **a burst of 14 guesses**; choosing one's own with every refusal and the old PIN stopping; sessions ending on a new PIN or removal; staff, foreign numbers, a number already taken, another company; paused, left and switched-off riders; the phone number changing; leaving freeing the number; what the office sees), and a browser test on desktop and phone (`e2e/rider-pin.spec.ts`: the office gives a PIN shown once; a wrong PIN refused; the temporary PIN leads to choosing one's own and the app stays closed until then; weak PINs refused with words; signing out and in; five wrong tries shutting the rider out and the office letting them back in; the PIN turned off).

**Not built.** A rider asking for a new PIN by text message (they ask the office); signing in with a PIN for staff riders (by design); a limit on how many riders may share a phone (a number belongs to one rider at a time); the sign-in page working without signal (it needs the network, like any sign-in; the runs already kept on the phone still open).

## 55. The company decides whether shoppers choose a delivery time (2026-11-11)

**Why.** The checkout choice of §50 was always on. A company that plans every delivery itself, or does not want customers holding it to a window, needs to turn it off.

**The setting** (`delivery_slot_settings`, migration 0157): one row for a company, made when it is first changed, with `shoppers_choose`, a version, who and when. **With no row the answer is yes**, so existing companies see no change. Read and changed through `DeliverySlots.shopperChoice` and `setShopperChoice` (versioned, a stale version is a conflict, changes are written to the decision log with before and after); screen: *Delivery slots › Delivery time at checkout* (`delivery_slots:manage`).

**What it changes.** Off: `shopDeliverySlotsAction` returns no days, so the checkout hides the whole section; `checkRequest` refuses a time sent anyway with the checkout refusal `slot_unavailable` and a plain message, so a page left open from before cannot promise a time and nothing is saved. What it does not change: staff booking a slot for a delivery, slots themselves, and orders whose shopper already chose a time (`honourRequest` still books them: the shopper was promised).

**Verified.** A database test (default on, bad input and stale version change nothing, off refuses a time and saves no order, staff booking still works, the decision log, on again accepts), a browser test on desktop and phone of the setting being saved and kept across a reload, and one of the checkout pricing the delivery with no times offered.

**Not built.** Setting it for one branch or one delivery method; showing "we will contact you about the time" text at checkout when it is off.

## 56. Vehicles and what a run may carry (2026-11-11)

**Why.** A rider's vehicle was only text, so nothing stopped a run being loaded with more than the vehicle could take.

**The register** (`delivery_vehicles`, migration 0158; screen *Delivery › Vehicles*, `riders:manage`): a name (unique per company whatever its letter case, by an index on `lower(name)`), an optional weight limit in kg and an optional limit on stops (a check keeps them sensible), in use or stopped, a version, and the decision log (`vehicle.created`, `vehicle.changed`, `vehicle.stopped`, `vehicle.resumed`). A vehicle is stopped, never deleted. Pure rules: `src/lib/delivery-vehicle.ts` (`checkVehicle`, `loadProblem`, `loadWords`).

**On a run.** `delivery_runs.vehicle_id` (nullable, restrict) points at the vehicle chosen from the register; the run keeps the vehicle's name in `vehicle` as it was. A typed-in vehicle still works and limits nothing. `DeliveryRuns.addStop` and the new `assignVehicle` compute the load (the same units, value and weight as the run screen, with goods of no weight counting as nothing) **under the run's row lock** and refuse a stop or a vehicle that would put it over, in words with the numbers. The run view carries `vehicleId` and `limits`; the run screen shows the load against them; the dispatch board's *Plan a run* picks the vehicle through the `delivery-vehicles` lookup (in-use vehicles only, limits shown beside the name).

**Verified.** 8 rules tests; 6 database tests in the runs file (register rules and versions, a run keeping the vehicle's name and refusing a stopped or unknown one, the weight limit with the run left unchanged and the delivery fitting another run, the stop limit with goods of no weight, the race for the last place, changing the vehicle to one that fits); a browser test on desktop and phone (adding, a bad limit and a duplicate refused, a run in the vehicle refusing a second stop, the run screen showing the load, stopping the vehicle).

**Not built.** A default vehicle for a rider; a vehicle's capacity in volume or parcels; refusing to start a run whose vehicle was changed after stops were added (changing the vehicle is checked, so this cannot happen); vehicle costs by vehicle in the report.

## 57. Running costs by vehicle in the delivery report (2026-11-11)

**Why.** With vehicles in a register (§56) the company can ask which vehicle costs most to run.

**Costs.** `delivery_costs.vehicle_id` (migration 0160; nullable, restrict, indexed with the time; a check lets only fuel, vehicle and other costs carry one, so rider pay and courier charges never do). `DeliveryCosts.recordRunning` takes a `vehicleId`: it must be the company's (a **stopped** vehicle is allowed, because a late bill still belongs to it); a run that went out in a listed vehicle brings its vehicle, and naming a different one is refused in words. `reverse` copies the vehicle, so a taken-back cost lowers the same vehicle's total. The cost list names the vehicle; the costs screen picks it from the `delivery-vehicles-all` lookup (all vehicles, with a *Stopped* badge). Costs stay append-only: a wrong vehicle is put right by taking the cost back and typing it again.

**Report.** `byVehicle`: for each vehicle with a delivery or a running cost in the period, the runs and deliveries delivered on them (a delivery counts for the vehicle of the run it was delivered on, through its stop that was never taken off), fuel, repairs and other costs net of reversals, the total and the cost per delivery (none when nothing was delivered), and `untiedRunningCosts` so that the table and the running costs in the margin reconcile. One grouped query for the vehicles and one for the untied sum, with the existing indexes.

**Verified.** 2 database tests (a vehicle named or brought by its run, two vehicles refused, an unknown or another company's vehicle refused, a stopped vehicle still billed, the list naming it, a reversal keeping it, the database refusing a courier cost with a vehicle; the report's figures for a vehicle that delivered and one that did not, and the untied sum) and a browser test on desktop and phone (adding a vehicle, a cost against it, the list and the report naming it, a late cost against the stopped vehicle).

**Not built.** Moving a cost to another vehicle without taking it back; kilometres or litres, so fuel per kilometre; costs by vehicle for runs with only a typed-in vehicle name.

## 58. A rider's usual vehicle (2026-11-11)

`delivery_riders.vehicle_id` (migration 0161; nullable, restrict) is the rider's usual vehicle from the register (§56), set when a rider is added (staff or own account, checked before the account is made, so a vehicle that cannot be used leaves nothing behind), or later with `DeliveryRiders.update` (`vehicleId` from the list, `''` to clear, a typed `vehicle` for a name that is not on the list; an edit that mentions neither leaves it alone). The rider's `vehicle` text keeps the vehicle's name as it was. `DeliveryRiders.carrier` returns the usual vehicle, and `DeliveryRuns.create` uses it when the request names no vehicle, either from the list or typed in; a usual vehicle that has been stopped is skipped quietly, so a run is never refused for it. The planned message names the vehicle. The riders lookup shows each rider's vehicle beside their name.

**Verified.** 3 database tests in the riders file (chosen at creation and refused when stopped or unknown, changed and cleared and left alone by other edits, brought to runs unless another is chosen or typed and skipped when stopped) and a browser test on desktop and phone.

**Not built.** Carrying the usual vehicle over when a planned run is given to another rider.

## 59. Saved door work is sent in the background (2026-11-12)

The rider app kept what is done at a door offline in IndexedDB (§ D-2d) but sent it only while a rider screen was open (`OfflineBar`). Now the service worker also sends it. `OfflineBar` registers a one-off background sync (`rider-door`) whenever something is waiting (`askForBackgroundSend`); on the `sync` event `rider-sw.js` reads the same IndexedDB store and sends through `public/rider-sync.js`, which holds the sending rules in plain JavaScript (a worker cannot import the app's TypeScript): oldest first, stops before their run's finish, 5 s doubling to 5 min between failed tries, a refusal kept with its reason, a lapsed session leaves the item alone, a photo uploaded once (shrunk to 1600 px where `OffscreenCanvas` exists) and its id kept. A failed send throws so the browser schedules the next try; open screens are told (`door-sent`) and refresh.

A worker cannot call server actions, so items go to `POST /api/rider/door-sync` (JSON, same-origin only, 64 KB, validated), which calls the same actions as the app (`deliverStopAction`, `failStopAction`, `finishRunAction`) and answers the same `{ ok, error, code, forbidden }`. The item names the rider it was saved for; if the signed-in account is a different rider the answer is "sign in" and nothing is done, so work is never sent under another rider's account. The app and the worker can send the same item: the try's key makes that one try, and the worker re-reads an item before rewriting it so it never brings back one the app has just sent.

**Verified.** `src/lib/rider-sync.test.ts` holds the worker's rules to the app's (`verdictOf`, `waitAfter`, `nextToSend` agree on the same cases) and tests its sending against an in-memory store (order, refusal kept, retry with a longer wait, signed-out rider skipped while another is sent, photo once, no resurrection). `e2e/rider-door-sync.spec.ts` checks the route without a session, from another site, with malformed bodies, and that the worker and its rules are served.

**Not verified in a real browser.** The `sync` event itself (needs a production build on an Android Chromium phone; Playwright cannot raise it reliably). Browsers without Background Sync (Safari, Firefox) keep the older behaviour: sent when the app is open.

## 60. Lateness alerts on phones and computers (web push) (2026-11-12)

Migration 0162: `push_subscriptions` (one row per browser: the push service's https address, unique, and the two keys the browser gave; company, user, last sent) and `delivery_sla_pushes` (an alert queued for one subscription for one lateness event: audience `staff` or `rider`, status, attempts, next try; unique on event and subscription, so a rescan is nothing new). Push is a port (`ports/push.ts`) with `WebPushAdapter` (the `web-push` package; VAPID keys from `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, read by `pushRuntimeConfig`, all three or none, malformed is an error) and `NoPushAdapter` when none are set, so an installation without keys behaves as before and its screens say so.

`DeliveryPush` (`delivery/push.ts`): `subscribe` (validated by `readSubscription`; the same browser is one row and belongs to whoever subscribed last; at most five browsers a person, oldest dropped), `unsubscribe` (only the person's own), `state`, `queue` and `flush`. `DeliverySla.scan` calls `queue` in the same transaction that inserts the events and the mails: staff are the subscribers whose account email is on the list for the event's audience (dispatchers for at risk and late, supervisors for still late); the rider is the owner of the account of the rider whose planned or started run holds the delivery as a live stop, for at risk and late only. `flush` (run by the `deliverySlaScan` task after the mails; a push service that is down never stops the scan) leases rows with `skip locked`, sends, marks sent, retries after 5, 10, 20 and 40 minutes, and deletes a subscription the push service answers 404 or 410 for. An alert is `lateAlert` (`lib/delivery-push.ts`): the delivery number, the window and how late; never the customer, address, phone, items or payment. It is kept for an hour at most by the push service and opens `/admin/delivery/late` or `/rider`.

Browser side: `public/push-handlers.js` (shows an alert, opens only a path on this site) is loaded by `rider-sw.js` and by `alerts-sw.js` (staff, scope `/admin`, no page caching). `AlertsToggle` (one component for both) asks for permission from a tap, subscribes with the public key and tells the server; it states why when it cannot work. Actions: `lateAlertsStateAction`, `turnOnLateAlertsAction`, `turnOffLateAlertsAction` (permission `deliveries:dispatch`) and `myAlertsStateAction`, `turnOnMyAlertsAction`, `turnOffMyAlertsAction` (the signed-in rider).

**Verified.** Unit tests for the alert words, the subscription rules and the settings; five database tests (subscribe, one row per browser, ownership, the limit of five, refused without keys; the list and off-list staff; supervisors and the rider with their levels; a failed push kept and tried again; a gone browser forgotten); a browser test of the card and the served workers.

**Not verified.** A real alert reaching a phone: it needs real keys and the browsers' push services. **Not built.** SMS (a provider port is the next slice); alerts for other events; a quiet-hours setting.

## 61. Lateness by text message (2026-11-12)

Migration 0165: `delivery_sla_settings` gains `notify_dispatch_phones`, `notify_supervisor_phones` (up to ten each, written with the country code by `readPhoneList`/`internationalPhone`) and `text_the_rider`; `delivery_sla_texts` holds one row for each event and number (audience `staff` or `rider`, status, attempts, next try; unique on event and recipient, so a rescan adds nothing). `DeliverySla.scan` calls `DeliverySlaTexts.queue` in the same transaction as the events, the mails and the push alerts: the list for the event's audience, and for `at_risk` and `late` the live-run rider's saved number when `text_the_rider`. Settings are read when a level is raised, so changing a list later does not change who was texted for a level already raised.

`DeliverySlaTexts.flush` (the `deliverySlaScan` task, after the mails and alerts, behind its own catch) first drops rows older than three hours (a late text is no use), then leases due rows with `skip locked`, opens the company's default SMS sender (§ `sms-providers.md`) and sends `lateText` (delivery, window, how late, shop; at most 160 characters; the shop's name gives way before the facts). No default connection: the row fails with words and is tried again, so connecting a provider within the three hours sends it. `SmsSendError.retry === false` (wrong key, no balance, refused number) sets attempts to the limit so it is not repeated; other failures back off 5, 10, 20, 40 minutes. The Late deliveries card counts the texts of an event (`texts`); the lateness settings screen says which connection texts go through or that none is connected (`SmsAccounts.defaultName`).

**Verified.** Pure rules (`readPhoneList`, `lateText`) in unit tests; eight database tests (numbers kept with country code, queued once for each level and number in the scan, nothing queued with no numbers and later list changes not affecting earlier ones, sent once with only the delivery facts, waiting without a provider and sending after one is connected, a refusal not repeated and a fault retried after a wait, a stale text dropped, the rider texted on the saved number for the first two levels and only when chosen); a browser test of the settings.

**Not verified.** A real text reaching a phone (no provider account here). **Not built.** Quiet hours; reading delivery receipts; texting the customer about their own delivery (the customer messages are email only today); other events by text.

## 62. Customers texted about their delivery (2026-11-12)

Migration 0167: `delivery_text_settings` (one row for a company: `enabled`, default off because every text costs money, and `kinds`, a check that every kind is one we send; versioned, decision-logged by `DeliveryTextSettings.set`). `delivery_messages` already had a `channel` column (default `email`); texting uses it. `DeliveryMessages.enqueueIn`, in the same transaction as the delivery step, writes the email row as before and, when texting is on for that kind, a second row with channel `sms`, key `<key>:sms` (so a retried step is still one message for each channel) and the customer's number written with its country code (`internationalPhone`); no valid number is `skipped` with why. `flush` sends either channel by the row's channel: the text is `textContent` (lib/delivery-messages.ts: the same facts as the email, the delivery code only on `out_for_delivery`, the link last, shortened to two message parts by shortening the shop name first), sent through `SmsAccounts.defaultSender`. No sender: the row fails with words and is tried again like any other, up to five tries over a little more than an hour. `SmsSendError.retry === false` (wrong key, no balance, refused number) sets the attempts to the limit so it is not repeated. The mail and the text never hold each other back. The settings screen is `/admin/delivery/messages` (permission `deliveries:manage`, `CustomerMessagesClient`); the delivery's own message list shows both channels.

**Verified.** Unit tests for the text words (state, code only when on its way, no address or phone or money, length, shortening) and the kinds; six database tests (default off and versioned, refusing nonsense and stale saves; only the email while off and the text row as its own row when on for that kind, once however often the step is retried; the text sent with facts, code and link and no address or phone; no valid number skipped while the email still goes; no provider waits with words while the email goes; a final refusal not repeated and a fault retried after a wait); a browser test of the screen.

**Not verified.** A real text reaching a phone. **Not built.** Texting the customer from steps that have no email message today (collection codes for pick-up orders); replies from customers; per-customer opt-out beyond having no valid number. (Collection codes: built in section 64.)

## 63. Quiet hours for customer texts (2026-11-12)

Migration 0168 adds `quiet_from_minute` and `quiet_until_minute` to `delivery_text_settings` (minutes after midnight in the business time, both null or both set, 0 to 1439, not equal; a check enforces it). `readQuietHours` reads the two times typed on the screen (`HH:MM`), `quietEndsAt` is the pure rule (inside the window, across midnight or not, it returns the minute the window ends; otherwise null). `DeliveryMessages.flush(limit, now)` checks each claimed **text** (never mail) against its company's settings once per pass; a text in the quiet hours is put back with its attempt count unchanged, its next try set to the end of the window and a note `Held until the quiet hours end.`, which a successful send clears. Retries after a fault fall under the same rule because the check runs at send time. The business time is `DEFAULT_BUSINESS_TIMEZONE` (Africa/Nairobi, no daylight saving); a company-level time zone would replace that one argument.

**Verified.** Unit tests for reading and the window rule (across midnight, inside one day, the very minute it ends, none set); a database test (half a pair and equal times refused, saved and read back, the email going at once at 23:00 while the text waits until 07:00, nothing due a minute early, sent at 07:00 with the note cleared); a browser test of the two fields saved and kept. **Not built.** A different window for each message kind; quiet hours for lateness texts to staff (those are meant to arrive at any hour).

## 64. Telling the customer their order is ready to collect (2026-11-12)

Until now a branch collection had no message at all. `ready_for_collection` is a seventh message kind (`MESSAGE_KINDS`, words, text words, the settings choice, all in `src/lib/delivery-messages.ts`). `OrderCollections.markReady` queues it through `DeliveryMessages.enqueueIn` **in the same transaction** as the `ready` stage (so a refused or undone step never leaves a message), with `delivery_id` null (there is no delivery document for a collection) and the key `<orderId>:ready_for_collection:0`, so marking ready again is not a second message. The email is always queued; the text is queued as its own row when texting is on and this kind is ticked, like every other kind (quiet hours apply to it).

Migration 0170: the settings check now allows the new kind, and the column default for a company with no choice yet includes it (a company that already turned texting on keeps its own choice and must tick *Ready to collect* itself, because every text costs money). `DeliveryMessages.send` builds this kind from the collection as it is **when the message goes out**: the branch name and the code opened from the sealed value (so a code given anew in between is the one sent), shown as `ABC-DEF`. The code travels only in this kind, only to the contact on the order, and never reaches the decision log, the timeline or the staff screen. An order collected or cancelled before the message goes out is marked **skipped** with the reason, not sent late. The *Mark ready* action also sweeps at once, so the customer is told within moments rather than at the next scheduled sweep.

Staff see what was sent: the *Collection* panel on the order lists the messages (kind, email or text message, sent / waiting / not sent, where to masked, the note) via `DeliveryMessages.forCollection`.

**Verified.** Unit tests for the mail and text words (branch, code, link last, 306 characters, the code in no other kind, no code text when there is none); database tests (one email however often marked ready and no text while off; mail and text both carry branch and code and the staff list shows neither code nor number; collected before sending is skipped); the browser test of the counter flow extended to see the message listed without the code. **Not verified.** A real mail or text reaching a phone. **Not built.** Sending the new code again when a code is reissued (the staff member is shown it and gives it); a reminder if the order sits uncollected.
