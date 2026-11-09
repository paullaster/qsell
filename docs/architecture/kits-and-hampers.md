# Kits and hampers

**Screen:** Pricing → Kits and hampers (`/admin/pricing/kits`). **Owner:** Pricing, which uses kits but does not own the products (those stay in Products & Inventory).
**Code:** `domains/pricing/domain/kits.ts` (the rules, pure), `domains/pricing/kit-service.ts` (reading kits for a sale, and the admin changes), `domains/pricing/kit-actions.ts` (the server actions), `components/admin/pricing/KitsClient.tsx` (the screen). Tables: `product_kits`, `product_kit_components`.
**Tests:** `domain/kits.test.ts` (the split, tax and the checks), `mix-kits.integration.test.ts` (setting up, selling, quotes, the price floor).

How to read this page: sections 1 to 8 say how it works. Section 9 lists every edge case found while reading the code, each marked **tested**, **read in the code** (no test), or **found by running it**. Section 10 says what is not built.

---

## 1. What a kit is

A kit is **one product that is really several**, such as a gift hamper of wine, bread and cheese. People buy, see, price and discount it as **one line**. The moment a sale is saved, that one line is replaced by **one line per component**, and each component line carries:

- its **share of the kit's price** (the shares add up to the price exactly, to the cent),
- its **own tax rate**,
- its **own stock**, which is what leaves the shelf and what is held while the order waits.

That is the point of a kit: stock leaves per component, each component is taxed correctly even when the tax differs inside one hamper, and a return of one item credits that item's share.

The product that stands for the kit (the "hamper" product) is a normal product with a name, picture and price. **Its own stock is never used when it sells as a kit.** The components' stock is.

## 2. Who can do what

| Action | Permission |
|---|---|
| See the list of kits, and try a price split | `pricing:read` |
| Make, change, switch off or remove a kit | `pricing:manage` |

Every change needs a **reason** picked from the pricing reasons list, and is written to the decision log (`pricing.kit_created`, `pricing.kit_changed`, `pricing.kit_removed`) with who, why, and what changed. Without a reason nothing is saved. The screen is a server page that starts the list and the permission together and draws at once.

## 3. Making a kit (the screen, step by step)

