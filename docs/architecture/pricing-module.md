# Pricing, Discounts and Promotions — Module Design

**Owner:** Sales. Pricing is a sub-module of Sales, not a module of its own: it is the commercial terms of selling (what a customer pays, what they are given back), and its only consumers are sales documents. The things it *uses* but does not own stay with their masters: product groups and kits (Products & Inventory), customer groups (Customers). Its approval triggers belong to the Sales approval module. Code stays in its own folder (`domains/pricing`) behind its services; the folder is a boundary, not a module.

**Status:** P-1 to P-5 built (see the sections at the end); batch- and expiry-aware promotions wait for warehouse batches. Part of the [Sales Order Platform blueprint](./sales-order-blueprint.md).
**Goal:** one configurable engine that can express every pricing model a distributor-and-retailer needs, resolves a price deterministically, and can always explain _why_ the customer was charged exactly what they were.

---

## 1. Design stance

Pricing is where most ERP projects go wrong: either too rigid (a price field on the product) or too free-form (rules nobody can predict). The design rests on four ideas.

1. **Separate "what is the base price" from "what reductions apply".** Base price resolution picks _one_ price from competing price sources. Discount and promotion resolution then applies _zero or more_ adjustments to it. They have different semantics (choose-one versus stack) and must never be mixed in one table.
2. **Specificity and priority, not order of entry.** When several price sources match, the winner is chosen by an explicit, documented rule: _most specific scope first, then priority, then newest, then lowest id_ — total, so the same inputs always give the same answer.
3. **Everything returns a trace.** The engine's output is a price **and** the list of every source considered, which won, which lost, and the rule that decided it; every discount's eligibility test with the values it read. The order line stores this trace.
4. **Configuration is data, versioned, effective-dated, approved.** Business users change prices and promotions without a release; every change is versioned, has an effective period, can go through approval, and past documents keep the version they used.

---

## 2. Concepts and vocabulary

| Term                | Meaning                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Price list**      | A named set of prices with a currency, a validity period, and a _scope_ (who or where it applies).                                         |
| **Price list line** | A price for a product (or variant) and unit, optionally with quantity breaks.                                                              |
| **Scope**           | The set of dimensions a price list applies to: customer, customer group, branch, route, sales type, channel, country/currency, and more.   |
| **Price source**    | Anything that can supply a base price: a price list line, a contract price, a fixed price, a cost-plus rule, the product's standard price. |
| **Base price**      | The single price chosen for a line before any reduction.                                                                                   |
| **Adjustment**      | A discount, surcharge, rebate accrual, promotion or free item that changes the line or the order.                                          |
| **Effective price** | Base price after all applicable adjustments, before tax.                                                                                   |
| **Trace**           | The recorded explanation of every decision above.                                                                                          |

---

## 3. Base price resolution

### 3.1 Price sources (all first-class, all configurable)

| Source                       | Use                                                                                | Notes                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Standard price**           | The product's list price                                                           | The floor of the chain; always exists for sellable products.                                |
| **Price list**               | Wholesale, retail, distributor, seasonal                                           | Many lists; each has scope, currency, validity, priority.                                   |
| **Customer-specific price**  | A negotiated price for one customer                                                | Scope = a single customer. Highest specificity.                                             |
| **Customer group price**     | Tiers such as Wholesale A/B, Retail, VIP, Government                               | Scope = a customer group.                                                                   |
| **Branch / location price**  | Different price in Nairobi vs Mombasa, or a warehouse                              | Scope = a branch or warehouse.                                                              |
| **Route price**              | Delivery route or van-sales route pricing                                          | Scope = a route (a dimension).                                                              |
| **Sales-type price**         | Cash sale vs credit sale vs on-account vs consignment                              | Scope = order type / payment type.                                                          |
| **Channel price**            | Ecommerce vs POS vs field sales vs B2B portal                                      | Scope = channel.                                                                            |
| **Country / currency price** | Price in USD, UGX, TZS, not a conversion of KES                                    | Scope = country dimension / currency. A price list is always in one currency.               |
| **Variant price**            | Size, colour, pack, grade                                                          | Line carries product + variant; variant may override or add to the product price (see 3.4). |
| **Unit-of-measure price**    | Price per piece vs per carton                                                      | A line is per (product, variant, UoM); conversions never silently reprice.                  |
| **Fixed / contract price**   | A price locked for a customer for a period, which ignores later list changes       | Scope customer (or group); has `locked` semantics (3.5).                                    |
| **Cost-plus / margin rule**  | Price = cost × (1 + markup) or cost ÷ (1 − margin), for items without a list price | Computed, never stored; trace shows cost source and markup.                                 |
| **Manual override**          | A salesperson types a price                                                        | Needs a reason; limited by the user's price-override limit; may trigger approval.           |

### 3.2 Choosing the winner

Inputs: product, variant, UoM, quantity, customer (and their groups), branch/warehouse, route, order type, channel, currency, document date.

1. **Collect candidates:** every price list line (and contract/fixed price) whose scope _matches_ the inputs, whose validity covers the date, whose currency equals the order currency (or is convertible by the declared rule, see 3.6), and whose quantity break covers the quantity.
2. **Rank by specificity**, highest first:
   `contract/fixed → customer-specific → customer group → route → branch/warehouse → sales type → channel → country → standard`.
   Specificity is a _configurable weight table_, not hard-coded, because some businesses rank route above customer group. The default is the order above.
