# Bins, zones and put-away (B-0 to B-9): research and design

Status: **draft for correction**, written 2026-11-25. Nothing is built. It extends [stock-locations.md](./stock-locations.md) (stock per location, built) and touches [delivery-module.md](./delivery-module.md) (picking for a delivery), [van-sales.md](./van-sales.md) (a van is a location), [vendor-management-module.md](./vendor-management-module.md) (goods received), [core-finance-module.md](./core-finance-module.md) (stock at cost), [offline-selling.md](./offline-selling.md) (working without a connection) and [order-stage-timeline.md](./order-stage-timeline.md).

Read §1 for what the best systems taught us, §2 for what we take and what we refuse, §4 to §9 for the model, §10 to §14 for the behaviour, §17 for the order of work and §19 for what I need you to decide.

---

## 0. The request, in plain words

A distributor, wholesaler or retailer keeps stock in rooms with shelves, racks, floor stacks and cages. "Where in the warehouse is it?" matters for four daily jobs: **putting goods away** after they arrive, **picking** them for an order, **moving** them (to the front of the shop, to a van, to quarantine) and **counting** them. For food and drink there is a fifth: **which batch goes out first**, because it expires.

We already know *which location* holds stock (a warehouse, a shop, a van). This design adds **what is inside a location**: zones, aisles, racks, shelves, bins and sub-bins, with the rules and the screens that make them useful, and with batches and expiry dates, because a bin that cannot tell you which batch it holds is not much use in FMCG.

Three things must stay true:

1. **A business with no bins sees no change.** Bins are switched on per location, by choice.
2. **The books and the shop never slow down for it.** A web order or a till sale must not wait for a shelf.
3. **A small shop and a 20,000-bin distribution centre use the same model**, with different amounts of it switched on.

---

## 1. What the best systems do (and where each one hurts)

I read the public documentation of six systems and one family of industry practice (sources at the end, with a note on how reliable each is). The table is the short version; the notes after it are what matters for our design.

| | Where stock lives | Hierarchy | Bin master data | Put-away | Pick (removal) | Batches and expiry | Adoption path |
|---|---|---|---|---|---|---|---|
| **Dynamics 365 Business Central** | Item ledger per **location**; a separate **warehouse entry** ledger per **bin** | Location → zone → bin (zones only when directed) | **Bin content** per item and bin: fixed, default, dedicated, min and max quantity, ranking, block movement, warehouse class | **Put-away templates**: ordered lines (find floating bin, fixed bin, empty bin, matching bin type, capacity), highest bin ranking wins | By bin ranking; FEFO/FIFO by lot; bin type says which activity a bin allows | Lot and serial tracking, expiry on the lot | Layered switches on the location card: Bin Mandatory → Require Put-away/Pick/Receive/Ship → Directed Put-away and Pick |
| **NetSuite** (basic bins and WMS) | Inventory per location; bin balances under it | Location → bin (WMS adds **zones** only to rank bins) | **Preferred bin**, one per item and location (WMS: several, by sequence) | WMS **putaway strategies** pick on item group, family, ABC velocity, preferred bin | Pick by bin quantity and lot | Lot-numbered items can sit in bins only in advanced bin management; inventory **status** per lot or bin | Basic bin management first; WMS as a paid layer |
| **SAP S/4HANA EWM** (and old WM) | **Quants**: the contents of a bin, per product, batch and status | Warehouse → storage type → storage section → bin (plus activity areas) | Bin type, capacity (weight, volume, key figure), blocking indicators | Rule per storage type: fixed bin, empty bin, addition to existing stock, bulk storage, general storage | **Strategy per storage type**: FIFO, strict FIFO across types, LIFO, partial quantity first | Batch is part of the quant | Whole-warehouse project; very heavy |
| **SAP Business One** | Warehouse stock, with bin quantities under it | Warehouse plus up to **four sublevels**; code is the level codes joined by a separator | Bin can be restricted to a **single batch**; sub-levels optional | **Default bin** order: item, then item group, then warehouse; a **system bin** catches the rest | Allocation by rule per warehouse or per document | Batch can be in several bins; the picker names the bins | Switch on per warehouse |
| **Oracle (Fusion, EBS WMS)** | On-hand per subinventory and **locator** | Subinventory → locator (rows, racks, bins) | Item to subinventory/locator associations | **Rules engine**: strategy = ordered rules (empty locator, same locator, no commingling, capacity by the smaller of weight and volume) | Picking rules with **consistency restrictions** (one lot, one grade, one subinventory) | Lot control, with commingling rules | Locator control per subinventory |
| **Odoo** | **Quants** per location, lot and package | Locations are a **tree**; a bin is just a child location | Storage category (capacity by weight, count or package type) | **Putaway rules** in sequence: product, category, package type | FIFO, LIFO, FEFO, closest location, least packages; set on category or location | Lots with expiry; FEFO needs dates; lots without a date go last | Settings switches (storage locations, then categories) |
| **FMCG practice** (WMS vendors, trade guidance) | Pick faces and reserve storage | Zones by temperature and velocity | Pick-face size, slotting by ABC velocity | Fast movers near the dock, forward pick face sized to each-picking | **FEFO**, scan lot and expiry at pick, older lots in front | Dates captured at receiving or FEFO is worthless | Re-slot monthly for fast movers, quarterly for the rest |

### 1.1 Six lessons that decide our design

**Lesson 1. Keep two levels of truth: the location, and the bin inside it.** Business Central keeps its item ledger (cost, availability, the books) at location level and records bin placement in a second ledger, the warehouse entries. NetSuite says it plainly: a bin transfer posts nothing to the chart of accounts. SAP keeps inventory management at plant and storage location and the quants in the warehouse system below it. Odoo is the exception: it makes every bin a location, so one warehouse with 8,000 bins is 8,000 locations, each with its own channel flags, access, reports and holds. That is simple at first and heavy later. **We already have per-location stock, with reservations and the books on it. Bins go under it as a second ledger, not as thousands of locations.**

**Lesson 2. Adoption must be layered, and the first layer must be cheap.** Business Central's three steps (bins recorded, then tasks required, then fully directed) let a small warehouse start with "tell me which bin" and grow. One consultant write-up calls turning on the directed level close to a one-way door (a secondary source; see §20). NetSuite's basic mode cannot combine bins with lots. **We offer three modes per location (Off, Track, Directed), a go-live that is a checked document, and a way back for Track.**

**Lesson 3. Put-away and removal are two different rule sets, and they fight.** SAP's own documentation says that adding goods to an existing quant "violates FIFO", and that strict FIFO across storage types needs an extra grouping. NetSuite users report new receipts landing in the preferred bin and breaking rotation, and a preferred bin overriding a strategy that sent damaged goods to quarantine. Oracle solves part of it with commingling rules and single-lot picks. **We make the conflict a visible setting: a bin's mixing rule (any, one product, one lot) and an explicit precedence: block, then rule, then default bin. Every suggestion carries the reason it was made.**

**Lesson 4. Capacity checks are the slow part of put-away.** SAP added an "early capacity check" because testing every bin in a large storage type was too slow; it removes bins that cannot fit before the search. Oracle takes the smaller of weight and volume. **We keep used capacity on the bin row and filter in the query, so a suggestion reads an index, not every bin.**

**Lesson 5. The default bin must have a strict ladder and a safety net.** SAP Business One gets this right: item default, then item group default, then warehouse default, and a **system bin** per warehouse that catches anything unplaced, so stock is never "nowhere". **We copy that: every bin-controlled location has a system bin, and the ledger rule "bin quantities add up to the location's quantity" is always true.**

**Lesson 6. Batches and bins cannot be bolted together later.** NetSuite's basic bins cannot hold lot stock; SAP B1 needs the picker to name the bins when a batch spans several; Odoo needs expiry dates or FEFO does nothing; FMCG guidance says the same: if the date is not captured at receiving, no rule can protect you. **Lot is part of the bin balance key from the first migration, and FEFO is the default removal rule for any product that expires.**