1. **New kit.** Pick the product people will buy. It must exist and not be deleted. While editing a kit the product cannot be changed.
2. **What is in it.** Pick each component product and give **Units in one kit** (a whole number on the screen, see edge case 9.7). Picking a component that is already in the list does nothing (no message).
3. **How the kit price is split** between the components (section 4).
4. **Try a kit price** (optional). Type a price (it starts as the kit product's current price) and the screen shows, after a short pause, how it would split, with each part's quantity and tax rate.
5. **In use.** When off, the product sells as an ordinary product again (with its own stock and no splitting).
6. **Reason**, then **Save kit**. The message says "It applies to the next sale."

Saving is one database transaction. For an existing kit the components are **deleted and written again** and the kit's `version` goes up by one; this is how a change is made. A kit that is removed (Remove, with a reason) is **deleted for good**, its components with it (the decision log keeps the record); the product is ordinary again. Orders already made keep their component lines.

The list shows, for each kit: its product, SKU, "Not in use" if off, what it sells for (or "No selling price yet"), what the components would cost if sold separately, **how many can be made from stock** right now, and each component with its stock.

**The price of the kit** is not set here. It is the kit product's price, as for any product: its standard price, or a price list line. The kit has no price of its own.

### The rules a kit must satisfy (checked on the server, `checkKit`)

- At least one component, at most **50**.
- A kit **cannot contain itself**, **another kit**, or the **same product twice** (add its units to one row).
- Each quantity above zero, at most 3 decimals.
- With "shares you set", every component needs a share above zero.
- A product that is **already a component** of a kit cannot itself become a kit.
- Every component must still exist (not deleted).
- A component may be in **several** kits (the table's key is kit + product, not product alone).

## 4. How the price is split

Three methods, chosen per kit:

| Method | Each component takes a share of the kit price in proportion to… |
|---|---|
| **In proportion to the components' prices** (default) | its selling price × its units in one kit |
| **In proportion to the components' cost** | its cost × its units |
| **In shares you set** | the number you give it |

How it is worked out (`allocateKit`):

- The shares come from the **current** price or cost of each component at the moment of the sale, not from when the kit was made.
- The amounts are rounded to the cent. **The last component with a share takes the cent that rounding leaves over**, so the parts always add up to exactly what the kit line came to.
- If the chosen basis is unusable (every component's price is zero, or every cost is zero), the split **falls back to units**, so no component is ever left out of the sale.
- A component with a zero share (price zero under the price method, cost zero under the cost method) gets an amount of **0** but its stock still leaves.
- A kit sold at 0 (a free kit, or a free gift) makes component lines at 0.
- Units for the sale are the component's units times the number of kits sold.

Example: a hamper sold at 800 with wine (300) and bread (100), by price: wine gets 600 and bread gets 200.

## 5. Tax

- Each component line is taxed at **its own product's tax rate**, so a hamper with 16% wine and 0% bread produces the right VAT on each part.
- The amount of each part is kept **in the kit line's own basis**: if the kit price includes tax, so does each part; if it excludes tax, each part is increased by its own rate. **The component's own "price includes tax" setting is ignored** for this; the kit line's setting decides (section 9.9).
- `splitTax` works out the net and the tax of a part; `kitTax` sums that over all the parts. A quote uses `kitTax`; an order uses the expanded lines.

## 6. What happens when a kit is sold

### 6.1 At checkout and on staff orders (`OrderWriteService.createOrder`)

1. The lines are priced as usual (price list, discounts, free gifts). The kit line is priced as the **one product** it is.
2. `expandKits` replaces each kit line with its component lines. A component that is also on the order as a line of its own, **with the same tax, same basis and same gift flag, is folded into one line**, because returns and invoices work product by product.
3. Each component line is named **"Component (Kit name)"**, carries the kit's picture if it has none of its own, and keeps a **price trace** saying it is part of the kit, how many kits were sold, and what they came to.
4. If any component has been deleted or switched off, the sale is **refused** with "*Hamper* cannot be sold: its component *Wine* is no longer available."
5. Stock is then checked and held **per component**. A component that is short refuses the whole order and nothing stays held. Components that are services or not inventory-managed are not held.
6. Weight for delivery, delivery charges and KRA lines all work from the **component lines**.

An order that is cancelled gives each component's stock back as for any order. A return or credit note works on a component line and credits that line's share.

### 6.2 In quotes

- A quote keeps the kit as **one line** (the quote shows "Hamper", not its parts).
- The quote's tax and cost are worked out **by component** (`kitTax`, `kitCost`), so the quote's totals and margin are right.
- The quote screen is given each kit's definition so the figures on screen match (`editorKits`).
- When the quote becomes an order (accepted, then converted), the order is created from the quote's lines, the kit is **expanded at that moment using the kit as it is then**, and the **quote's totals stand** ("the quote's price stands"). See edge cases 9.3 and 9.4.

### 6.3 In the shop's basket

The basket preview expands kits only to find **which stock** to check and what the parcel weighs. Edge cases 9.1 and 9.2 (shop stock display and preview tax) were fixed and now follow components.

### 6.4 The price floor

A kit is priced against a floor made from its components: the guard uses **the sum of the components' cost × units**, active kits only. A kit sold below that is treated as selling below cost (tested).

### 6.5 Discounts and gifts

- A discount on the kit line (a line, order or quote discount) is **shared across the components**, because the split starts from what the kit line came to after discount (tested).
- A kit that is a **free gift** produces component lines that are also marked as gifts (read in the code).
- A mix deal or gift rule treats the kit as the one product it is.

### 6.6 Insights

Pricing → Insights flags a **kit with a component that cannot be sold** (`kit_component_off`: switched off or deleted), because an order for that kit is refused until it is fixed. This is the only place that warns about it before a customer hits it (see 9.5).

## 7. Changing, switching off and removing

| What | Effect |
|---|---|
| Change a kit (components, split, in use) | Applies to the **next sale**. Orders already made keep their lines. Quotes already made keep the one kit line and use the **new** definition when converted (9.3). |
| Switch off ("In use" off) | The product sells as an **ordinary product**, with its **own stock** and price. The kit stays on the list as "Not in use" and its components stay locked into it (they still cannot become kits). |
| Remove | The definition is deleted. The product is ordinary again. The decision log keeps who removed it and why. |
| Delete a **component** for good | **Blocked**: the database refuses (`restrict`), and the bulk delete preview says "it is a component of a kit". It can still be **soft-deleted** (moved to trash) or switched off, which makes the kit unsellable until fixed (9.5). |
| Change a component's **base unit** | **Locked** once it is used in a kit (like for any used product), so "units in one kit" keeps its meaning. |
| Delete the **kit product** | The kit definition goes with it (cascade). See 9.12. |

A change to the kit takes effect after the kit cache clears: kits are read once per company and kept for **10 seconds**; the saving server clears it at once (9.10).

## 8. Data

`product_kits`: `id`, `company_id`, `product_id` (unique: one kit per product), `allocation` (`list_price` | `cost` | `explicit`), `is_active`, `version`, `created_by`, `created_at`, `updated_at`.

`product_kit_components`: `kit_id`, `product_id` (restricted: cannot be erased while listed), `quantity` (above zero), `weight` (for the shares you set), `sort_order`. Primary key `(kit_id, product_id)`.

An order keeps no link to the kit except in the **text of the component line's name** and the **price trace's `kit` field** (kit product id, name, quantity sold, total). Nothing else in `order_items` says a line came from a kit.

---

## 9. Edge cases

Marked **[tested]**, **[code]** (read in the code, no test) or **[ran]** (run with the real functions today).

### Things that can mislead or go wrong

**9.1 [fixed, tested] The shop used to ignore the components' stock for a kit.** *Fixed: `withShopAvailability` now shows a kit as "how many can be made" from its parts (scarcest part, after what is promised to others; parts in ledger mode are counted at the web-shop locations), and the kit counts as stock-managed, so "Sold out" and the cart limit follow the parts. If no part is stock-counted the kit is unlimited. Checkout still checks each part. What follows is the old behaviour, kept for the record.* The cart and the shop's "sold out" use `availableOf(product)`, which is the **kit product's own stock** (`stockQuantity - reservedQuantity`) when the product is inventory-managed. The kit product's own stock is meant to be unused, so a kit product with stock 0 shows as **Sold out and cannot be added to the cart at all**, however many hampers the components could make. If the kit product is instead set as **not inventory-managed**, availability becomes unlimited and nothing in the shop warns; the sale is then refused at checkout if a component is short. Either way the shop never shows "N available" from the components. *The only place the buildable count is shown is the kits screen.* To sell a kit online today, the kit product has to be set as not inventory-managed, and the shop will not say when a component runs out.

**9.2 [fixed, tested] The basket preview used to tax a kit as the kit product, the order taxes it by component.** *Fixed in two places: the basket preview (used for delivery rules) now taxes the expanded lines, and the shop shows a kit at the one tax rate its parts come to, so the total on the cart and checkout screens equals the order's (tested for tax-inclusive and tax-exclusive prices). What follows is the old behaviour.* The preview (`basket-preview.ts`) expands kits for stock but computes the **totals from the unexpanded kit line at the kit product's tax rate**; the order uses the component lines. Run with a 1,000 hamper of two equal parts, wine at 16% and bread at 0%, with the kit product at 16%:

| Prices | Preview shows | Order is made at |
|---|---|---|
| include tax | VAT 138, total 1,000 | VAT 69, total 1,000 |
| exclude tax | VAT 160, total **1,160** | VAT 80, total **1,080** |

With tax-inclusive prices only the VAT figure differs. With tax-exclusive prices the **shopper is shown 80 more than the order is made at**. It only happens when the kit product's tax rate differs from the components' mix.

**9.3 [fixed, tested] A quote is converted using the kit as it is then, not as it was when quoted.** *Now checked: if the parts no longer add up to the quoted subtotal and tax (within 5 cents) the conversion is refused with "A kit in this quote has changed...", and nothing is booked or held. A change that keeps the totals (same tax mix) still converts, with the new parts.*  The quote holds one kit line and its totals; the order expands the kit at conversion. If the kit's components, split or tax changed (or the kit was switched off or removed) between the quote and the conversion, the order's component lines come from the new definition, while the order's totals are the quote's ("the quote's price stands"). Nothing checks that the component lines add up to the quote's totals.

**9.4 [fixed, tested] A kit switched off or removed after it was quoted used to be sold as an ordinary product on conversion.** *Now a quote line of a kit carries a marker in its price trace (`quotedAsKit`, no schema change: the trace is stored JSON, and the marker is renewed on every save). Converting a quote refuses, naming the product, if a marked line is no longer an active kit: "X was a kit when this quote was made and is not one now. Please make the quote again." Nothing is claimed or held. Quotes saved before this fix carry no marker and convert as before.*

**9.5 [fixed, tested] A component that is switched off or soft-deleted broke the kit silently.** *Now: the kits screen shows a red flag on that component and "can be made" is 0; the shop shows the kit as sold out; the basket preview says "<Kit> cannot be sold right now. Please take it out of your basket."; Pricing Insights still warns.*  The sale is refused. At checkout the customer is told only "Something in your basket cannot be sold right now" (the basket preview hides the reason), and the kits screen still lists the kit and counts the component in "can be made". The warning exists only in Pricing → Insights.

**9.6 [partly fixed] "Can be made from stock" is one global number.** *The shop count now uses the web-shop locations in ledger mode. The kits screen is labelled "from the stock of all locations" and stays global, because it is an administrator's overview.*  It is the smallest of each component's `stock - reserved` divided by its units, from the product's total. With stock held in **several locations**, the kit may not be buildable from any one place; the number can overstate. It can also show a component's stock as negative.

**9.7 [fixed] The screen only took whole units in a kit.** *Now accepts up to 3 decimals (0.5 kg), as the server rules do.*  The units field has `min=1` and the default step, so 0.5 kg of a component sold by weight cannot be entered, while the server and the database would accept it. A hamper with half a kilo of something has to be set up some other way.

**9.8 [fixed, tested] Folded lines kept only the first name.** *Now a part folded from more than one source is named as the product ("Plain wine"), and its trace notes the extra quantity.*  When a component is also on the order alone (or in a second kit), its quantity and amount are added to one line, but the line keeps the **first** source's name and price trace. A component folded in from a second kit is not named on the line.

**9.9 [by design] The component's own "price includes tax" is ignored.** *The parts take the kit line's basis so the total the customer pays never changes; the component's rate is still used.*  The parts take the kit line's basis. A component set as tax-exclusive in a tax-inclusive kit is treated as inclusive.

**9.10 [fixed] Kit changes took up to 10 seconds to show on other servers.** *Orders now read kits fresh from the database; only displays use the 10-second cache.*  Each server keeps kits for 10 seconds and only the one that saved clears its cache at once. With several app instances, a sale on another instance can use the old kit for up to 10 seconds. A one-process deployment is not affected.

**9.11 [by design] Rounding can leave quantity × unit price a few cents from the line total.** *The line total is exact and is what is charged and signed; the unit price is rounded to the cent for display.*  Each part's unit price is its amount divided by its units, rounded to the cent; the line total is the exact share and is what counts. An invoice that prints quantity × unit price can differ from the line total by a cent or so on a part with several units.

**9.12 [by design] A sold kit leaves no order line for the kit product.** *Component lines are what stock, tax, returns and KRA work from. The kit's definition is protected by its own checks.*  The orders keep component lines, so the bulk-delete check "it was sold" (which looks at order lines) does not see kit sales. Whether the kit product can then be erased for good depends on its other uses (price list lines, quote lines, stock movements). If it is erased, the kit definition goes with it (cascade); the order lines keep their component names.

**9.13 [by design] The customer sees the components, with prorated prices.** *This is what allows partial returns and per-part tax. The kit's name is in each line's name, "Wine (Hamper)".*  An invoice, receipt or order confirmation lists "Wine (Hamper)", "Bread (Hamper)" with the shares of the kit price, not "Hamper" at the price they were quoted. The shares are not the components' selling prices.

**9.14 [by design] Each component must be a registered KRA item.** *The law taxes the parts; the kit product is never sent.*  The KRA invoice is built from the order lines, which are the components. The kit product itself is never sent. A component that is not registered with eTIMS blocks signing, as for any product.

**9.15 [by design] Limits on the kit product apply to the kit, not to the components.** *A component's own minimum or maximum order quantity is for it sold alone; applying it to a kit sale would refuse hampers for a reason the shopper cannot see.*  I found no code that applies a component's own limits to the parts.

**9.16 [fixed] Two quick screen behaviours.** *Adding a component already listed now says so. "Try a kit price" still shows nothing until the kit product has a price or one is typed; that is left as it is.*  adding a component that is already listed does nothing and says nothing; "Try a kit price" shows nothing until the kit product has a price or you type one.

### Behaviour that is intended and tested

- **[tested]** Making a kit shows what it is worth and how many can be made, and logs it.
- **[tested]** Refused: nesting, itself, repeats, a missing product, an empty kit, and a missing reason.
- **[tested]** A component of a kit cannot be erased for good.
- **[tested]** A sale becomes a line per component with its share, its own tax and stock held per component.
- **[tested]** A component out of stock refuses the order and nothing stays held.
- **[tested]** A component switched off refuses the sale and names it.
- **[tested]** A discount on the kit is shared across the components.
- **[tested]** A component that is also bought alone folds into one line.
- **[tested]** A kit is priced against a floor made from its components' cost.
- **[tested]** In a quote, a kit line is taxed by component and costs what its components cost.
- **[tested]** An order made from a quote with a kit and a gift gets component and gift lines and counts the gift's use.
- **[tested]** The split always adds up exactly, whatever the numbers; falls back to units when the basis is all zero; a free kit has free components.

### Not covered by any test I found

A **return or credit note of one component** of a kit (the design relies on it; see 6.1), the **basket preview of a kit**, the **shop's display** of a kit beyond the stock count (9.1), a **kit as a free gift**, **several kits in one order sharing a component**, and **switching a kit off** between a quote and its conversion.

## 10. Not built

These are in the design (`pricing-module.md` §4.3) and are **not** in the code:

- Pre-assembled kit stock (a kit held as its own stock, with components consumed on assembly).
- Choice slots, optional components, substitutions when a component is out of stock.
- "The hamper is only offered if all required components are available" in the shop, or showing the shortfall (this is edge case 9.1).
- Sell prices frozen on the kit when it is made (the split uses current component prices).
- Tax or deemed-supply treatment of a free gift kit.
- Free shipping rules on a kit.
