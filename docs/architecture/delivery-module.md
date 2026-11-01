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

**Known limits.** A rate card is edited row by row; pasting a large card is not built (the limit is 5000 fees). The charge is not yet applied to an order: D-0c chooses the nearest branch that can cover the order and D-0d puts the charge on the shop checkout, the order and the invoice, with its tax.