3. **Within the same specificity**, higher **priority** (an integer on the price list) wins.
4. **Then** the **newest effective start**, **then** lowest id (so ties are deterministic and reproducible).
5. If nothing matches, fall back to the standard price; if there is none, the line **cannot be priced** and the order says so (never a silent zero).

**Combination scopes.** A list can be scoped by several dimensions at once (e.g. "Group = Wholesale AND Branch = Mombasa AND Sales type = Credit"). Its specificity is the _sum of the weights of the dimensions it constrains_, so a more constrained list outranks a less constrained one. Conflict detection (§9) warns when two lists would tie at equal weight and equal priority for the same product.

### 3.3 Quantity breaks

Each price line has ordered tiers (`from_qty`, `price`). Two modes, chosen per price list:

- **All-units:** the tier reached sets the price for _every_ unit (buy 100+, all at 90).
- **Incremental:** each tier prices only the units inside it (first 50 at 100, next 50 at 95).

Tiers can be defined on **line quantity**, on **total quantity of a group of products** (mix-and-match volume across a brand or category), or on **order value**. The trace states which quantity was measured.

### 3.4 Variants

A variant is a product with attributes (size, colour, grade, pack). Three configurable behaviours per product:

- **Inherit:** the variant uses the product's price unless a line exists for it.
- **Delta:** the variant adds or subtracts an amount or percentage from the product price (XL +50).
- **Own price:** the variant has its own price lines.

### 3.5 Locked and contract prices

A contract price has `locked_until`. While locked, later changes to price lists do **not** change it, and it **outranks promotions' price reductions unless the contract allows stacking** (flag on the contract). Expiry produces a task for the account owner (a workflow event) rather than silently reverting.

### 3.6 Currency

Every price list has one currency. If the order currency has no matching list, a **declared fallback** applies: convert from the base-currency price at the day's rate, using the rate table and the rounding rule, and the trace records the rate and its source. Price lists in the order currency always beat a conversion. Rounding is per currency (nearest 1, 5 or 10 minor units, or "charm" endings like .99), configured, and recorded in the trace.

### 3.7 Tax treatment

A price list states whether its prices are **tax-inclusive** or **tax-exclusive**. The engine normalises to net and tax-inclusive gross using the line's tax code (including the KRA tax class), so prices from lists with different conventions are comparable and the displayed price is what the customer pays.

---

## 4. Adjustments: discounts, promotions, rebates

### 4.1 Catalogue of adjustment types (the complete set, with how each is modelled)

**A. Line-level reductions**

| Type                               | Example                              | Model                                        |
| ---------------------------------- | ------------------------------------ | -------------------------------------------- |
| Percentage discount                | 10% off                              | `percent`                                    |
| Amount discount                    | KES 200 off per unit / per line      | `amount_per_unit`, `amount_per_line`         |
| Fixed price override               | This SKU is KES 999                  | `set_price`                                  |
| Quantity-break discount            | 5% off at 50+, 8% at 100+            | tiers on the rule (all-units or incremental) |
| Customer / group standing discount | Wholesale A gets 12%                 | a rule scoped to the customer or group       |
| Product/category/brand discount    | 15% off all brand X                  | rule target = product set                    |
| Time-based                         | Happy hour 4–6pm, weekend            | validity with days of week and time windows  |
| Clearance / near-expiry            | 30% off lots expiring within 30 days | target = a batch/expiry condition (Phase 5)  |
| Payment-method discount            | 2% for M-Pesa, 5% cash               | condition on tender type                     |
| First-order / new-customer         | 10% on first purchase                | condition on customer history                |
| Loyalty tier discount              | Gold members 7%                      | condition on loyalty tier                    |

**B. Order-level reductions**

| Type                                | Example                           | Model                                                                         |
| ----------------------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| Spend threshold                     | Spend 50,000, save 2,000          | `threshold` on order value                                                    |
| Tiered basket discount              | 5% over 20k, 8% over 50k          | tiers on order value                                                          |
| Header percentage / amount          | Manager-approved 3% off the order | manual adjustment with limit and reason                                       |
| Free shipping / delivery fee waiver | Free delivery over 10,000         | adjusts the delivery charge line                                              |
| Coupon / voucher code               | `WELCOME10`                       | rule requiring a code, with usage limits                                      |
| Gift card / store credit            | Redemption                        | a tender-like reduction, not a price reduction (kept separate for accounting) |

**C. Product-mix promotions**

