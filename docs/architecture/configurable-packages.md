# Configurable packages (build-your-own bundles)

**Status:** DRAFT for approval. Nothing is built. Decisions of 2026-11-12 are in section 2.
**Owner:** Pricing (packages are defined beside kits) with the web shop builder, quotes, staff ordering and orders as users of it.
**Builds on:** [`kits-and-hampers.md`](kits-and-hampers.md) (the split of one price over parts, per-part tax and stock, the price floor), [`pricing-module.md`](pricing-module.md) (price lists with scopes and quantity breaks), [`stock-locations.md`](stock-locations.md) (what the shop may sell), [`web-shop-workflow.md`](web-shop-workflow.md).

---

## 1. The problem

A kit is a fixed list: the same parts every time. Many businesses sell something that is **one offer with choices inside it**:

> *Express lunch*: one fish (small, medium or large, from inventory), one starch (ugali by default, or brown ugali instead), one or two vegetables of the shopper's choice from what is available, and optional extras. Offered to individuals, to groups and to corporate clients, with different rules for each.

Four things in that example are not possible today:

1. **Choices.** A part is chosen by the shopper, not fixed by the shop.
2. **Parts nobody can buy alone.** Ugali and brown ugali are real stock (counted, costed, taxed) but must never appear in the catalogue, search or sitemap, and must not be addable to a basket on their own.
3. **A price that follows the choices.** Large fish costs more; brown ugali may cost more; extras add to the price.
4. **Different businesses, different policies.** Each deployment decides who may order, how far ahead, how many, how it is priced and what happens when something is short. Nothing about lunch (or food) may be hard-coded.

The aim: a shopper builds the package in a few taps with the price updating live; the order, stock, tax, invoice, returns and the kitchen's preparation sheet all come out right.

## 2. Decisions taken (2026-11-12)

| # | Question | Decision |
|---|---|---|
| 1 | How is a package priced? | **Configurable per package.** Default: **one base price plus a difference for each option** (a difference may be zero, higher or lower). The other choice: **each option priced on its own and summed**. |
| 2 | Individual, group, corporate | **Everything is a setting, chosen per package and per company**, because each deployment has its own policy (section 6). No audience, rule or limit is built in. |
| 3 | An option that is out of stock | **Hidden by default.** The setting offers the other ways (shown but unavailable; shown with a suggested substitute), chosen per package. |

## 3. Vocabulary

| Word | Meaning |
|---|---|
| **Package** | A product people buy ("Express lunch") that is made of choices. Like a kit it is a normal product with a name, picture and price; its own stock is never used. |
| **Slot** | One decision inside a package ("Fish", "Starch", "Vegetables", "Extras"). Has a least and a most number of picks. |
| **Option** | One thing a slot offers, pointing at an inventory product, with a quantity of it. |
| **Selection** | What one shopper picked for one serving. |
| **Package-only product** | An inventory product that only a package may sell (ugali, brown ugali). New flag, section 4. |
| **Serving** | One unit of the package ("one Express lunch"). A basket line is a selection and a number of servings. |

A kit stays as it is. A kit is a package with no choices, and both share the same splitting, tax, stock and floor code.

## 4. Package-only products

A new product flag, **Sold only inside packages**, beside the existing "sold to customers" and "show on web shop" flags.

When on, the product:

- is **not listed** in the shop, search, filters, related products, the sitemap or structured data, and its own address answers **404 to shoppers** (a person with the products permission still sees it in admin);
- **cannot be put in a basket on its own**: the server refuses it, whatever the browser sends;
- is not offered in quote and staff-order product pickers **unless** the picker is choosing an option of a package;
- keeps everything else of a product: stock, cost, tax rate, units, suppliers, purchase orders, counting, reports.

It is a third axis, not a replacement: *sold to customers* (can it be sold at all), *show on web shop* (is it listed), *sold only inside packages* (a package may use it, nobody else).

## 5. How a package is defined

Screen: **Pricing → Packages** (`/admin/pricing/packages`), a sibling of Kits and hampers, opening in the usual modal route. Permissions: `pricing:read` to see, `pricing:manage` to change. Every change needs a reason from the pricing reasons list and is written to the decision log (`pricing.package_created`, `pricing.package_changed`, `pricing.package_removed`), as for kits.