### 1.2 What the best systems still get wrong (our room to do better)

* **Heavy to set up.** SAP EWM and directed Business Central assume a trained warehouse team and a consultant. A Nairobi wholesaler with a store manager and four loaders cannot adopt that. We add a **layout wizard** (generate bins from a pattern, preview, accept) and a **Track mode** that needs no tasks.
* **Opaque suggestions.** Users on NetSuite's forum cannot tell why a bin was suggested. Every suggestion here carries a plain-words trace ("fixed pick face, 6 of 40 cartons free").
* **Built for scanners.** Most assume a handheld scanner on good Wi-Fi. See §14.
* **Rules in code or consultant scripts.** Ours are data, in the screen, with a **"try it on an example"** simulator (the same device the approvals and charge-policy screens already have).
* **Thin on shelf life by customer.** Supermarket chains reject stock with less than a set share of its life left, while a kiosk takes what is cheap. Few systems model this per customer. We do (§11.4).

---

## 2. Design stance

1. **Location stays the unit of availability, cost and the books.** The bin ledger sits *under* the location ledger and never changes a figure the books read.
2. **Two ledgers, one invariant.** For every bin-controlled location, `Σ bin quantity = location on-hand`, per product, always. Enforced where the writes happen, proved nightly.
3. **Promises at the location; physical choices at the bin.** An order *reserves* at the location (fast, already built). A *pick task* later chooses bins and batches. The web checkout never touches a bin row.
4. **Rules are data, explained, and testable before they go live.**
5. **Three modes, switched per location**: Off (today), Track, Directed.
6. **Lot and expiry are first-class** and part of the bin key.
7. **Every physical fact has a time, a person and a reason**, like every other stage in the system.
8. **Works with a phone and a printed sheet.** No hardware is required.
9. **Nothing is deleted that stock or history points at**: bins are retired, never removed.

---

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Location** | Existing: a warehouse, shop, van, quarantine. Holds the stock figures the books and the shop read. |
| **Bin mode** | Per location: **Off** (no bins), **Track** (bins are recorded; the system places and takes automatically; people may move stock), **Directed** (the system creates put-away, pick, replenish and count **tasks** that people confirm). |
| **Bin** | The smallest place stock sits in: a shelf slot, a floor position, a cage. Only bins hold stock. |
| **Container** (zone, aisle, rack, level) | A node above bins that groups them. Holds no stock itself; shows totals. The names of the levels are the company's own. |
| **Bin type** | What a bin is for: *storage*, *pick face*, *bulk reserve*, *receiving*, *dispatch*, *quarantine*, *damaged*, *returns*, *floor stack*, *van shelf*. Drives what is allowed and whether stock there can be sold. |
| **Bin balance** | Quantity of one product, one batch (if tracked), in one bin. |
| **System bin** | One per bin-controlled location, `UNASSIGNED`. Holds whatever has no better place; never a destination people choose. |
| **Bin content** (assignment) | Says a product belongs in a bin: a **pick face** with a minimum and maximum, a **default** bin, or a **preferred** one. |
| **Lot** (batch) | A production or receipt batch of a product, with an expiry date. |
| **Task** | One instruction to a person: move *this* quantity of *this* lot from bin A to bin B, because of *this* document. |
| **Task list** | Tasks grouped to be done in one walk: a pick list, a put-away list, a count sheet. |
| **Put-away rule / Removal rule** | An ordered rule that chooses the destination bin, or the source bins and lots. |
| **Unavailable** | Quantity at a location that is physically there but must not be sold (in a quarantine bin, on hold, expired). |

---

## 4. The model

The existing tables stay as they are, with three small additions (§4.1, §4.2). Everything else is new and additive.

### 4.1 `stock_locations`: new columns

| Column | Notes |
|---|---|
| `bin_mode` | `off` (default), `track`, `directed`. A check constraint; changed only by the go-live and wind-down documents (§12.1). |
| `bin_levels` | JSON, validated: an ordered list of 1 to 5 level names, for example `["Zone","Aisle","Rack","Shelf","Position"]`, with an optional code pattern per level. Names are the company's: a shop may use `["Room","Shelf"]`, a depot `["Yard","Stack"]`. |
| `bin_code_separator` | Default `-`. The full code of a bin is its segments joined by it (`A-03-2-B`), as SAP Business One composes codes. |
| `bins_went_live_at` | Server time of the go-live. |

### 4.2 `stock_balances`: one new column

`unavailable numeric(14,3) not null default 0 check (unavailable >= 0 and unavailable <= on_hand)`: the part of `on_hand` that sits in bins or lots that cannot be sold. A projection, maintained in the transaction that changes a bin balance. **Available becomes `on_hand − reserved − unavailable`.** For a location with bins off it is always 0, so nothing changes for anyone who does not use bins. `availability.ts`, `reservations.ts` (the grid that plans sourcing) and the shop availability read need this one subtraction; §9 lists them.

### 4.3 `stock_bin_types`

| Column | Notes |
|---|---|
| `id`, `company_id`, `code`, `name` | Unique code per company. System rows seeded: the ten in §3 as `role`. |
| `role` | `storage`, `pick_face`, `bulk`, `receiving`, `dispatch`, `quarantine`, `damaged`, `returns`, `floor_stack`, `van_shelf`. |
| `counts_as_available` | False for quarantine, damaged, returns-awaiting-inspection. Stock in such a bin adds to `unavailable`. |
| `allows_receipt`, `allows_putaway`, `allows_pick`, `allows_dispatch`, `allows_count` | What the bin may be used for. Business Central's bin type does exactly this. |
| `default_mixing` | `any`, `one_product`, `one_lot`; a bin can override it. |

### 4.4 `stock_bins` (the structure and the places)

One row per node. Only **leaf** rows hold stock; a trigger refuses a bin balance on a node that has children, and refuses a child under a node that holds stock.