| Type                             | Example                                          | Model                                                            |
| -------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| **Buy X get Y free (BOGO)**      | Buy 2 get 1                                      | trigger set, reward set, ratio, reward = free or % off           |
| Buy X get Y at a price           | Buy a phone, accessories at 50%                  | trigger + reward with percent or price                           |
| **Mix and match**                | Any 3 from this category for 1,000               | group of eligible products, required count, set price or percent |
| **Bundle / combo**               | Burger + fries + drink = 450                     | a defined bundle with components and a bundle price              |
| **Hamper / gift set**            | A Christmas hamper of 8 items                    | a **kit** (see 4.3), priced as a unit or by components           |
| Cheapest-free                    | Buy 3, cheapest free                             | reward chosen by rule among trigger items                        |
| Tiered gift                      | Spend 20k get a free item                        | threshold trigger with a free-item reward                        |
| Free sample / gift with purchase | Free pen with order                              | reward line at zero price with cost recorded                     |
| Substitution offer               | Out of stock, get the premium for the same price | an availability-driven adjustment, requires a reason             |

**D. Retrospective (rebates, accrual-based)**

| Type                      | Example                                   | Model                                                   |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| Volume rebate             | 2% back on purchases over 5M in a quarter | accrues per sale, settles by credit memo (via approval) |
| Growth rebate             | Rebate if sales grow 10% year on year     | needs prior-period actuals                              |
| Cashback / loyalty points | Earn points                               | accrual to a loyalty ledger, not a price change         |
| Settlement discount       | 2% if paid within 10 days                 | a payment-terms adjustment applied at cash application  |

### 4.2 Rule anatomy (one shape for every type)

A **promotion** (or discount rule) is:

```
Identity     code, name, description, type, lifecycle status, owner
Validity     start, end, days of week, time windows, time zone
Scope        who: customers, groups, segments, loyalty tiers, new/returning
             where: branches, warehouses, routes, channels, countries
             when: sales types, tender types
Target       what it can apply to: products, variants, categories, brands, tags, batches
Trigger      what must be present: quantity, order value, product set, coupon, code
Reward       what it gives: percent, amount, set price, free item(s), free shipping, points
Limits       per order, per customer per period, total budget (amount or uses), per day, per branch
Stacking     exclusive group, priority, combinable with (allow/deny list), "best of" vs "cumulative"
Guards       minimum margin %, floor price, max total discount % on the line/order
Approval     workflow required to activate; threshold above which a salesperson needs approval to use it
```

### 4.3 Hampers, kits and bundles (the "set" problem)

A set is more than a discount; it affects stock and tax. Three distinct constructs:

| Construct                    | Behaviour                                                       | Stock                                                                                              | Price                                                             |
| ---------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Kit / hamper (assembled)** | A product in its own right made of components; sold as one line | Components consumed on assembly or on sale (configurable); the kit can also be pre-assembled stock | Fixed kit price, or sum of components, or sum less a kit discount |
| **Virtual bundle**           | Customer picks components; no stock for "the bundle"            | Components reserved individually                                                                   | Bundle price allocated across components                          |
| **Combo / meal deal**        | Component choices per slot ("pick 1 drink")                     | Components individually                                                                            | Combo price with slot-level surcharges (premium drink +50)        |

**Allocation of a bundle price across components** is required for tax and for returns. Methods (configurable per bundle): proportional to component list prices (default), proportional to cost, or explicit amounts. The allocation is stored on the lines so a **partial return of one component credits the right amount**, and each component carries its own correct tax code (the KRA class can differ within a hamper).

Optional components, quantity limits per slot, substitutions (out-of-stock component swapped with a defined equivalent) and component-level availability (the hamper is only offered if all required components are available, or shows the shortfall) are supported on the kit definition.

### 4.4 Stacking and precedence (the part that must be predictable)

Adjustments are applied in a fixed **pipeline** so results never depend on the order the rules were created:

1. **Base price** (§3).
2. **Line price adjustments** (set-price, contract rules).
3. **Line discounts** in **discount groups**, in group priority order. Within a group, the rule says `exclusive` (only the single best applies), `best_of` (highest value), or `cumulative` (all apply, additive or compounding, as configured).
4. **Product-mix promotions** (BOGO, mix-and-match, bundles), which may consume units so a unit cannot earn two mix promotions (**unit allocation** — each unit is claimed by at most one promotion unless the rules explicitly allow sharing).
5. **Order-level adjustments** (threshold, header, coupon, shipping).
6. **Guards:** floor price and minimum margin are enforced last; if a stack would break a guard it is **trimmed** (and the trace says which rule was trimmed and why) or, per policy, **blocked pending approval**.
7. **Rounding** per currency rule.

Deterministic tie-break inside any step: higher priority, then larger benefit to the customer or smaller (configurable per group; default "most beneficial to customer"), then rule id.

### 4.5 Manual adjustments

Salespeople can reduce price or discount within **limits per user/role** (percentage and amount, per line and per order). Above the limit the document goes to approval through the workflow engine; the approval entry records the requested value, the limit, and the reason code. Every manual adjustment requires a reason code (controlled catalogue).

---

## 5. Data model (summary)

