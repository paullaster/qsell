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

## Not done yet

- Stock, reservations and order/quote quantities are still whole numbers, so a unit's `decimals` are recorded and validated but a product cannot yet hold 2.5 kg in stock. Making quantities decimal across inventory, quotes, orders and the ledger is its own change.
- Quote, order and invoice lines do not carry a unit yet (they use the product's base unit); the eTIMS item panel does not prefill from the unit's eTIMS code; the CSV import has no unit column; units have no per-language names.
- Role grants are written when a role is first created, so existing roles other than super admin need `units:read` / `units:manage` added in the roles screen.