| Column | Notes |
|---|---|
| `id uuid`, `company_id`, `location_id` | |
| `parent_id` (self) | Null for the top level. Depth never exceeds the location's `bin_levels` length. |
| `level smallint` | 1 to 5. |
| `segment` | This node's own code (`03`). Letters, digits, no separator character. |
| `full_code` | Composed (`A-03-2-B`). **Unique per location, case-insensitive**; this is what is printed and scanned. |
| `path text` | `A/03/2/B`; an index with `text_pattern_ops` answers "everything under aisle 03" with a prefix search. Renaming a node rewrites the paths and full codes of its subtree in one transaction (rare, audited). Ids, never codes, are what other tables point to. |
| `bin_type_id` | Leaf only. |
| `label_code` | A short, printed, unique code for scanning (`B004217`), independent of `full_code`, so a re-labelled shelf keeps its history. |
| `is_leaf`, `is_active`, `is_system` | System bin is created with the location; cannot be retired, renamed or chosen as a destination. |
| `block_inbound`, `block_outbound`, `block_count` | Like Business Central's block movement, with a reason column. |
| `pick_sequence int` | The walking order; suggested from the structure, adjustable. A pick list is sorted by it. |
| `ranking smallint` | 1 to 100; breaks ties between equal candidates. |
| `storage_class` | From a company list (`ambient`, `chilled`, `frozen`, `secure`, `hazard`). A product may demand a class; only bins of that class qualify. |
| `mixing` | Null (use the type's), `any`, `one_product`, `one_lot`. |
| `capacity_units`, `capacity_weight_kg`, `capacity_volume_m3`, `capacity_positions` | Any or none. Units are in the product's base unit and only meaningful for a bin held by one product; weight and volume are the general case; positions suit floor stacks and pallets. |
| `used_weight_kg`, `used_volume_m3`, `used_positions` | Maintained on every bin movement from product weights and volumes (the products already carry them). Makes the capacity filter an index read (lesson 4). |
| `version`, `created_at`, `updated_at`, `retired_at`, `retired_reason` | |

Constraints and indexes: unique `(location_id, lower(full_code))`; unique `(company_id, label_code)`; `(location_id, path text_pattern_ops)`; partial index of leaf, active, putaway-allowed bins that are empty, by `(location_id, storage_class, ranking desc, pick_sequence)` (the "empty bin" search); check that capacities are positive when set; at most one system bin per location (partial unique).

### 4.5 `stock_bin_assignments` (what Business Central calls bin content)

| Column | Notes |
|---|---|
| `product_id`, `location_id`, `bin_id` | Unique per `(product_id, bin_id)`. |
| `role` | `pick_face` (a fixed forward bin, replenished), `default` (where receipts go when no rule says otherwise), `preferred` (a soft hint). |
| `min_quantity`, `max_quantity` | In the base unit, **entered and shown in the pack the company uses** (cartons and pieces). Replenishment triggers below the minimum and fills to the maximum. For a product sold in several units, a maximum is held once in base units, which is simpler than Business Central's requirement to set one per unit. |
| `fixed` | A fixed assignment stays when the bin is empty (so the bin is found again after replenishment). Otherwise it disappears at zero. |

One `default` per `(product, location)`. A hierarchy decides the default when a receipt names no bin, SAP Business One's ladder: **product default → category default → location default (receiving bin) → system bin.**

### 4.6 `stock_lots` and product tracking

* `products.tracking`: `none` (default), `lot`, `lot_expiry`. Serial numbers are out of scope here.
* `products.shelf_life_days` (optional): lets the system suggest an expiry date at receiving from the manufacture date.
* `stock_lots`: `id`, `company_id`, `product_id`, `code` (the batch number as printed), `manufactured_on`, `expires_on`, `received_on`, `supplier_lot`, `vendor_id` (nullable), `state` (`ok`, `hold`, `recalled`, `expired`), `state_reason`, `created_by`. Unique `(product_id, lower(code))`. A lot is created at receiving or opening balance, or on the fly at a count; it is never edited once stock has moved, except its `state`.
* **Expiry is a date in the business time zone** (the existing setting), not an instant.

### 4.7 `stock_bin_balances` (the contents of each bin)

| Column | Notes |
|---|---|
| `id uuid`, `company_id`, `location_id`, `product_id`, `bin_id` | |
| `lot_id` (nullable) | Null for products with `tracking = none`. |
| `expires_on` | Copied from the lot, so the FEFO index needs no join. Set once. |
| `on_hand numeric(14,3)` | `check (on_hand >= 0)`: a bin never goes negative. A location that allows negative stock books the shortfall in the system bin only. |
| `allocated numeric(14,3)` | Held by open pick tasks; `check (allocated >= 0 and allocated <= on_hand)`. A soft hold so two pickers are not sent for the same cartons. **Not** the order's reservation, which stays at the location. |
| `unavailable` (boolean, derived from bin type and lot state) | Stored so the projection to `stock_balances.unavailable` is one sum. |
| `version`, `updated_at`, `last_moved_at`, `last_counted_at` | |

Unique `(location_id, product_id, bin_id, coalesce(lot_id, zero-uuid))`. Indexes: `(bin_id)`; `(location_id, product_id)`; the **FEFO index** `(location_id, product_id, expires_on nulls last, last_moved_at)` where `on_hand > allocated and not unavailable`; the **FIFO index** on `(location_id, product_id, first_received_on)`; a partial index of empty rows for the nightly sweep that deletes them (an empty row is not history; the ledger is).

### 4.8 `stock_bin_movements` (the bin ledger, append-only)

The twin of `stock_movements`, and the reason bins never reach the books.

| Column | Notes |
|---|---|
| `id bigint identity` | Ordered, dense. |
| `company_id`, `location_id`, `product_id`, `lot_id`, `bin_id` | |
| `quantity` (signed, never zero) | |
| `kind` | `receipt`, `issue`, `move_out`, `move_in`, `count_variance`, `adjust`, `status_change`, `opening` (go-live), `wind_down`. |
| `movement_id bigint null` | The `stock_movements` row this belongs to, **when the location total changed** (a receipt, an issue, a count variance). **Null for a relocation inside the location**, which changes no location figure and posts nothing to the books. |
| `pair_id uuid null` | Joins the `move_out` and `move_in` halves. |
| `task_id uuid null`, `document_type`, `document_id`, `document_line_id` | What caused it. Same idempotency key idea as the location ledger: unique on `(document_type, document_id, document_line_id, bin_id, lot_id, kind)` where a line id exists. |
| `reason_code`, `actor_type`, `actor_id`, `occurred_at`, `recorded_at`, `correlation_id`, `note` | As the location ledger. |

Append-only by trigger. Indexes `(bin_id, id)`, `(product_id, location_id, id)`, `(movement_id)`, `(document_type, document_id)`.

**Invariants** (written as database checks where possible and proved by the integrity job, §13.3):

* **I1.** For a bin-controlled location, per product: `Σ bin_movements.quantity where movement_id is not null = Σ stock_movements.quantity` for the same movements. Equivalent: `Σ bin on_hand = stock_balances.on_hand`.
* **I2.** `Σ bin_movements.quantity` per `(bin, product, lot) = bin balance on_hand`.
* **I3.** `stock_balances.unavailable = Σ bin on_hand where unavailable`.
* **I4.** `Σ allocated` per bin row equals the open quantity of the pick tasks pointing at it.
* **I5.** `used_*` on a bin equals what its balances weigh.
* **I6.** No stock on a node with children; no bin with stock is retired.

### 4.9 Rules: `stock_bin_rules`

One table, `kind` of `put_away` or `removal`.

| Column | Notes |
|---|---|
| `company_id`, `location_id` (null = every bin-controlled location), `kind`, `name`, `sequence`, `state` (`draft`, `active`, `retired`), `version` | Changes are in the decision log, with a reason, and take effect only when published (draft, try on an example, publish), the pattern of the delivery charge policies. |
| `conditions` (JSON, validated) | When it applies: product, product category, tracking kind, storage class, pack unit, velocity class (A/B/C), document kind (purchase receipt, return, transfer in); for removal also: channel, customer group, customer, delivery or van load. |
| `method` | Put-away: `pick_face`, `default_bin`, `same_product_same_lot`, `same_product`, `empty_bin`, `bulk_by_capacity`, `nearest_to_dock`, `fixed_bin`. Removal: `fefo`, `fifo`, `lifo`, `fewest_bins`, `pick_face_first`, `nearest`, `whole_pallet_first`. Explained in §10 and §11. |
| `target` (JSON) | Where to look (put-away): a zone path, bin type roles, a storage class, or named bins. |
| `tie_breaks` | An ordered list: `ranking`, `pick_sequence`, `fullest_first`, `emptiest_first`, `oldest_stock_first`. |
| `constraints` | `respect_capacity`, `respect_class`, `respect_mixing` (all on by default; turning one off needs a reason and shows a warning). |

A set of company defaults is created when bins are first used, so a business gets sensible behaviour without writing a rule.

### 4.10 Tasks: `stock_task_lists` and `stock_tasks`

`stock_task_lists`: `id`, `company_id`, `location_id`, `number` (from the number series: `PUT-`, `PCK-`, `RPL-`, `MOV-`), `kind` (`put_away`, `pick`, `replenish`, `move`, `count`), `state` (`open`, `assigned`, `in_progress`, `done`, `partly_done`, `cancelled`), `source_type`, `source_id` (a delivery, a goods received note, a transfer, a van load, a count), `assignee_user_id`, `priority`, timestamps for each state, `version`.

`stock_tasks` (lines): `id`, `list_id`, `sequence` (walking order), `product_id`, `lot_id`, `from_bin_id`, `to_bin_id` (either may be null for receiving at the dock or dispatching), `quantity`, `quantity_done`, `state` (`open`, `done`, `short`, `skipped`, `cancelled`), `source_line_id`, `rule_id` and `trace` (JSON in plain words: which rule, which tie-break, what was free), `done_by`, `done_at`, `short_reason`, `device_time` (kept beside the server time, never used for ordering).

A **short pick** (the picker finds less than the system says) records the difference, marks the bin for an immediate **count task**, and re-allocates the rest of the line from other bins in one step. This is the self-healing loop (§11.5).

### 4.11 Customers and products: two small fields

* `customers.min_shelf_life_percent` (nullable, 1 to 100) or `min_shelf_life_days`: used by the removal rule to skip lots that are too old for this customer (§11.4).
* `product_barcodes` (product, pack unit, `code`, `kind` = `gtin`, `internal`, `case`, `label`): **several codes per product and per pack**, because many African products have no GTIN, or a distributor labels cartons itself. (Check what exists first: the catalogue has SKU; this may extend it.)

---

## 5. How the two levels work together

```
 order reserves ────────────► stock_balances (location, product)         fast, existing, no bin
                                     │  on_hand, reserved, unavailable
 pick task allocates ───────► stock_bin_balances (bin, lot)              later, in the warehouse
                                     │
 pick confirmed ────────────► StockLedger.post(location, −q) + bin movements (−q per bin/lot)
                                     │                │
                                     ▼                ▼
                              stock_movements   stock_bin_movements ──(movement_id)──┐
                                     │                                                │
                                     ▼                                                │
                                the books (unchanged)         relocation: bin movements only, movement_id null
```

* **Writers.** `StockLedger.post()` stays the one writer of location stock. It gains an optional `bins` argument: a list of `{binId, lotId, quantity}` that must add up to the movement quantity. For a bin-controlled location the argument is required, and in Track mode a resolver fills it from the rules before the call. For a location with bins off it is ignored, so every caller works untouched. A new `BinLedger.move()` writes relocations (two bin movements, no location movement).
* **Order of locks.** Always: location balance row first (as now), then bin balance rows in `(bin_id, lot_id)` order. Two documents can never wait on each other.
* **No hot rows on the sale path.** A web order reserves at the location. Only warehouse activity (a pick, a put-away) touches bin rows, and that happens at the speed of people. When the pick face of a fast seller is busy, allocation takes the next bin with `SKIP LOCKED`.
* **Cost.** Unchanged and at the location. A bin move changes no value. Lots may later carry their own cost (not in this design; see §18).

---

## 6. The three modes

| | **Off** | **Track** | **Directed** |
|---|---|---|---|
| Who it suits | Shops, small stores, anyone today | A shop with a stock room, a small wholesaler, a van | A distribution centre, a wholesaler with a warehouse team |
| Bins exist | No | Yes | Yes |
| Receiving | Adds to location | Goods land in a bin (suggested by rule, or the receiving bin); can be changed on the screen | A **put-away list** is made; a person confirms each line by scanning |
| Selling | Issues from location | The system picks bins and lots by the removal rule when the sale posts, and records them; no task | A **pick list** is made when the order (or delivery) is released; the sale or delivery posts when picking is confirmed |
| Moving stock between bins | n/a | A person moves stock on the screen or phone | Move tasks, replenishment tasks, all confirmed |
| Counting | By location | By bin, on demand | By bin, by tasks, with cycle-count scheduling |
| Setup effort | None | A layout wizard, a few minutes | Layout, rules, labels, a short training |
| Moving up or down | Off → Track by go-live | Track → Directed by switching on tasks; Track → Off by wind-down | Directed → Track by switching tasks off |

Track mode is the one most Kenyan businesses will use for a long time, and it must be good on its own: a person looks up "where is the Kimbo 2kg?", the system names the bin and the batch, and a sale takes the oldest first without anyone being asked. Directed mode is for the few who need task discipline.

Mode is chosen **per location**, so one company can run a directed main warehouse, a tracked branch stockroom and an unbinned shop floor.

---

## 7. Structure: zones, aisles, racks, bins and sub-bins

### 7.1 Levels and the layout wizard

* A location defines 1 to 5 **levels** with its own names. "Sub-bin" is simply the deepest level; nothing about the model needs a special case for it.
* **The wizard.** The person picks a pattern for each level: a list (`Cold room, Dry store`), a range of numbers (`01 to 12`), or letters (`A to D`). The screen shows the bins it will make (`DRY-01-A` … `DRY-12-D`), the count, and any clash with existing codes, then creates them in one transaction (up to 5,000 per run; larger layouts by import). Bins get a type, a storage class and a pick sequence from the pattern (snake order optional: odd aisles up, even aisles down).
* **Import.** A CSV of bins (code, type, class, capacities) is checked and previewed before it is applied; the same pattern as product import.
* **Naming.** `full_code` is composed from the segments and the location's separator (SAP Business One's approach). Reserved: `UNASSIGNED` for the system bin.