```
price_lists(id, code, name, currency, tax_inclusive, quantity_mode[all_units|incremental],
            priority, valid_from, valid_to, status, version, created_by, approved_by …)
price_list_scopes(price_list_id, dimension[customer|customer_group|branch|route|sales_type|channel|country],
                  operator[in|not_in], value_ids[])
price_list_lines(id, price_list_id, product_id, variant_id, uom, valid_from, valid_to, price, floor_price,
                 cost_basis, markup, locked_until)
price_list_tiers(line_id, from_qty, price|discount, measure[line_qty|group_qty|order_value])
price_specificity_weights(dimension, weight)                       -- configurable specificity
variant_pricing(product_id, variant_id, mode[inherit|delta|own], delta_amount, delta_percent)
rounding_rules(currency, method, increment, ending)

promotions(id, code, name, type, status, version, priority, exclusive_group, stack_policy,
           valid_from, valid_to, schedule jsonb, scope jsonb, target jsonb, trigger jsonb,
           reward jsonb, limits jsonb, guards jsonb, requires_approval, owner)
promotion_usage(promotion_id, customer_id, document_id, line_id, amount, used_at)   -- append-only
promotion_budget(promotion_id, consumed_amount, consumed_uses)                       -- projection, sharded
coupons(id, code, promotion_id, valid_from, valid_to, max_uses, per_customer_max, status)
bundles(id, product_id, kind[kit|virtual|combo], pricing_method, allocation_method)
bundle_slots(bundle_id, slot, min_qty, max_qty, product_set, surcharge)
bundle_components(bundle_id, slot, product_id, variant_id, qty, optional, substitute_ids[])
rebate_programs(id, basis, period, tiers jsonb, settle_via)  ;  rebate_accruals(program_id, customer_id, document_id, amount)  -- append-only
manual_adjustment_limits(role_or_user, percent_limit, amount_limit, scope)
price_resolution_trace(document_id, line_id, trace jsonb, engine_version)            -- stored on the line, referenced here
```

All configuration tables are **versioned and effective-dated**: editing creates a new version; documents store `price_list_version`/`promotion_version` so a re-print years later shows the same numbers and the same reasons.

---

## 6. The engine

```
priceLine(input)      → { basePrice, source, trace }                       (pure function over a snapshot)
applyAdjustments(order) → { lines[], orderAdjustments[], trace }            (pure; deterministic)
simulate(inputs, asOf) → same outputs without side effects ("price test" tool)
commit(order)         → writes usage, budget consumption, accruals, trace  (one transaction, idempotent)
```

- **Pure core, impure edges.** The calculation takes a _snapshot_ of configuration (loaded and cached per request) and returns a result. This makes it testable with thousands of generated cases (property tests: stacking never exceeds guards; the same input gives the same output; re-pricing a stored order reproduces its stored total).
- **Reading configuration at scale:** active price lists, promotions and weights are loaded into an in-process cache keyed by `(company, version)`, invalidated through the outbox on change. Price line lookup uses a covering index on `(product_id, variant_id, uom, valid_from)` and, for large catalogues, a precomputed **effective price index** per (scope-key, product) rebuilt asynchronously — the engine can always fall back to the live computation, so the index is an optimisation, never the source of truth.
- **Budgets and usage limits under concurrency:** consumption is recorded in `promotion_usage` (append-only) and enforced through a sharded counter so thousands of concurrent checkouts do not contend on one row; a limit may overshoot by at most the shard count in a burst, a documented and configurable trade-off (strict mode available for small budgets).
- **Quote validity:** a quote stores its prices with the trace and an expiry; converting it to an order reprices only if policy says so, and says why.

---

## 7. Lifecycle, approvals and governance

Promotions and price lists follow a state machine: **Draft → In review → Approved → Scheduled → Active → Paused → Expired / Retired**. Activation (and large price changes, measured by affected revenue or margin impact) goes through the approval workflow engine with the **impact preview** attached: how many customers and products are affected, projected margin change, conflicts found. Every transition records who, when, why.

**Conflict and quality checks before activation:** overlapping lists at equal weight and priority, a promotion that pushes any covered product below its floor, circular stacking rules, a promotion with no end date, a coupon with no limit, a bundle whose component is inactive.

---

## 8. Experience

- **Price book workspace:** a grid of products against price lists, bulk edit, import/export (CSV/Excel), copy-and-adjust ("last year +8%"), side-by-side compare, undo.
- **Promotion builder:** a guided form following §4.2, with a plain-language summary at the top ("Buy any 2 shirts from Brand X, get the cheapest one 50% off, Mombasa branch, weekends in December, max 500 uses") and a live **simulator**.
- **"Why this price?"** on every order line and POS line: shows the base price source, every rule considered, what applied, what was trimmed by a guard, in plain language.
- **Order entry:** instant local feedback while typing, server-authoritative price on save, visible badges for active promotions and for the next reachable one ("add 12,000 more to unlock 5% off").
- **Quality dashboards:** margin by promotion, uptake, budget burn, price variance by branch, overrides by user and reason.

---

## 9. Failure modes and how they are handled

| Failure                                        | Handling                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| No price found                                 | The line cannot be saved as priced; explicit "no price" with the scopes searched. Never zero.                              |
| Conflicting prices at equal rank               | Blocked at configuration time (conflict detection); at runtime a deterministic tie-break and a warning in the trace.       |
| Promotion budget exhausted mid-checkout        | The promotion is skipped for that order, the reason is recorded, the customer sees the price without it before confirming. |
| Rounding differences between client and server | The server is authoritative; the client shows "final price confirmed on save".                                             |
| Config changed while an order is open          | The order keeps its priced version until it is explicitly repriced; a banner offers repricing with a diff.                 |
| Engine bug                                     | The trace and stored version let any order be re-computed and compared; a replay tool flags divergences.                   |

