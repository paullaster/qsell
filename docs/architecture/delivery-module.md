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
