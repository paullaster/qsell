# Pricing, Discounts and Promotions — Module Design

**Status:** DRAFT for approval. Nothing here is built yet. Part of the [Sales Order Platform blueprint](./sales-order-blueprint.md).
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