---

## 10. Phasing

| Step                         | Delivers                                                                                                                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P-1** (with Sales Phase 1) | Price lists with scopes, specificity, priority, validity, currency, tax-inclusive handling; customer, group, branch, route, sales-type and channel prices; quantity breaks; variants; manual override with limits and reason; the trace; the simulator; versioning. |
| **P-2**                      | Discount rules (line and order), stacking pipeline, guards, coupons, usage limits and budgets, approval for activation.                                                                                                                                             |
| **P-3**                      | Product-mix promotions (BOGO, mix-and-match), bundles/kits/hampers with allocation, free items and gift with purchase.                                                                                                                                              |
| **P-4**                      | Retrospective: rebates, accruals, settlement credit memos, loyalty accrual, settlement discounts.                                                                                                                                                                   |
| **P-5**                      | Effective price index, analytics dashboards, price/margin governance, batch- and expiry-aware promotions (after WMS depth).                                                                                                                                         |

Each step ships with property tests, a load test of the price endpoint at twice the agreed peak, and a browser test of the builder and the order-line explanation.

---

## 11. Decisions needed

1. **Specificity order:** is the default `contract → customer → group → route → branch → sales type → channel → country → standard` right for your trade? Which would you move?
2. **Customers in several groups:** may a customer belong to more than one price group? If so, is the best price, the highest-priority group, or the first match used?
3. **Stacking default:** should promotions be exclusive by default (safest) with stacking opted in per promotion, or the reverse?
4. **Floor protection:** hard floor (never below cost or minimum margin) or soft (below needs approval)? Per product category?
5. **Tax-inclusive display:** do retail channels show tax-inclusive and B2B tax-exclusive?
6. **Loyalty and gift cards:** in scope now, or later?
7. **Rebates:** do you run retrospective rebates with distributors today? If yes, I will bring P-4 forward.

## Decisions taken (2026-10)

1. Default specificity order accepted as written.
2. A customer in several groups gets the highest-priority group.
3. Promotions are exclusive by default; stacking is opted into per promotion.
4. Floor protection is soft: selling below the floor needs approval, set per product category.
5. Retail and B2B both display tax-inclusive prices.
6. Loyalty cards and gift cards are in scope.
7. Rebates are brought forward (P-4).

---

## What P-1 delivers (built 2026-10)

Code: `src/server/domains/pricing/` (pure engine in `domain/`, `service.ts` reads, `config-service.ts` changes, `actions.ts` for the screens), screens under `/admin/pricing`, migration `0030_pricing_p1.sql`.

**Behaviour**

- Price lists with scope (customer, customer group, route, branch, sales type, channel, country; each "only these" or "all except"), kind (ordinary or contract), currency, tax basis, quantity mode (all units or step by step), priority, validity. Lifecycle: draft → in force → retired.
- Choice of the winning price exactly as §3.2: most specific, then priority, then newest start, then lowest id. Specificity is the sum of configurable weights; the defaults are powers of two in the agreed order (customer 64, group 32, route 16, branch 8, sales type 4, channel 2, country 1, contract +1000), so one higher kind of limit always beats any mix of lower ones. "All except" limits add nothing.
- A customer in several groups is priced by the highest-priority group (decision 2), then group code.
- Quantity breaks both ways. Tax basis is converted to the document line's basis. A price list in the sale's currency beats a conversion from the base currency. No price is never a zero: the line cannot be priced and says why.
- Every price comes with a trace (steps in plain language, every list considered and what happened to it). The trace is stored on the order line and the quote line (`price_trace`), so a past sale is explained from what was recorded, not recomputed.
- **Lines are effective-dated rows, not copied versions.** Changing a price closes the open row and adds a new one, so a list of millions of lines is changed without copying and history is kept. Header changes bump `version`; the trace records the version and the exact line. A price may start now or later, never in the past; a change made now replaces anything scheduled after it; a price that is already exactly as given is left alone (so a file can be sent twice). A locked (contract) price cannot be replaced without an explicit, logged override.
- Activation is refused for an empty list, one naming something that no longer exists, or one that would **tie** with a list already in force (same currency, equal specificity and priority, overlapping dates, a product in common). The same check runs when a live list's priority, scope or dates change and when a product is added to a live list.
- Every change takes a reason from the reason catalogue and writes to the decision log (subject `price_list`, `customer_group`, `price_weights`); a batch of prices is one entry with counts and a sample.
- Configuration is cached per process for 10 seconds and dropped at once when that process changes it, so another instance sees a change within 10 seconds. Pricing a basket is two queries however many lines it has.

**Where it is used**

