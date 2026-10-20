# Units of measure

One list of units, managed in **Products → Units of Measure** (`/admin/settings/units`) and shared by the whole system. Permissions: `units:read`, `units:manage`.

## Model (migration 0064)

- `units_of_measure`: code (unique), name (unique, case-insensitive), symbol, `kind` (count, mass, volume, length, area, time, packaging), `base_unit_id` + `factor_to_base` (1 g = 0.001 kg), `decimals` (0..6), UN/ECE code, KRA eTIMS code, one default, active flag, `version` (optimistic save). Like the rest of the catalog it is not per company.
- Units of one kind convert through their base unit (one level only: a multiple points at the family's base). **Packaging** units (box, crate) have no family: what they hold is set per product.
- `product_units`: a product's alternate units ("1 CRATE = 20 KG"), with shipping weight and default-for-selling / default-for-buying (one each per product). Saved in the same transaction as the product.
- `products.base_unit_id` (NOT NULL, restrict key): the unit stock is counted in. Rows written without one take `default_unit_id()`.
- The migration seeds about 30 standard units (PCS is the default).

## Rules (`src/server/domains/units/write-service.ts`; pure checks in `src/lib/unit-rules.ts`)

- A unit in use (a product's base unit, a product's alternate unit, or the base of another unit) cannot be deleted; the message says where it is used. Switch it off instead. Restrict keys back this up in the database.
- A unit in use keeps its meaning: kind, base unit and factor are locked; decimals can grow but not shrink.
- The default unit cannot be deleted or switched off; make another unit the default first.
- A product's base unit can change only while it has no stock and no history (movements, quote lines, price lists, kits); alternate units must then be re-entered for the new unit.
- A unit that is switched off is no longer offered and cannot be chosen for a new product or packaging.

## Using it elsewhere

- Pick a unit with `ChoicePicker` / `LookupAutocomplete`, source `units-of-measure` (filters `kind`, `exclude`, `bases=1`). Quick create and "view all" are `/admin/settings/units/new` and `/admin/settings/units/browse` (intercepted in `@create`).
- Convert with `convertQuantity` and `toBaseQuantity` in `src/lib/unit-rules.ts` (exact decimals in `src/lib/decimal.ts`, never floating point).

## Quantities and documents (migrations 0065, 0067, 0068)

- Stock, reservations, order lines, credit note and return lines, kits and the stock ledger hold up to **three decimals** (`numeric(14,3)`, `quantity()` in `schema.ts`). A product accepts only as many decimals as its base unit allows (pieces: none, kilograms: three). Add quantities in code with `roundQty` (`src/lib/decimal.ts`), never with bare `+`.
- A quote or order line is stored in the product's **base unit** (`quantity`); when it was typed in another unit of the product (3 crates) the line also keeps the unit, the quantity as typed, the conversion and the price per that unit. Money is worked out from what was typed, so 1000 per crate of 12 stays 1000.
- **Credit notes and returns** keep the unit the goods were sold in (`unit_id`, `unit_code`, `qty_per_unit`, `entered_quantity`). The unit and conversion are those on the order line (a document never depends on the product's live units), so a unit the product has since dropped can still be credited. Credit is tracked per product in base units; two lines of one product (kg and crate) are one line to credit, in base units. A credit can be asked for in the unit sold or in the base unit only (`src/lib/credit-units.ts`); goods coming back are confirmed the same way.
- **Storefront cart**: pieces step by 1; goods with decimals step by half a unit and the quantity can be typed (`src/lib/cart-quantity.ts`, `QuantityStepper`). Quantity is cut to the unit's decimals and to what is in stock, with a message.
- **Mix promotions** count whole units. A part unit (the 0.5 of 2.5 kg) is priced normally and the deal's explanation says so; free-gift triggers count the exact quantity.
- **A saved quote whose product has dropped a unit** opens in the base unit at the same total, with a notice per line (`src/lib/quote-unit-repair.ts`); a unit whose size changed is pointed out and re-worked when saved. Revising such a quote does the same.
- **Stock value in the books** is carried so a product's postings always add up to units x cost to the cent: each change is written as the difference between the rounded running totals kept in `finance_inventory_totals` (migration 0069, database triggers). Rounding left by changes written before this migration is not rewritten; it shows in the reconciliation and does not grow.

## Using it elsewhere

- Pick a unit with `ChoicePicker` / `LookupAutocomplete`, source `units-of-measure` (filters `kind`, `exclude`, `bases=1`) or, for a line of a product, `product-units`. Quick create and "view all" are `/admin/settings/units/new` and `/admin/settings/units/browse` (intercepted in `@create`).
- Convert with `convertQuantity` and `toBaseQuantity` in `src/lib/unit-rules.ts` (exact decimals in `src/lib/decimal.ts`, never floating point). For document lines use `unitWriter.convertLines`; for goods coming back or being credited use `src/lib/credit-units.ts`.

## Not done yet

- Units have no per-language names.
- A unit that a credit note or return line uses cannot be deleted (counted as "document lines"); there is no way to merge two units.
- Role grants are written when a role is first created (migration 0066 granted them to roles that had product permissions); roles made later need `units:read` / `units:manage` added in the roles screen.