### 5.1 The package

| Setting | What it does | Default |
|---|---|---|
| Product | The product people buy. One package per product. | required |
| Pricing mode | *Base price plus differences* or *each option priced and summed* (section 7). | base plus differences |
| How the price is split over the parts | The three kit methods: by price, by cost, by shares you set. In *summed* mode each part simply takes its own price. | by price |
| In use | Off: the product sells as an ordinary product. | on |
| Rules of ordering | Section 6. | all off |
| Out-of-stock behaviour | Section 8. | hide |

### 5.2 Slots

| Setting | What it does | Default |
|---|---|---|
| Name and help text | Shown to the shopper ("Pick one fish"). | required |
| Least and most picks | `0..n`. Least 0 makes the slot optional; least 1 and most 1 is a single choice. A slot whose most is more than one lets the shopper pick several different options. | 1 and 1 |
| Allow the same option more than once | For "extra fish x2". The most picks then counts servings of options. | off |
| Included (not a choice) | A slot with one option and 1 to 1 picks is shown as "Included" and not asked. For fixed parts such as the plate and the cutlery. | off |
| Order on screen | | by entry |

### 5.3 Options

Two ways to fill a slot:

- **A list.** Chosen products, each with its settings below. For a small, curated slot (fish sizes, starch).
- **A category.** Every product of a chosen category that can be sold in packages and is in stock, so that a new vegetable appears by itself. Used for long or changing slots. The picker for a long list is the shared **LookupAutocomplete** (paged, searched on the server), never a `<select>` and never the whole list.

Each option in a list has:

| Setting | What it does |
|---|---|
| Product | An inventory product, normally package-only. Can also be an ordinary catalogue product. |
| Quantity | In the product's base unit (for example 0.25 for a quarter of the base unit). A fish in three sizes is three options (three products, or one product with three quantities), as the business keeps it. |
| Difference to the base price | Used in *base plus differences* mode. May be 0, positive or negative. |
| Own price | Used in *summed* mode: **the product's selling price** (default, and then the price engine, price lists and discounts apply to it as to any product) **or a fixed amount for this package**. |
| Default | Pre-selected when the shopper opens the package. At most the slot's most picks. |
| Image and short description | Shown on the option card. Falls back to the product's. |
| Largest number of this option per serving | When repeats are allowed. |

In a category slot the same two numbers (difference, own price) are set once for the slot and apply to every product in it, and can be overridden for named products.

### 5.4 Checks on the server (when saving)

At least one slot, at most **20**; each slot at most **50** options (a category slot is paged, not counted); least is not more than most; a required slot has at least one option; defaults fit inside the picks; no option is the package's own product or another package or a kit; the same product is not twice in one slot; quantities above zero and at most 3 decimals; every product exists, belongs to this company and can be sold; *summed* mode needs every option to have a price source. The package cannot be saved with an arrangement that has **no valid selection at all** (for example a required slot whose options are all switched off).

A **design check** also runs on save and in Pricing → Insights: the **cheapest valid selection** is priced against the cost of its parts, and a package that can be configured **below cost** is flagged (the price floor of the pricing module, applied to the worst case).

## 6. Who may order, and the rules of ordering (all settings)

Everything here is chosen per package. None of it is on unless the company turns it on.

| Setting | Meaning |
|---|---|
| **Where it is offered** | Any of the registered document types: web shop, quotes, staff orders, and later point of sale, sales orders, sales invoices, credit sales (section 10.7). |
| **Who may order** | Anyone, signed-in shoppers only, or named customer groups (the existing groups). A person outside the audience does not see it. |
| **Price for each audience** | Not a new mechanism: the package's base price is **the product's price through the normal price engine**, so a price list scoped to a customer group, channel, branch or sales type gives the individual, group and corporate price. A *different offer* for a different audience (other slots or options) is simply **another package**; there is no audience switch inside one package. |
| **Group and bulk pricing** | The price list's existing **quantity breaks** (12 servings or more cost less each). No new tier mechanism. |
| **Fewest and most servings per order** | For example a group package from 10 servings. |
| **Notice needed** | Hours or days ahead. |
| **Ordering opens and closes** | Days of the week and a daily cut-off time, in the company's time zone. |
| **Daily limit** | The most servings that can be promised for one day. Counted across orders; checked and taken inside the order's transaction. |
| **Needs a delivery or collection date** | Uses the delivery module's slots when on. |
| **Customer note** | A free-text note per serving ("no pepper"), with a length limit. Kept with the selection and shown on the preparation sheet. |
| **Quote first** | Shows *Request a quote* instead of *Add to cart* (corporate packages): the quote flow, credit terms and approvals already exist. |