- Staff sales orders, credit sales and POS cash sales are priced from the lists. A product in no list is sold at its standard price, so nothing changes until a list is put in force.
- ~~The web shop keeps the standard price~~ **Superseded (2026-10): the web shop is priced by the engine too**, see "One engine for sale, invoicing and display" below.
- Quotes: each line has a price mode: from the lists (default for added items), typed by hand, or kept as saved. Re-saving a quote does not reprice it; "Reprice" hands lines back to the lists. A quote turned into an order carries each line's explanation.
- Screens: price lists (create, scopes, quantity breaks, floor and lock, schedule, paste or upload a file, history per product, the list's own timeline), customer groups with members, **Price check** (the real engine on a sale you describe), price rules (weights), and the quote editor showing the price and "Why this price?" as the customer or quantity changes.

**Not yet done (still in the design above)**

- Variants and units of measure: the catalogue has neither, so lines are per product.
- Route: documents do not record a route yet, so route-limited lists only match in the Price check for now.
- Documents are priced in the base currency (as before); a price list in another currency applies to the Price check and to future documents that carry their own currency and rate.
- Floor price is flagged on the trace (`belowFloor`) but does not yet stop a sale; the per-category soft floor with approval, manual-override limits, and the approval workflow for putting a list in force (`price_list.publish`; the `approval_status` column is reserved for it) come next.
- The catalogue picker in the quote editor still shows (and requires) a standard price, so a product that has a list price but no standard price can be priced by the engine yet not picked there.
- P-2 (discounts, promotions, coupons, budgets), P-3, P-4, P-5 as phased above.

## Approval to put a list in force (built 2026-10)

- `PricingConfigService.requestActivation` is what the "Put in force" button calls. If no workflow on the `price_list.publish` trigger applies, the list goes live at once (same as `activate`). If one applies, the list is held (`approval_status = pending`), the requester's reason is logged as `pricing.activation_requested`, and nothing prices from it.
- `pricing/approval.ts` is the document handler: release activates the list in the approver's own transaction (logged as the requester's decision with their reason); reject sets `rejected`; reopen and withdraw return it to `none`. If the list can no longer go live at release (e.g. a tie appeared), the approval is not recorded and the approver sees why.
- A pending list cannot be edited, re-requested or activated around the approval. Changing its prices voids the approval (the snapshot is the open price count).
- Not covered: changes to a list already in force, floor and override limits.

## Approval of changes to a list in force (built 2026-10)

- Trigger `price_list.live_change` (document kind `price_list_change`). Facts for conditions: `changedLines`, `largestRisePercent`, `largestCutPercent`, `newProducts`, `removesPrices`, `headerChange`, `listKind`, `listCode`.
- `setLinesGated`, `removeLinesGated` and `updateListGated` are what the screens and import call. A draft list is never held, an identical price is not a change, and a new name or description is not held. Locks, ties and bad input are refused up front, before anything is held.
- A held change keeps its inputs (parked action). On release it is applied through the ordinary `setLines`/`removeLines`/`updateList` in the approver's transaction, as the requester and with their reason, and every check runs again against the list as it is then. A change that no longer fits (list retired, a tie, a lock) is not applied and the approver sees why. A start time that has passed while waiting becomes "now".
- Several changes can wait at once; each is applied against the prices as they are at approval, not as they were when asked.

## Price floors, override limits and sub-categories (built 2026-10)

- **Sub-categories:** `categories.parent_id` (max 5 levels, no loops, names unique across the tree since products and CSV imports refer to categories by name). Categories list as a tree with `path` and `depth`.
- **Floor:** cost x (1 + markup%), compared with the net-of-tax unit price after all discounts. Rules (`price_floor_rules`, one per scope): product > product group or brand (strictest wins) > category (nearest first) > company default. A price-list line's own `floorPrice` beats a rule. No cost on file means no floor, said so on the trace.
- **A breach needs approval, or is refused.** Orders (sales_order, credit_sale): facts `belowFloor`, `floorShortfallPercent` go to the `sales_order.submitted` workflow; if no workflow holds it the order is refused (as for credit limit). Quotes: facts `belowPriceFloor`, `floorShortfallPercent`, `overridePercent`, `overrideOverLimit`; with no matching workflow the quote waits for a `quotes:approve` holder, as for the margin floor. A rule set to "refuse" blocks the sale or quote outright. Till sales (pos_cash_sale) below a floor are refused, since a till cannot wait. The web shop is not checked.
- **Override limits** (`price_override_limits`, per role key, `*` = everyone else): how far below the list price a typed price or line discount may go. Most generous of a person's roles; super admin and "no limits configured" mean none. Only quotes have typed prices; orders do not.
- Every line's price trace carries a `guard` block (floor, source, shortfall, override, limit); approvers see the flagged lines in the inbox.
- Every change needs a reason and is written to the decision log. Screens: Price floors (with "Check a product"), Product groups, Override limits.


## What P-2 delivers: discounts, coupons, limits (built 2026-10)