### 7.2 Bin types and what they mean

The ten seeded roles cover a distributor's day. Each does three things in code: says whether the stock is **sellable**, says which **activities** are allowed (receive, put away, pick, dispatch, count), and sets a default **mixing** rule.

| Role | Sellable | Typical use |
|---|---|---|
| Receiving | No (until put away) | The dock: goods wait here after the lorry. |
| Storage | Yes | Ordinary shelves and racks. |
| Pick face | Yes | The forward slot that orders are picked from; has min and max. |
| Bulk reserve | Yes | Cases or pallets above or behind the pick face; replenishes it. |
| Floor stack | Yes | Block storage on the floor: rice, sugar, cement, drinks crates. Capacity by positions. |
| Dispatch | No | Where picked goods wait for the van. |
| Returns | No | Returned goods awaiting inspection. |
| Quarantine | No | Held for quality or a recall. |
| Damaged | No | Written-off-to-be, counted as stock until written off. |
| Van shelf | Van channel only | A shelf or crate in a van. |

A company may add its own types and may switch a role's availability only with a permission (selling from `returns` by mistake is a common leak).

### 7.3 Containers show totals

Zones, aisles and racks have no stock of their own but show **what is under them**: bins, bins in use, used capacity, number of products, value at cost (reading the location's average cost, which is a view, not a stored figure). A **map view** draws a level as a grid coloured by utilisation (empty, partial, full, blocked), which is also the quickest way to find a free spot by eye.

---

## 8. Batches, lots and expiry

Because lot is in the bin key, this belongs in the same programme (phase B-2), but a company can use bins without lots and lots without bins in Track mode.

* **Tracking is per product.** `none`, `lot`, `lot_expiry`. Changing it on a product with stock is a document (the existing stock goes into one lot named `OPENING` with no date, then people split it by count).
* **At receiving** the lot code and expiry are entered (or scanned from a GS1-128 label if present, §14.3). A purchase receipt line can carry several lots. For `lot_expiry`, the expiry is required; if the product has a shelf life, the screen suggests the date from the manufacture date. The system warns if the received shelf life is shorter than the company minimum.
* **A lot's state.** `ok`, `hold` (sellable only after release; an inspection), `recalled`, `expired` (set by a nightly job when `expires_on` passes in the business time zone; the job updates the bins' `unavailable` flags in slices). Stock in a lot that is not `ok` counts in `stock_balances.unavailable`. Allocation re-checks the date at pick time, so an hour of delay between midnight and the job never ships expired goods.
* **Near-expiry** is a configurable window (days or percent of life) per product category. Inside it: the stock is flagged on screens and in a report, and the removal rule offers it first. A company can choose to block sale inside the window, or leave a price-reduction decision to people.
* **Recall.** One action: mark a lot `recalled`. The screen lists every bin holding it, every customer it was delivered to (by delivery and invoice lines), and creates move tasks to a quarantine bin. This is a real day-one need for food and cosmetics.
* **Traceability reports.** Forward (this lot went to these customers) and backward (this delivery's goods came from these lots and this supplier receipt). Both are queries over the bin ledger, with no extra storage.

---

## 9. What changes in the code we have (integration map)

| Area | Today | Change |
|---|---|---|
| `StockLedger.post` | One movement and the balance, per location | Accepts `bins`; in bin-controlled locations writes bin movements and bin balances in the same transaction, updates `unavailable`. Locations with bins off: untouched. |
| `StockReservations.reserveIn` | Plans sourcing from `on_hand − reserved` | Use `on_hand − reserved − unavailable`. Reserve stays at the location. |
| `StockReservations.consumeIn`, `consumePartIn` | Issue from the location | In bin-controlled locations call the bin resolver (Track), or consume the confirmed pick (Directed). |
| `receiveGoodsBackIn`, `undoReceiptIn` | Put goods back at the location | A bin is chosen by the returns rule, default the returns bin. |
| `StockAvailability`, shop availability | Sum of shards, minus reserved | Minus `unavailable`. One place, one helper. |
| `TransferService` | Ship from, receive into locations | Ship allocates bins and lots (task list in Directed); receive puts into the receiving bin or by rule. Transit location needs no bins. |
| `CountService` | Count lines per product and location | Lines gain `bin_id`, `lot_id`. A count can be "this bin" or "this aisle". Variance posts bin movements and the location movement together. |
| Goods received notes (vendors) | Put stock at a location | Lines carry lot and expiry; in Directed mode create the put-away list. |
| Delivery picking steps (*Release for picking, Start picking, Record what was picked, Mark packed*) | Quantities typed per line | Each step reads the pick list; "record what was picked" is the task confirmation, with the bins and lots as picked. |
| Van sales loads | A transfer into the van location | A van's shelves are `van_shelf` bins if the company wants them; otherwise the van is Off. |
| POS and shop issue | Reserve and issue at the location | Unchanged on the web path. At the till in Track mode the resolver picks bins and lots when the sale posts. |
| Books (`finance_capture_stock_movement`) | Trigger on location movements | **No change.** Bin movements never enter it. |
| eTIMS stock reporting | By branch and item | **No change.** Bin moves are not reported to KRA. |
| Cutover and shadow journals | Old counters mirror | Not affected; bins are new. |
| `stock-integrity-check` job | Proves balances | Adds I1 to I6 (§13.3). |
| Access control | `stock:*` | New keys (§12.4). |
| Reports | Stock by location | New: stock by bin, expiry ageing, bin utilisation, put-away and pick performance, count accuracy by bin (§16). |
| Navigation and SEO registry | | One entry under *Products & Inventory*; a `platform-modules.ts` entry; implementor guide chapter. |

---

## 10. Put-away

### 10.1 When it happens

Goods arrive: a purchase receipt, a customer return, a transfer received, a production or opening balance. They land in the location's **receiving bin** (system default) or the bin the person scans. **Put-away** moves them to their resting place. In Track mode the system chooses the resting bin at once and says so; in Directed mode it creates tasks.

### 10.2 How a bin is chosen

1. **Hard filters** (a bin that fails is never offered): active leaf; type allows put-away; not blocked inbound; storage class meets the product's; mixing rule would hold; capacity left (units, weight, volume, positions: the smaller wins, as in Oracle); not the system bin.
2. **Rules in sequence.** The first rule whose conditions match the product and document is tried; if it finds a bin, that is the answer, otherwise the next rule runs (Business Central's template lines, Oracle's strategies). The first matching rule that finds a bin wins; the `trace` says which.
3. **Methods**, each a single indexed query:
   * `pick_face`: the product's fixed pick face, if it has room under its maximum.
   * `default_bin`: the product's default, then its category's, then the location's receiving bin (the ladder from §4.5).
   * `same_product_same_lot`: a bin already holding this lot, with room. **Consolidates**, and by design keeps one lot per bin.
   * `same_product`: a bin already holding the product; refused if the product tracks lots and the bin's rule is `one_lot` unless the lot matches.
   * `empty_bin`: an empty bin matching class and type, by ranking then pick sequence.
   * `bulk_by_capacity`: the bin that fits the quantity with least waste (best fit), for reserve storage.
   * `nearest_to_dock`: lowest pick sequence for fast movers (velocity class A).
   * `fixed_bin`: a named bin.
4. **Tie-breaks** run in the order the rule lists; a final tie falls to bin code so the answer is stable.
5. **Splitting.** If one bin cannot take the whole quantity, the next candidate takes the rest; each part is a task line.
6. **Manual choice** is always allowed (a scan of a different bin), within the hard filters, and records that the suggestion was overridden and why (a reason from a short list). Overrides are a report: they show where the rules do not match how people work.

### 10.3 The defaults a company gets

1. Fixed pick face with room (products that have one).
2. Same product and same lot, with room.
3. Empty bin of the right class, by ranking.
4. Receiving bin.

A company edits, reorders or replaces these. The conflict between rule 2 and FEFO (lesson 3) is handled by the **mixing rule** (`one_lot` is the default for lot-tracked products) and by the removal side choosing by expiry across bins.

### 10.4 Simulator

*Rules → Try it*: pick a product, a quantity and a document kind; the screen lists every rule, whether it matched, which bins it considered, why each was kept or dropped, and the final choice. Nothing is posted. This is the answer to "why did it put it there".

---

## 11. Picking (removal), replenishment and moving

### 11.1 Removal rules

Evaluated per order line (or delivery line), in sequence, like put-away.

| Method | Meaning | Default for |
|---|---|---|
| `fefo` | First expired, first out: sort bin-lots by `expires_on` (undated last), then by older stock, then pick sequence | Any product with `lot_expiry` |
| `fifo` | By the date the lot or bin stock was first received | Products with `lot` and no expiry |
| `lifo` | Newest first (rare; building materials) | Chosen |
| `fewest_bins` | Take whole bins first to empty and free them | Optional tidy-up |
| `pick_face_first` | Pick face first, then reserve | Products with a pick face |
| `nearest` | By pick sequence | Products with no lot |
| `whole_pallet_first` | Full units of the bulk pack first | Wholesale lines of whole cartons |

Consistency restrictions, from Oracle: a rule may require **one lot per line** or **one lot per order line**, because some customers will not accept mixed batches on one line.

### 11.2 Allocation, step by step

For each line, in one transaction, in a stable `(product, bin)` order:

1. Read the candidate bin-lots that pass the filters: location, product, outbound allowed, not unavailable, lot `ok`, lot not expired today, customer's minimum shelf life met (§11.4), `on_hand − allocated > 0`.
2. Sort by the rule's method and tie-breaks.
3. Lock rows with `FOR UPDATE SKIP LOCKED`, taking quantity until the line is covered. If skipping left the line short, one more pass without skipping (so a busy row delays rather than refuses).
4. Raise `allocated`, create the pick task lines with their `trace`.
5. If stock in bins still cannot cover a quantity the location *reserved* (data drift, or stock only in unavailable bins), the line is **short**; the order screen says so in words and a count task is raised on the likely bins.

The reservation is consumed when picking is confirmed, not when it is allocated.

### 11.3 Pick lists

A list groups lines by delivery, run, van load or wave; tasks are sorted by `pick_sequence` so one walk covers the warehouse in order. Options: pick by order (one order at a time), pick by batch (several orders together, sorted into totes after, §11.6), pick by zone (the list is split by zone for different people). The list prints as a sheet (bin code, product, pack and pieces, lot and expiry, a tick box) and shows on the phone. Quantities show as **cartons and loose pieces** using the product's units; the base unit is what is stored.

### 11.4 Shelf life by customer

A customer (or customer group) may have `min_shelf_life_percent` or days. A lot qualifies for that customer only if its remaining life at the planned delivery date is at least that. Lots that do not qualify are skipped for that customer's lines but remain eligible for others. A line that can only be met with lots that do not qualify is shown as **short for this customer** with the choice to ask a person to approve a shorter life (approval engine). Supermarket chains and institutions need this; kiosks do not use it, which is why it is optional.

### 11.5 Short picks heal themselves

When a picker confirms less than the task, the system: records the shortfall with a reason (`not found`, `damaged`, `expired`, `other`); marks the bin for a **count task** now; reallocates the rest of the line from other bins in the same step; and, if nothing else covers it, tells the order. The next person at that bin counts it, and the variance goes through the existing count approval. A pattern of short picks in one bin appears on the accuracy report.

### 11.6 Moving, replenishing and sorting

* **Move.** A person (or a task) moves quantity from one bin to another in the same location: scan or choose the source, the lot, the destination, the quantity. Allowed only if the destination type, class, mixing and capacity allow, the source is not blocked, and moving it does not take `available` below what is reserved (if stock moves into an unavailable bin and orders hold it, the screen lists the orders and refuses; the person can ask for those holds to be released).
* **Replenishment.** For each pick-face assignment: when on-hand in the face (less allocated) falls below `min_quantity`, a replenish task moves stock from the reserve bins, by FEFO so older dates are not buried behind newer ones, up to `max_quantity` and in whole bulk packs where the company says so. Triggers: after a pick confirmation (cheap check), at a scheduled time, or on demand from a screen that shows every face below minimum.
* **Sorting (batch picking).** For pick-by-batch, a task list has a second phase: put the picked cartons into one tote per order; the confirmation records which tote holds which order. A tote is a `dispatch` bin (it may be temporary) or just a label.

---

## 12. Operations as documents (and the rest of the lifecycle)

### 12.1 Go-live and wind-down

* **Go-live** (per location, needs `stock:bins_golive`): a checklist screen (levels named, bins created or generated, types set, rules reviewed, labels printed, system bin present) then a single document: *Switch on bins for <location>*. In one transaction it sets `bin_mode`, places the **entire current on-hand of the location in the system bin** as `opening` bin movements, sets `unavailable` to 0, and writes the decision log with a reason. From that moment invariant I1 holds. Stock is then moved out of `UNASSIGNED` into real bins by move tasks, a count, or an **opening placement sheet** (a CSV or a scan session per aisle).
* **Wind-down** (Track only): requires that no open tasks exist; moves all bin stock to the system bin, sets `bin_mode = off`; bins and history stay. Directed locations first return to Track.
* **Changing between Track and Directed** only toggles whether tasks are created; no stock moves.

This answers the one-way-door complaint: the first step is reversible, and nothing about the books changes at any step.

### 12.2 Receiving

Goods received note (vendor module) → location movement (existing) plus bin movements into the receiving bin or the rule's bin; lot and expiry captured. In Directed mode the receiving bin is the source of a put-away list. A receipt is **idempotent by its line key**, as today.

### 12.3 Returns and damage

A customer return puts stock in the `returns` bin; an inspection task decides: back to saleable storage (rule picks the bin), to quarantine, or to damaged (then the write-off document). All existing approvals still apply to the write-off.

### 12.4 Permissions (new keys)

`stock:bins_view`, `stock:bins_manage` (structure, types, assignments), `stock:bins_move`, `stock:bins_putaway`, `stock:bins_pick`, `stock:bins_rules` (create and publish), `stock:bins_golive`, `stock:lots_manage`, `stock:lots_hold` (hold, release, recall). Bin scoping follows the location's branch (the same scope as other stock actions). A warehouse role (picker, put-away clerk, supervisor) is seeded.

### 12.5 Approvals and the decision log

Through the existing engines: structure changes, rule publishing, go-live and wind-down, releasing a held lot, overriding minimum shelf life, large count variances. Each is in the decision log with who, when and why.

---

## 13. Scale, correctness and integrity

### 13.1 Capacity planning

Targets the design must meet on the CI database at a smaller scale and be recorded at full scale:

| Quantity | Target |
|---|---|
| Bins per location | 20,000 |
| Products with stock in bins | 40,000 |
| Bin balance rows per company | 1 million (worst case 3 million) |
| Bin movements per day | 500,000 |
| Put-away suggestion (one line) | p95 under 100 ms |
| FEFO allocation (one line, 4 candidate bins) | p95 under 80 ms |
| Pick list of 200 lines | under 3 s to build |
| Web checkout and till sale | **no added latency** |
| Replenishment scan, 5,000 faces | under 2 s |

How: the indexes in §4; the capacity filter reading `used_*` on the bin row; rules compiled to parameterised SQL (not row-by-row application code); the rule set per company cached in memory by version; candidate sets capped (200) with a deterministic order; the sale path never reading a bin table.

### 13.2 Concurrency

* Lock order: location balance → bin balances by `(bin_id, lot_id)`. Documents touching several products always sort by `(product_id, bin_id)`.
* Allocation uses `SKIP LOCKED` first, then waits for busy rows.
* All writes are idempotent by `(document, line, bin, lot, kind)`.
* Two people confirming the same task: the second is told it is already done (task state is checked and updated in one statement).
* Optimistic `version` on bins, rules and assignments for edits by two people.

### 13.3 The integrity job

Added to the nightly stock job, and runnable on demand: I1 to I6 (§4.8), plus *expired lots still counted available*, *tasks open longer than a set time*, *bins at their maximum with free capacity showing*, *duplicate full codes by case*. A failure raises a finding with exact keys. Nothing is fixed silently; a correction is a document with a reason.

### 13.4 Failure modes

| What happens | What the system does |
|---|---|
| A put-away rule finds no bin | The goods stay in the receiving bin; the list says "no place found: <why>" and the supervisor sees a **no-space** alert. |
| A bin is renamed while a task points at it | Tasks hold ids; the screen shows the new code. |
| The phone goes offline mid-pick | Confirmations queue locally (§14.4); the server accepts them in order and rejects any that conflict, with the reason. |
| Someone confirms a pick for a bin that was blocked after the task was made | Refused with the block reason; the line is reallocated. |
| Count shows more than the system | Variance posts as an adjustment through the existing approval and also raises a lot-unknown flag if the product tracks lots. |
| Lot expires between allocation and pick | Pick refuses that lot, reallocates by FEFO. |
| Capacity set lower than what is in the bin | Allowed (stock is real); the bin is marked over capacity and excluded from put-away. |
| Two companies' bins | Every table has `company_id`; every query is company-scoped; ids are never trusted from the browser. |

---

## 14. Built for where it will be used

The brief is Africa, not an idealised warehouse. These are the choices that follow from it. Where a point rests on a source, it is marked; where it is my reading of the market, it is marked as an assumption to confirm with real customers.

### 14.1 Phones, not scanners

The warehouse screens run in the browser on an ordinary Android phone (the rider app already shows the pattern). Scanning uses the **camera** (the browser's barcode detection, with a small WebAssembly decoder as a fallback). **Typing is always possible**: bin codes and label codes are short, with a check character, and there is a big-key entry mode. A Bluetooth or USB scanner acting as a keyboard works with no extra code. Nothing in this design requires a handheld.

### 14.2 Labels you can print on office paper

Bin labels and lot labels are produced as **A4 sheets** (a chosen grid, with a QR code and large readable text: bin code, zone, level) and as a plain list for a thermal printer if the company has one. QR content is `qsell:bin:<label_code>`, so a label survives a code rename. A label for a floor stack or a container door is just a larger one.

### 14.3 Products without GTINs

A source from April 2026 puts GS1 standard adoption across Africa at a little over 30% (an industry figure quoted by a news article, not a count I can check). Many local products arrive with no GTIN, and distributors label cartons themselves. So: several barcodes per product and per pack (§4.11); an **internal label generator** for products, cartons and lots; and, where a GS1-128 label **is** present, a reader for the Application Identifiers we need (GTIN `01`, batch `10`, expiry `17`). Where it is absent the screen asks for the lot and the date; it never blocks a receipt for a missing barcode.

### 14.4 Working through bad connections

* The task app keeps **today's open lists and the bin and product data it needs** on the device (as the offline till does with IndexedDB and a signed outbox) and confirms tasks locally with a device time.
* On reconnection the outbox is sent in order. The server validates each confirmation against current state. Because allocation was already done server-side before the list went out, most confirmations simply apply; the rest are rejected with a reason the person sees, and the line is reallocated.
* A put-away or pick is **never invented offline**: the system will not create new allocations while disconnected, only confirm those already issued. Moves and counts can be entered offline and are checked on sync.
* Server time orders everything; device time is kept beside it (existing rule).

### 14.5 Shelf layouts as they are

Floor stacks (sacks of rice and sugar, crates of drinks), shipping containers used as stores, open yards for building materials, a stockroom behind a shop, a chilled room: all supported by the **bin types**, **positions capacity** and the **configurable level names**. The wizard has starting templates in plain words: *Shop with stockroom*, *Warehouse with racks*, *Floor stacks and a cage*, *Cold room and dry store*.

### 14.6 Units as people count them

Sacks, cartons of 24, dozens, crates, loose pieces. Quantities in bins are in the base unit, shown and entered as "3 cartons + 5" from the product's pack units. Pick lists tell the loader how many *whole cartons* and how many *loose*, which is how a wholesaler's loaders actually work.

### 14.7 Shrinkage and trust

Theft and "lost" stock are a daily concern. The design supports: **blind counts** (counter never sees the system figure), **two-person counts** for high-value bins, a **secure** storage class (a cage; moves in or out need a supervisor), **reason codes on every move**, bin-level accountability (who last moved or counted), and a **shrinkage report** by bin and by person. Movement is never silent: every change has an actor and a time.

### 14.8 Kenya tax and compliance

KRA's eTIMS expects accurate stock records by item and branch, with stock-in and stock-out reported (the KRA page and a third-party connector describe this; the **exact endpoints and rules I have not verified against the official specification**). Bins sit **below** that line: a bin move changes nothing at branch level, so it is **never reported**; receipts and issues are, exactly as now through the location ledger. Expiry-dated food and medicine records also help with the regulators that inspect them; the traceability reports (§8) give them the answer in one screen. Other countries' schemes are the same kind of thing at branch level and need no change here.

### 14.9 Language and words

The product's rule stands (plain Kenyan English). Level names and bin type names are the company's own text, so a business can write them in Swahili or French; the screens do not embed assumptions about word order or length (codes are short, names wrap).

### 14.10 Small businesses first

A one-person shop with 3 shelves can turn on Track in five minutes: *Shop with stockroom* template, accept the preview, place the opening stock in a few scans, done. The first week's value is a screen that answers "where is the sugar and which bag is oldest?". If that is not useful to a shop, the rest does not matter.

---

## 15. Experience (screens)

Under **Products & Inventory → Warehouse** (no new top-level group).

| Screen | For | What it does |
|---|---|---|
| **Layout** | Manager | The tree of containers and bins; wizard; import; the map view with utilisation colours; labels; block, retire, rename. |
| **Bin types** | Manager | The ten seeded and company's own, with what each allows. |
| **Where is it?** | Everyone | One search box: product, bin, lot or barcode. Shows bins, lots, expiry and quantities, and **what is allocated**. Opens from every product and every stock line. |
| **Stock by bin** | Staff | Paged by bin or by product; filters by zone, class, near expiry, below minimum; export. |
| **Pick faces** | Manager | Assignments with min and max, current level, what the next replenishment would do. |
| **Rules** | Manager | The two lists, drag to reorder, draft and publish, **Try it**. |
| **Tasks** | Supervisor | Open lists by kind, who has them, how long they have waited; assign, re-prioritise, cancel with a reason. |
| **Counts** | Supervisor | Schedule cycle counts by zone and ABC class; count sheets; variance review. |
| **Lots and expiry** | Manager | Near-expiry, expired, on hold; hold, release, recall; forward and backward trace. |
| **Go-live** | Manager | The checklist and the switch-on document; wind-down. |
| **Warehouse app** (phone) | Loader, picker, clerk | Today's lists: *Put away*, *Pick*, *Move*, *Count*, *Replenish*. One instruction per screen, large type, bin code in colour, scan or type, "why here" under the instruction, a short-pick button. |

Each screen has the empty, loading, error and success states the project rules ask for, works at 390 px, and uses the existing pickers and paging. Nothing here is a native `<select>`. Everything the person must act on is in words ("Go to DRY-03-B and put 4 cartons of Kimbo 2kg, batch K2411, expires 12 Mar 2027 there. It is the oldest batch in that bin.").

---

## 16. Reports

* **Stock by bin, by zone, by class.**
* **Expiry ageing:** value and quantity by days to expiry, by category and location; expired stock waiting to be written off.
* **Bin utilisation:** used against capacity, by zone; empty bins; over-capacity bins.
* **Put-away performance:** time from receipt to put away; suggestion accepted or overridden, by rule.
* **Pick performance:** lines per hour, short picks, travel distance by pick sequence, by person.
* **Count accuracy:** variance by bin, by person, by product class; most-corrected bins.
* **Slotting suggestions (ABC velocity):** lines picked per product over a chosen period, compared with where it sits; "move these 20 products closer to dispatch". Suggestions only; people decide. Re-slotting is advised monthly for fast movers and quarterly otherwise (vendor guidance).
* **Shrinkage** by bin and by user.
* **Recall trace.**

All through the existing report engine and with the existing export rules.

---

## 17. Order of work

Each slice ships with unit, integration, API and end-to-end tests (phone and desktop), the implementor guide and the platform-modules entry. A slice is not done until its gate passes.

| Slice | Contents | Gate |
|---|---|---|
| **B-0 Structure** | Migration (bin mode, levels, types, bins, assignments); layout screens, wizard, import, labels, map; permissions; system bin; no stock yet | A 10,000-bin layout builds in under 20 s; codes unique; subtree rename correct; no effect on any existing screen |
| **B-1 Track mode** | `stock_bin_balances`, `stock_bin_movements`, `unavailable`, go-live and wind-down documents, ledger `bins` argument, default-bin ladder, simple removal (nearest), move screen, stock by bin, where is it, bin counts | I1 to I6 hold under a random workload of receipts, sales, returns, moves and counts; every existing stock test passes unchanged with bins off; zero added latency on web checkout (measured) |
| **B-2 Lots and expiry** | Tracking, lots, receiving with lots, FEFO and FIFO removal, nightly expiry job, near-expiry, hold and recall, trace reports, customer shelf life | FEFO proven against a randomised oracle; no expired lot ever allocated; recall lists correct bins and customers |
| **B-3 Put-away rules** | Rules table, engine, defaults, capacity filter, mixing, simulator, override report | Engine matches a reference implementation on 10,000 random cases; suggestion p95 under 100 ms at 20,000 bins |
| **B-4 Directed mode** | Tasks and lists, put-away lists from receipts, pick lists from deliveries and transfers, confirmations, short-pick loop, warehouse phone app with offline outbox | A concurrent pick test (50 pickers, hot products) with zero double allocation and zero deadlock; offline confirmation replay correct |
| **B-5 Replenishment** | Pick-face min and max, triggers, replenish tasks by FEFO | A fast seller never runs a face dry in a simulated day; older lots are not buried |
| **B-6 Counting by bin** | Cycle count scheduling, bin and aisle counts, blind and two-person counts, count tasks from short picks | Variance posts bin and location movements together; counts do not freeze sales |
| **B-7 Reports and slotting** | Section 16 | Reports reconcile to the ledgers to the unit |
| **B-8 Handling units** (optional) | Pallets and cases as scannable containers (licence plates) holding lots; moves of a whole pallet in one scan | Only if customers ask; see §18 |
| **B-9 Integrations** | Van loads from bins, vendor receipt notices (expected lots), export of the bin ledger | |

B-0 to B-2 are the first release: structure, Track mode and lots, with FEFO. That is what a distributor in the first year needs, and it is useful on its own. B-3 and B-4 are the second. The rest follow demand.

---

## 18. What this design deliberately does not do

* **Automation hardware** (conveyors, shuttles, RFID gates). Not the market.
* **Slotting optimisation by solver.** We give evidence and suggestions; the layout is a human decision.
* **Lot costing and FIFO layers.** Cost stays moving average at the location (stock-locations §7.1). A lot's own cost is a later, optional addition because it changes the books and needs its own design.
* **Serial numbers.** Different problem (one unit, one identity); later.
* **Handling units (pallets as objects)** are B-8 and optional: many African warehouses work in cartons and floor stacks and would pay for the complexity without using it.
* **Wave planning across docks and labour planning.** Pick lists can be grouped; scheduling people is not in scope.
* **Cross-docking and 3PL billing (storage by pallet-day).** Possible on this ledger later; not now.

---

## 19. Decisions needed (my recommendation first)

1. **Lots and expiry in the same programme?** *Yes*, B-2 right after Track mode. Bins without lots are half a solution for FMCG. If no: B-1 stands alone, and `lot_id` stays in the key unused.
2. **Unavailable stock: a column on the balance, or separate locations?** *A column* (§4.2), so a quarantine shelf inside the same warehouse is one move. The alternative (quarantine as a location) is what we do today and still works; both can be used.
3. **Bin hierarchy: path text or the Postgres `ltree` extension?** *Path text with a prefix index.* No extension to install on a customer's database, enough speed for prefix queries; `ltree` is a later optimisation if renames become common.
4. **Depth: 5 levels?** *Yes* (SAP Business One allows four; Business Central uses zone and bin; five covers zone, aisle, rack, shelf, position).
5. **Default mode for a new location?** *Off.* Never switched on without the go-live document.
6. **At the till and on the web in Track mode: who picks the bin?** *The system, by rule, at posting.* No task. People can correct afterwards on the move screen.
7. **A warehouse app of its own (`/warehouse`) or inside the rider app?** *Its own*, same pattern and shared offline code, because the people and the permissions differ.
8. **Order of Directed features:** *put-away and pick first, then replenishment.* Replenishment depends on the others and pays back only where there are pick faces.
9. **Customer minimum shelf life in B-2 or later?** *B-2*; it is small once lots exist and decides winning supermarket accounts.
10. **Bin labels:** *A4 sheets with QR and big text first*; thermal-printer output second.
11. **Language of screens:** *plain Kenyan English* as now; company-written names for levels and types.
12. **Pilot customer.** I want to design the layout wizard and the phone flow with one real Kenyan distributor or wholesaler and one shop before B-1 is final. Can you name them?

### Decisions taken

None yet.

---

## 20. Sources and how far to trust them

Public documentation of each product, read on 2026-11-25. I could not read every page in full and I did not run any of these systems; where a point comes from a vendor's blog or a forum, it is marked.

**Microsoft Dynamics 365 Business Central** (Microsoft Learn: reliable)
* [Set up put-away templates](https://learn.microsoft.com/en-us/dynamics365/business-central/warehouse-how-to-set-up-put-away-templates)
* [Set up bin contents](https://learn.microsoft.com/en-ca/dynamics365/business-central/warehouse-how-to-set-up-bin-contents)
* [Set up locations to use bins](https://learn.microsoft.com/en-us/dynamics365/business-central/warehouse-how-to-set-up-locations-to-use-bins)
* [Set up items for directed put-away and pick](https://learn.microsoft.com/en-us/dynamics365/business-central/warehouse-how-to-set-up-items-for-directed-put-away-and-pick)
* [Design details: availability in the warehouse](https://learn.microsoft.com/en-us/dynamics365/business-central/design-details-availability-in-the-warehouse) and [warehouse overview](https://learn.microsoft.com/en-gb/dynamics365/business-central/design-details-warehouse-overview)
* Consultant write-up on the layered location setup and the "one-way door" remark: [DMSI](https://dmsiworks.com/blog/business-central-warehouse-management) (secondary; check against Microsoft's page before relying on the wording)

**NetSuite** (Oracle help: reliable; community threads: anecdotal)
* [Bin management](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2270284.html), [putaway strategies](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1541436052.html), [bin transfers](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1541441872.html), [advanced bin and numbered inventory](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N2271791.html)
* [Preferred bin logic thread](https://community.oracle.com/Netsuite/english/discussion/4501867/preferred-bin-logic-for-putaway-recommendations) (user reports, not official)

**SAP** (SAP Learning and Help: reliable; versions differ)
* [Applying putaway rules](https://learning.sap.com/courses/basic-customizing-in-sap-s-4hana-ewm/applying-putaway-rules), [stock removal strategies](https://learning.sap.com/courses/basic-customizing-in-sap-s-4hana-ewm/applying-the-stock-removal-strategies), [checking capacities](https://learning.sap.com/courses/basic-customizing-in-sap-s-4hana-ewm/checking-capacities), [structural elements](https://learning.sap.com/courses/customizing-core-processes-in-sap-s-4hana-ewm/creating-structural-elements-in-the-warehouse_a0552db5-78f5-4e4e-ab92-275c0f6be708)
* [Early capacity check during putaway](https://blogs.sap.com/2019/02/08/early-capacity-check-during-putaway/) (SAP community blog)
* **SAP Business One:** [bin locations](https://learning.sap.com/courses/managing-logistics-in-sap-business-one/exploring-bin-locations-in-sap-business-one) and [help for versions 9.x](https://help.sap.com/saphelp_sbo92/helpdata/en/ad/4f233a7b864c7cbe2b57ad09246adb/content.htm) (older release; behaviour in current releases should be checked)

**Oracle Fusion and WMS**
* [Rules engine](https://docs.oracle.com/cd/E26401_01/doc.122/e48828/T210618T210921.htm) (release 12.2, older), [subinventories and locators](https://docs.oracle.com/en/cloud/saas/supply-chain-and-manufacturing/26a/faims/considerations-for-creating-subinventories-and-locators.html), [suggest put-away location](https://docs.oracle.com/en/cloud/saas/readiness/scm/25c/inv25c/25C-inventory-wn-f38398.htm)

**Odoo** (documentation of versions 15 to 18; menu names vary by version)
* [Removal strategies](https://www.odoo.com/documentation/master/applications/inventory_and_mrp/inventory/warehouses_storage/removal_strategies.html), [storage categories](https://www.odoo.com/documentation/16.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/storage_category.html), [putaway rules](https://www.odoo.com/documentation/18.0/applications/inventory_and_mrp/inventory/shipping_receiving/daily_operations/putaway.html)

**FMCG practice** (WMS vendor content: guidance, not measured benchmarks)
* [FMCG storage and FEFO](https://www.cleverence.com/articles/business-blogs/how-to-storage-for-fmcg-5472/), [expiry-based picking](https://unicommerce.com/everything-ecommerce/how-do-i-manage-expiry-based-picking-like-fefo-batch-lot-control-especially-fmcg-cosmetics-pharma.md)

**Kenya and Africa**
* [KRA: stock management functionality for electronic invoicing](https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/stock-management-functionality-for-electronic-invoicing); the endpoint names come from a third-party connector ([Odoo eTIMS stock module](https://apps.odoo.com/apps/modules/18.0/l10n_ke_etims_stock_io)) and are **not verified against KRA's specification**
* [GS1 adoption in Africa](https://ewn.co.za/2026/04/15/why-greater-adoption-of-gs1-standards-is-key-to-achieving-africa-s-trade-potential) (a news article; the 30% figure is the article's, not mine)
* The statements in §14 about how African distributors work (cartons and floor stacks, thin scanner use, poor connections, shrinkage) are **my reading of the market** and the only thing in this document that I would like confirmed by two or three real customers (decision 12).