A refusal always says what the rule is in plain words ("Orders for this lunch close at 10:00 the day before").

## 7. Pricing

The **price of one serving** is computed on the server from the selection and never trusted from the browser.

- **Base plus differences (default).** `serving price = the package product's price (normal price engine, for this customer, channel, quantity and date) + the sum of the chosen options' differences`. Predictable for a menu; one number to promote ("from KES 650").
- **Each option priced and summed.** `serving price = the sum of the chosen options' own prices x their quantities`. Each option's price comes through the price engine unless it has a fixed amount. The package product's own price is then only a "from" display and a floor.

Either way the **line** is `serving price x servings`, then everything downstream treats it as a kit line does:

1. Line, order and quote discounts apply to the line and are **shared over the parts**.
2. The line is split over the chosen parts by the package's method (the kit's `allocateKit`); in summed mode each part takes exactly its own price. Shares add up to the cent, the last part takes the rounding.
3. Each part is taxed at **its own product's rate**, on the line's price basis (the kit rule).
4. The **price floor** is checked on the *selection actually chosen* (the sum of the chosen parts' cost against the price), not only on the definition.
5. A negative difference can never take a serving below zero; the server refuses the selection.

Shown to the shopper: *from* price on the card, the running total for one serving and for the servings chosen, and the difference on each option card ("+ KES 80").

## 8. Stock and availability

- An option is **available** when its product can be sold, is not switched off or deleted, and the stock of the places that sell to this channel covers its quantity for **all servings in the basket** (not one at a time). Two lunches asking for the last portion of ugali is a shortage, found while the shopper builds, not at checkout.
- The shopper's own basket counts: a second configuration of the same package sees what the first already uses.
- **Out of stock behaviour, per package:**
  - **Hide (default):** the option is not shown. A slot left with no available option and a least of 1 makes the package **unavailable** ("Express lunch is not available right now") rather than letting the shopper reach a dead end. An optional slot with nothing left simply disappears.
  - **Show but unavailable:** greyed, with a reason ("Sold out today").
  - **Show with a suggested substitute:** greyed, with the nearest available option offered in one tap (the first available option of the same slot, in slot order).
- Availability is **read again on the server at checkout** and again when stock is held. A selection that became unavailable is refused with the plain reason and the shopper is sent back to the builder with their choices kept and the unavailable one marked.
- A service or a non-inventory part never limits availability, as for kits.

## 9. The shopper's experience (web shop)

- The package page is an ordinary product page (title, picture, `Product` data with a *from* price). Its server part loads at once; **availability and option stock stream in through `use()` inside `Suspense`**, so the page is never blocked.
- A **step-by-step builder** below the picture: one card group per slot with the rules in words ("Pick 1 or 2"), the pre-selected defaults, the difference on every card. Single choice slots are radio cards; multiple choice slots are checkbox cards with +/- where repeats are allowed; long slots use the paged autocomplete. Everything is keyboard operable, labelled, announces changes (`aria-live`), cards on a phone, targets of 40px or more, contrast AA.
- **One tap to add** when the defaults make a valid selection. The *Add to cart* button states why it is disabled ("Choose a vegetable").
- The basket line reads like a sentence ("Express lunch: medium fish, brown ugali, sukuma and cabbage") with an **Edit** action that reopens the builder with the choices kept. Two servings with the same selection are one line with quantity 2; different selections are different lines.
- **Order again**: a signed-in shopper's earlier selection of a package can be repeated in one tap (the server re-validates it against today's rules and stock).
- **Phase 2:** a **group link** where each person chooses their own lunch and the organiser pays once.

## 10. Orders, quotes and stock

### 10.1 The basket

A basket line carries `{ package, selection: [{ slot, option, count }], servings, note }` and nothing about price. The server rebuilds the selection in a canonical order, rejects anything that does not belong to the package, and gives it a **selection key** (a hash of the canonical selection and note). Equal keys merge into one line, so retries and double taps are idempotent.