- **Rules** (`discount_rules`, migration 0032): a line rule (percent, amount per unit, amount per line, set price) or an order rule (percent, amount), with quantity or order-value steps, a target (everything, categories with their sub-categories, brands, product groups, up to 200 named products), a scope (customer, group, branch, sales type, channel), conditions (minimum quantity or order value, payment methods, coupon required), a validity window with days of the week and a time window in the business time zone, and limits (uses, uses per customer, budget, a cap on the share of a line). Editing a rule adds a version; a rule that is pricing sales is never edited, it is paused first.
- **Order of work** (`domain/discounts.ts`, pure and property-tested): line rules per line; order rules on what the lines then come to; guards last. Among eligible rules, the best *exclusive* rule and the whole *stackable* set (each applied to what is left) are compared and the customer gets the larger, never both. Ties go to higher priority, then the lower code. Promotions do not reduce a contract-priced line unless the rule says so.
- **Guards:** a line never goes below its price floor (a rule's own floor, or the price list line's floor); the discount is cut back and the trace says so. A rule's share cap and budget are honoured; a budget is shared across the lines of one document.
- **Order rules** spread their discount over the lines they cover in proportion, so tax and returns stay right line by line. A line already at its floor passes its share to lines with room.
- **Coupons** (`discount_coupons`): typed or randomly generated (unambiguous alphabet, up to 1000 per call), each with its own validity and use limits (overall and per customer).
- **Use is a fact:** `discount_usage` is append-only (database trigger), one use and one reversal per document and rule; `discount_counters` is sharded 8 ways so orders at once do not queue on one row. A limit may be passed by a few uses in a burst; a rule marked *strict* is checked under a row lock and holds exactly (the order is refused if it lost the race).
- **Where it applies:** staff orders (`sales_order`, `credit_sale`, `pos_cash_sale`), with `couponCodes`, recorded on the order (`orders.discounts`, `price_trace.discounts`), counted in the order's own transaction, and given back when the order is cancelled or its reservation is released. Quotes: line rules set each catalog line's unit price; coupons and order rules become a per-line percentage (`sales_quote_lines.rule_discount_percent`) so the quote totals match what the order will be. A quote's discounts are counted when it becomes an order, not when it is saved, and are not repriced then. A typed price is measured for the override limit against what the customer would have paid with promotions, so a promotion is not an override.
- **Lifecycle:** draft, in force, paused, retired. Putting a rule in force can need approval (`discount_rule.publish`: kind, largest percentage, budget, has an end date, needs a coupon); the requester's reason is logged when it is released.
- **Screens:** Pricing > Discounts (rules, a plain-language sentence for each, "Try a sale" simulator that can try a draft as if it were in force), a form that checks as you type, coupon codes, recent use and history; the quote editor has a coupon field and shows what was applied.
- **Not done:** product-mix promotions, bundles and free items (P-3); rebates and loyalty (P-4); free shipping (orders have no shipping rates yet); discounts for the web shop checkout; the impact preview with projected margin; per-branch budgets.

## What P-3 delivers

- **Product-mix deals** (`discount_rules.mix`): buy-and-get (buy 2 get 1 free, same set or another set), mix-and-match (any 3 for a price), bundle deals (fixed price for slots). Whole units only; a unit earns at most one deal; best-for-the-customer first. Floors and rule budgets still trim.
- **Free gifts**: a rule with a trigger (order value and/or quantity of matching goods) adds zero-price `is_gift` lines. Gift stock is held, its value counts against the rule budget, cancelling gives both back.
- **Kits and hampers** (`product_kits`, `product_kit_components`): priced as one line, expanded at order creation into component lines with their share of the price (list price, cost or explicit weights), own tax rate, own stock. Same-product lines merge. Kits cannot nest; a component cannot be permanently deleted while in a kit. Kit price floor uses the sum of component cost.
- Screens: Pricing > Kits and hampers; discount form gains product deal and free gift kinds.
- Not in P-3: pre-assembled kit stock, choice slots, gift tax/deemed supply, free shipping.

## What P-4 delivers: rebates, loyalty points, gift cards (built 2026-10)

**Rebates** (`rebate_programs`, `rebate_accruals`, `rebate_balances`, `rebate_settlements`)
- A programme gives money back on a customer's purchases over a month, quarter or year, at a rate that steps up with the total. Tier mode `all_sales` (the step reached applies to everything) or `incremental` (each step only above its threshold). Scoped by customer, group or branch, and by product, category, brand or group.
- Each order adds its net value (tax left out) to the customer's running total in the same transaction that saves it. Cancelling takes it back; a credit note takes back its returned share, capped at what the order counted. Accruals are append-only, balances are their sum.
- A statement per period shows each customer's total, the rate reached, the rebate and how far the next step is. A finished period can be paid; paying goes through approval (`rebate.settle`), is re-checked when released (a changed total stops it), and posts a credit to the customer account, reducing open invoices oldest first.
- Programmes in force cannot be edited; the period length is fixed once purchases are counted.

**Loyalty points** (`loyalty_programs`, `loyalty_accounts`, `loyalty_ledger`)
- One programme per company: points per 100 spent, what a point is worth, minimum and maximum share of an order, expiry months, tiers that earn faster from lifetime points.
- Earned on the order's net value in the order's transaction; reversed on cancel; clawed back proportionally by credit notes; spent as a tender; staff can adjust with a reason; a daily job lapses expired points (spending counts against the oldest first).

**Gift cards** (`gift_cards`, `gift_card_ledger`)
- Issued in batches with unreadable-proof codes (no 0/O/1/I/L), optional expiry and customer. Spending is one atomic statement that cannot take a balance below zero, however many orders use a card at once. Can be blocked.

**Tenders** (`order_tenders`, `orders.tendered_amount`)
- Gift cards and points pay an order from the order screen. A tender is a payment, not a price change: the total, tax and invoice are unchanged, and `amountDue` (total less tendered) is what gateways are asked for and what reconciliation compares with. Paying in full marks the order paid and takes stock. Cancelling the order returns cards and points.

**Not in P-4**
- Settlement (early-payment) discounts: there is no cash application to attach them to.
- Posting gift card, loyalty or rebate liabilities to the financial journal: the accounting rules (AC-1..AC-8) are not approved, so only the customer sub-ledger is written.
- Rebates for cash customers (they have no account to credit) and rebates larger than what the customer owes.
- Growth rebates (need prior-period actuals), combining several programmes' steps, a customer-facing balance or card screen, web-shop checkout use of cards and points.
- A line's tax is not kept on the order, so a credit note's rebate and points effect uses the order's average net share.

## What P-5 delivers: insights, impact preview, price book (built 2026-10)

- **Cost kept with each sale** (`order_items.unit_cost`, migration 0035): what one unit cost when it was sold, for kit components and gifts too. Older orders have none; every margin figure says how much of the sales had a cost.
- **Insights** (Pricing > Insights, read-only, cached a minute, periods up to 366 days): orders, net sales (tax left out), gross margin and cost coverage, discounts given, daily table; what each promotion cost, the margin on the orders it touched and how much of its budget is gone; floor breaches and override-limit breaches on orders, and by seller on quotes; products that sold at different prices in different branches; what is owed to customers (rebates earned and not paid, loyalty points, gift cards, expired balances); and a list of things that look wrong, most serious first (priced below cost, list below cost, no cost, no price, discounts with no end or no cap, kits with a component that cannot be sold, rebate payments waiting, expired cards with a balance).
- **What a rule would have cost**: a discount's panel applies it to the last 90 days of real sales (line rules to the lines their target covers, order rules to the orders that reach the minimum, gifts at their cost) and shows the give-away, the yearly equivalent and the margin before and after. Product deals are not estimated (it depends on baskets). The same figures go to approvers as facts of `discount_rule.publish` (`projectedGiveaway`, `projectedYearly`, `marginAfterPercent`), so a workflow can say "above X needs a director".
- **Price book** (Pricing > Price book): what each product sells for, one unit, for a chosen customer, branch, channel and sale type, worked out live by the engine with line discounts, floor and margin, paged and exportable (up to 5,000 rows; spreadsheet formulas neutralised). Nothing is stored.
- **Not built**: a stored effective-price index (the engine already caches configuration and there is no measured load that needs one; a stored copy would need a fast path and invalidation that can go stale, so the live price book is the read model instead), and batch- and expiry-aware promotions (they need warehouse batches, which do not exist yet).


## One engine for sale, invoicing and display (built 2026-10)

**Standard price.** Every item has an optional `standard_price`: the price the engine starts from when no price list applies. Empty means "the selling price" (`effectiveStandardPrice` in `src/lib/standard-price.ts`), so an item priced the old way behaves exactly as before. Setting or changing it needs its own permission, `products:set_standard_price` (a form that sends the unchanged value back saves for anyone who may edit the item). It is what eTIMS is told as the item's default price, what the price book starts from, and the base in quotes, orders and the shop. New installs give the permission to the admin role; an existing role is given it in Admin → Roles (super admin always has it).

**One place builds the engine's input.** `priceItemFor(product, quantity)` in `src/server/domains/pricing/service.ts` turns a product and a quantity into what the engine prices (standard price in the item's own tax basis). Staff orders, POS, credit sales, quotes, the price book and the web shop all call it. Nothing else reads `products.price` to price a sale.

**The web shop goes through the engine.** `withShopPrices` (`catalog/shop-prices.ts`) puts the engine's price on every product the shop shows (listing, product page, related, cart), for the signed-in shopper's customer record and the `ecommerce` channel, at the quantity in the cart (else the least that can be bought). Checkout prices the order with the same engine, customer and channel, so what is shown is what is charged, including quantity breaks (the cart reprices a moment after a quantity changes). Consequences to know:

* A price list with no channel limit now also applies to the shop; limit it to a channel to keep it off the shop.
* **Only the signed-in customer's lists apply.** An email typed at checkout never unlocks another customer's prices (a visitor who types a customer's email gets the standard price; covered by a test).
* Discounts, coupons and floors still apply to the staff channels only: the shop's summary does not yet show them, and charging them would break "what you see is what you pay".
* The shop's price filter and price sort still use the stored selling price in the database, so with list prices in force they are approximate.

**Quantity limits.** Every item may have a **minimum** and a **maximum** quantity that can be bought at once, in its own unit (both empty by default; the database refuses zero, negative and minimum above maximum, and the form checks them against the unit's decimals). They are **strict everywhere**: the shop's cards, product page, steppers and cart (it starts at the minimum, will not go outside the range, raises or cuts a saved cart with a notice, and removes a line when the stock is below the minimum); orders on every channel, checked over the whole document so splitting a quantity across lines does not get round a limit (`basketQuantityProblems`); and quotes. The pure rules are in `src/lib/quantity-limits.ts`. Vendors' purchase documents are not limited: the limits are for what customers buy.