### 10.2 Saving an order

1. The line is validated and **priced again** (section 7) from the database.
2. The line is expanded into **one line per chosen part**, using the kit expansion: its share of the price, its own tax, its own stock held, named "Fish (Express lunch)". Parts of the same product with the same tax, basis and gift flag still fold into one order line (the existing rule), so invoices, returns and credit notes work per product.
3. **A package instance is written** for each selection: the package, its version, the servings, the price, the note and the exact picks with the names, quantities and amounts at that moment. This is the truth for **what to prepare**, because the folded lines no longer say which fish went with which ugali.
4. Stock is checked and held per part, in the same transaction; a short part refuses the whole order and holds nothing.
5. The package's rules (notice, limits, daily limit, audience) are checked again in the same transaction.

The order timeline (section 11 of the project rules) records the refusal of a package with its time and reason like any other refusal.

### 10.3 Preparation sheet

A printable and on-screen list per day (and per delivery slot): each package instance with its servings, picks and note, and a **totals** view (12 fish medium, 20 brown ugali, ...). It is read from package instances, so it is correct even when the order lines were folded. Permission: orders read.

### 10.4 Quotes

A quote keeps the package as **one line with its selection**. Totals and margin use the chosen parts (kit cost and tax by part). On conversion to an order the **quote's selection and price stand**; the parts are expanded from the stored selection, not from today's definition. If a chosen option is **no longer available**, conversion stops with a plain message naming it and the staff member chooses a replacement (the quote's price may then change, and says so).

### 10.5 Returns, cancellations, edits

- A cancelled order gives each part's stock back. A return or credit note of one part credits that part's share (the kit rule).
- A package instance is **not edited** after the order is saved. Changing a choice is a cancellation and a new order, or a staff amendment through the existing amend-order flow, which rewrites the instance and the part lines in one transaction and records the stage event.

### 10.7 Every selling document, including those not yet built (decision 2026-11-12)

Packages must work in **every place something is sold**: the web shop, quotes, staff orders, **point of sale, sales orders, sales invoices and credit sales**, the last four of which are not built yet. So the package logic is never written inside one screen or one document:

- **One shared core.** Validation, canonical selection and key, pricing, availability, ordering rules and expansion into part lines are pure functions and one service in `domains/pricing` (`packages.ts`, `package-service.ts`). A selling document calls them; it does not copy them.
- **One shared builder.** The builder is a single client component with a small contract (package id, current selection, customer, channel, date, servings in; selection and price out), reused by the shop, the staff order, the quote and later the POS, sales order, sales invoice and credit sale screens. A POS styles it for touch; the rules are the same.
- **Instances are not tied to an order.** A package instance points at *any* selling document line through a document type (`order`, `quote`, `sales_order`, `sales_invoice`, `pos_sale`, `credit_sale`) and a line id, with no foreign key to one table. A new document type is added by registering it, with its own check that the line exists and is in this company, not by changing the package tables.
- **The channel is a setting, not code.** "Where it is offered" (section 6) lists the document types; a new one appears in that list when it is registered.
- **Credit sales** use the same pricing and expansion; the customer's credit terms, limits and approvals are the credit module's, applied to the line's price as to any line. **Sales invoices** carry the part lines exactly as an order does, and a credit note of one part credits that part's share.
- **Registration is a rule.** A document type is not finished until it can sell a package, validated by a shared test that runs the same package cases against every registered document type.

### 10.6 Changing a package after it has been sold

A package change bumps its `version` and applies to the **next** selection. Baskets already holding the older selection are re-validated when opened and at checkout; an option removed since then is shown as unavailable. Orders and instances keep what was sold.

## 11. Data

All tables carry `company_id`, and every query is company-scoped. Money is `numeric`, never a float.

| Table | Purpose |
|---|---|
| `product_packages` | One row per package product: pricing mode, allocation, out-of-stock mode, ordering rules, in use, `version`. Unique on `product_id`. |
| `package_slots` | Slot per package: name, help, `min_picks`, `max_picks`, allow repeats, included, source (`list` or `category`), category id, sort order. Check `min <= max`. |
| `package_options` | Option per slot (list slots, and named overrides in category slots): product, quantity, difference, own price source and amount, default, sort order. Key: slot + product. Check quantity above zero. |
| `package_audiences` | Customer groups a package is limited to; absence means everyone. |
| `package_instances` | One per saved selection on any selling document line: package, version, servings, serving price, note, `selection_key`, `document_type` and `line_id` (section 10.7). |
| `package_instance_picks` | The exact parts of an instance: slot name, product, product name, quantity, amount, tax rate, all copied (so a later rename cannot change history). |
| `products.sold_only_in_packages` | The flag of section 4. |

Indexes for every path that is read: package by product; slots by package; options by slot; options by product (to know where a product is used, which blocks its deletion and warns before a change that would leave a required slot empty); instances by order, by day for the preparation sheet, by package. The daily limit is counted from instances by delivery date with a partial index.

**Deletion and edits are protected.** A product used as an option cannot be deleted (the database restricts it), and the products screen says which packages use it and offers *switch off* instead. Changing a used product's base unit stays locked, as for kits. Removing a package deletes its slots and options but never its instances.

## 12. Security

- Every action checks its permission on the server (`pricing:read`, `pricing:manage`; ordering is open to the audience the package allows), and the company comes from the session.
- The browser sends **only ids and counts** (package, slot, option, count, servings, note). Prices, quantities, tax and the existence of an option are all decided on the server. An option that does not belong to that slot, a slot that does not belong to the package, a package-only product sent on its own, or a negative count is refused.
- Notes are plain text, length-limited, escaped everywhere they are shown (preparation sheet, email, print), never rendered as markup.
- Limits on slots, options, picks, servings and note length bound every loop. A category slot is paged with keyset cursors; no render or save grows with the catalogue.
- Package-only products are excluded in the **query**, not just hidden in the UI, so they cannot leak through the API, sitemap or search.

## 13. SEO and sharing

The package page follows the project's SEO rules: title led by the trading name, description from the package's own text, `Product` data with an `offers` *from* price (`AggregateOffer`, low price = cheapest valid selection) and nothing claimed that the page does not show. The share card shows the package picture, name and *from* price. Package-only products have no page, no sitemap entry and no structured data. Packages and their builder register in `src/config/seo/platform-modules.ts` in everyday words ("lunch packages", "build-your-own meal", "catering orders"), and appear on the public platform page.

## 14. Edge cases to be covered (each gets a test)

1. A required slot whose every option is out of stock: package unavailable, not a dead end.
2. Two servings of one selection, and two servings of different selections, sharing the last portion of a part.
3. A default that became unavailable: the builder pre-selects the next valid option, or asks.
4. A selection with an option from another slot, a removed option, a duplicate, a count above the slot's most, or below its least.
5. A negative difference that would take the serving price below zero.
6. Summed mode where an option's own price is 0 (a free side) and where every option is 0.
7. A discount on a package line shared over the parts, and a free-gift package.
8. Parts with different tax rates inside one package; a price basis that includes tax.
9. The same product chosen as a package part and also bought on its own in one order (folding).
10. A package edited while a basket or a quote holds an older selection (section 10.6, 10.4).
11. An option's product soft-deleted or switched off between quote and conversion.
12. Daily limit hit by two orders at the same moment (the transaction decides, one is refused with the reason).
13. Notice, cut-off and closed-day rules at the boundary minute, in the company's time zone, across a daylight change if the zone has one.
14. Audience: a signed-out shopper, a shopper outside the group, a staff order on behalf of a customer in the group.
15. A package-only product requested directly (page, API, basket, search, sitemap).
16. A selection key collision (different selections never merge) and the same selection in different orders of picks (always merge).
17. A return of one part of one serving; a cancellation giving stock back for every part.
18. The cheapest valid selection below cost is flagged on save and in Insights.
19. Phone width: builder usable at 390px with no horizontal scroll; a very long note.
20. A deployment whose business is not food (a "computer set" with a choice of RAM, storage and a monitor) works with no change: nothing food-specific exists.

## 15. Tests (the full pyramid, every slice)

- **Unit** (pure, in `domains/pricing/domain/packages.ts`): selection validation, canonical order and key, price in both modes, splitting, availability for a basket, ordering rules (notice, cut-off, limits) with the clock passed in, the design check for the cheapest selection.
- **Integration** (database built from migrations): definition checks and constraints, expansion into part lines with stock held, tax by part, the price floor on the chosen selection, daily limit under concurrency, quote conversion, returns of one part, package-only exclusion in queries, company scoping.
- **API / actions:** permissions, rejected tampering (foreign option, forged price, package-only product on its own), masked errors returned as data.
- **E2E (desktop and phone):** defining a package in admin; a shopper building it, seeing the live price, adding it, editing it in the basket, ordering; an out-of-stock option hidden; the group minimum refused; the preparation sheet; the package-only product absent from the shop and sitemap and 404 on its address; layout checks (`noHorizontalScroll`, `noInnerHorizontalScroll`, `noNativeSelect`).
- ESLint 10.12 and `tsc --noEmit` clean on what is touched.

## 16. Slices (each complete: schema, server, UI, tests, notes)

| Slice | What |
|---|---|
| **P-0** | The `sold only inside packages` flag: schema, product screen, exclusion from shop, search, sitemap, direct address, API and basket; tests. |
| **P-1** | Package definition: schema, rules and checks, the Packages screen (slots, list options, pricing mode, split method, out-of-stock mode, in use), decision log, the below-cost and unusable-option checks in Insights; pure domain code. The ordering rules, audience, "where it is offered", customer note and quote-first settings arrive with the slice that enforces them (P-3), so no setting is shown that does nothing. |
| **P-2** | Shop builder: package page, live price, availability streamed in, basket line with edit, server pricing and validation. *Built.* The basket is kept in the browser as choices only (not on the account yet); checkout stops while a package is in the basket until P-3 can order it. Not in this slice: the *from* price and `AggregateOffer` data on the page and in the share card (arrive with P-3 because they need the ordering rules), price lists and discounts on the package price (P-3, with the order). |
| **P-3** | Orders: expansion, stock, tax, floor, package instances, rules of ordering (notice, limits, audience, daily limit); returns and cancellation. *Built* for the web shop and any caller of the order service: a package line is priced, split as a kit of its own choices under a made-up id (so two lines of one package never meet), folded with other lines, and its selection saved in `package_instances`/`package_instance_picks` in the order's transaction after taking the package rows `FOR UPDATE` for the daily limit. The *from* price now feeds cards, structured data and share cards. Left for later: where-offered per channel and quote-first (P-4, with the document-type registry), notice counted to a slot's start time. |
| **P-4** | Quotes and staff ordering with the same builder; conversion rules; the document-type registry and the shared cross-document test (section 10.7). The POS, sales order, sales invoice and credit sale register themselves when they are built. *Built* for quotes: the builder is one component (`PackageBuilder`) wrapped for the shop and for the quote dialog; a quote line keeps its choices in the line's trace by slot name and part (so a changed package does not strand it), priced as base plus choices and taxed and costed by parts through the same kit machinery; a new quote field *Needed on* carries the date for the package rules at conversion; `domain/package-documents.ts` lists the document types and `package-documents.integration.test.ts` runs the same cases against each. Quote instances are not written to `package_instances` (the trace is the record until the order exists). There is no separate staff order screen; staff order through quotes. Quote-first and per-channel *where offered* remain open. |
| **P-5** | Preparation sheet and totals. *Built:* `/admin/orders/preparation` (orders read); `domain/preparation.ts` groups the saved selections by delivery slot and package and totals servings, portions and units; `PreparationService` reads instances joined to orders that still stand (two queries for a sheet, one for the coming days, 2,000-selection cap); print hides the admin menu and top bar for every admin screen. Customer notes join the sheet with P-6. |
| **P-6** | Category slots, customer note, order again, substitute suggestion. |
| **P-7** | Group link (each person chooses; one payer). |
| **Docs** | Implementor guide updated in every slice (the 8-part anatomy), including the sales talk track and the ROI case; the SEO module registry. |

## 17. Not in scope for the first build

Recipes that consume raw ingredients in fractions across several finished products (the part is the thing counted; a bill of materials for production is a separate module); nutrition and allergen databases (a note field and the product description carry this for now); pre-made package stock; per-customer option prices beyond what price lists give; dependencies between slots ("large fish needs a large plate").
