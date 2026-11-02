# Business Central Item Classification, Lifecycle, and Posting (BC 26+)

## Classification, creation, and lifecycle controls

### Takeaway
Business Central's Item Type is an operational capability boundary, not merely a merchandising label. Inventory supports quantity/value stewardship; Non-Inventory and Service can participate in selected commercial and consumption workflows but do not maintain inventory quantities/values. Keep regular items distinct from catalog items and service-management service items.

### Cited Findings
- Microsoft defines three Item Card types: Inventory (physical or identifiable nonphysical goods, fully trackable), Non-Inventory (typically physical low-value/internal-use goods without full tracking), and Service (labor time unit). Service and Non-Inventory cannot track inventory quantities or values. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- Supported feature matrix: Inventory supports sales/purchasing, consumption, input/output, transfer, counting, revaluation, costing, tracking, reservations, warehousing, and planning. Non-Inventory supports sales/purchasing, job/service/assembly/production consumption and order planning, but no output, transfer, physical count, revaluation, costing, item tracking, reservation, warehousing, or normal planning. Service supports sales/purchasing, job/service consumption and order planning, but not assembly/production consumption or inventory capabilities. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- New Items are created from Item Card templates; templates populate fields and dimensions for consistency. Copying an existing item is also supported. [Create item cards for goods or services](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-register-new-items)
- Item cards with posted transactions cannot be deleted through normal user workflow because ledger entries may be needed for valuation or audit. [Create item cards for goods or services](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-register-new-items)
- Catalog items are a separate prospect/offer state: they are not managed as regular items until selected on sales quote/order/blanket order, at which point BC creates a regular item from catalog data and template. Catalog item selection is not available on Sales Invoice. [Create and manage catalog items](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-work-nonstock-items)
- When catalog conversion is triggered from a sales line, deleting the line can delete the automatically created item, except when it has been used in sales/purchase lines, BOMs, or has ledger entries. [Create and manage catalog items](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-work-nonstock-items)
- “Service item” in Service Management is a customer-owned object being serviced; it is distinct from a regular item whose Item Type is Service. Service components can themselves be regular items. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types); [Set up service items and service item components](https://learn.microsoft.com/en-us/dynamics365/business-central/service-how-setup-service-items)

### Inferences
- Model classification as a constrained business capability set (stock ledger participation, costing, tracking, reservations, fulfillment, consumption), not just a free-form label. Reject unsupported operations server-side, including API/import paths.
- Protect item identity and historical references once transactions exist. Prefer retire/block or replacement/supersession workflows over deletion or silent identity changes.
- A product offering can have a pre-master/catalog lifecycle state, but do not equate that state with Non-Inventory: catalog conversion creates a normal item master and may carry vendor-number references.

### Gaps
- Microsoft Learn does not document a supported general-purpose conversion of an already-used regular item from one Type to another. The catalog-to-normal-item process is not evidence of Inventory↔Non-Inventory↔Service conversion support.
- Exact ability to edit Type after postings, including extension/customization-specific behavior, is not established by the cited end-user docs. Treat as version- and state-dependent; confirm in a BC 26 sandbox before implementing a migration path.

## Commercial document use, receipts, shipments, and invoicing

### Takeaway
Item types share sales and purchase document surfaces, but posting is a staged business event: an order may be received/shipped and invoiced together or separately, with partial quantities. Document use does not mean every type creates stock ledger effects.

### Cited Findings
- Sales order lines accept inventory items and services; Service/Resource quantities represent time units as indicated by the line UOM. [Create a customer sales order and sell products](https://learn.microsoft.com/en-us/dynamics365/business-central/sales-how-sell-products)
- Sales orders support partial shipment and invoicing. Posting can create shipment and invoice together or separately; an order invoice requires a recorded shipment unless ship-and-invoice together. A sales invoice can be used when invoicing without registering shipment. [Create a customer sales order and sell products](https://learn.microsoft.com/en-us/dynamics365/business-central/sales-how-sell-products)
- The type matrix explicitly supports sales and purchasing for all three item types. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- Sales posting creates related item and customer ledger entries; the exact ledger impact varies with type, and noninventory/service costs are recorded separately from inventory cost. [Create a customer sales order and sell products](https://learn.microsoft.com/en-us/dynamics365/business-central/sales-how-sell-products); [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- Catalog items can be selected only on quote/order/blanket order, and become regular items on selection; not directly selectable on a sales invoice. [Create and manage catalog items](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-work-nonstock-items)

### Inferences
- Represent order commitment, physical fulfillment/receipt, and financial invoicing as distinct states/events. Partial fulfillment and partial invoicing require quantities and cumulative posted quantities, not a single “completed” switch.
- A common line schema can support goods and services, but type-appropriate UOM semantics and inventory effects must be explicit. Services should not accidentally decrement stock.

### Gaps
- The cited sales page covers sales workflow, not a detailed, type-by-type posting matrix for purchase receipt versus invoice. Verify exact purchase posting behavior and setup dependencies against BC 26 product tests or the relevant purchase posting documentation before matching ledger-level semantics.

## Posting groups, general ledger, and inventory cost accounting

### Takeaway
Posting is configuration-driven and multi-dimensional. Inventory cost valuation and general-ledger recognition are related but separate processes; Non-Inventory and Service costs do not enter the inventory-cost reconciliation pipeline.

### Cited Findings
- Posting groups map entities (customers, vendors, items, resources, documents) to G/L accounts. General Business and General Product groups combine in General Posting Setup; Customer/Vendor Posting Groups govern receivables/payables; Inventory Posting Groups combine with location via Inventory Posting Setup for inventory accounts. [Posting group setup](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-posting-groups)
- On a sales document, customer card groups supply business/customer groups and item card supplies product/inventory groups. Revenue uses business×product setup, receivables use customer group, inventory uses inventory posting group, and COGS uses business×product setup (subject to configured timing). [Posting group setup](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-posting-groups)
- Item ledger entries record inventory quantity changes; Value Entries record inventory value changes. Inventory item actual cost and cost-posted-to-G/L are tracked separately. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- Non-Inventory and Service costs are recorded in Value Entries' **Cost Amount (Non-Invtbl.)** field, with costs specified on sales/assembly/production documents and journals or defaulted from Item/SKU Unit Cost. These costs are not reconciled to G/L as inventory costs. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- Unless Automatic Cost Posting is enabled, inventory cost changes are not dynamically written to G/L and COGS is not calculated with the sale. Run Adjust Cost - Item Entries before Post Inventory Cost to G/L; the latter creates G/L entries from value-entry differences (actual cost less cost posted; optionally expected cost to interim accounts). [Reconcile inventory costs with the general ledger](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-how-to-post-inventory-costs-to-the-general-ledger)
- Inventory cost posting can summarize per posting group or post per entry. Inventory-G/L reconciliation compares value-entry-derived inventory balances with existing G/L balances and supports drill-down and filters. [Reconcile inventory costs with the general ledger](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-how-to-post-inventory-costs-to-the-general-ledger)
- Incorrectly used posting groups/setups cannot simply be deleted after G/L entries exist; setup can be blocked for future postings, and Change Log can audit setup changes. [Posting group setup](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-posting-groups)

### Inferences
- Preserve a traceable posting decision per transaction line: item/product classification, customer/vendor business group, location/inventory group, tax treatment, effective setup/account mapping, currency, dimensions, and posting date. Avoid deriving historical accounting from mutable current master settings.
- Separate the operational stock subledger from the financial ledger, with reconciliation, cost-adjustment and posting-status visibility. Make posting idempotent and auditable, including skipped/error entries.
- Non-stock goods can have purchase/sales costs and G/L revenue/expense effects without acquiring stock quantity/value. Their accounting path must not be inferred solely from the fact that a line references an item.

### Gaps
- The exact default account selection, posting timing, and local tax account behavior depend on company setup, localization, dimensions, and extensions; Microsoft Learn describes the mapping framework rather than a universal posting recipe.

## Item ledger, tracking, availability, and reporting

### Takeaway
Only Inventory type participates in the full stock subledger and availability/costing lifecycle. Type-level capability restrictions are substantive: non-stock types cannot be reserved, tracked, counted, revalued, or warehoused as inventory.

### Cited Findings
- Item Ledger Entries capture quantity changes, while Value Entries capture value changes. Inventory items carry actual cost and cost-posted-to-G/L; Non-Inventory/Service use non-inventory cost amounts and are excluded from inventory cost-to-G/L reconciliation. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- Item type feature matrix marks item tracking and reservation, warehouse, physical count, inventory revaluation, and inventory costing as supported only for Inventory. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- Inventory item variants can support availability reporting by variant; attributes/categories group items but are distinct concepts. [Create item cards for goods or services](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-register-new-items)
- BC provides Inventory Valuation, Inventory Valuation - WIP, Invt. Valuation - Cost Spec., and Cost Shares Breakdown reports; reconciliation tooling compares inventory value entries to G/L and can be filtered by date, item, and location. [Reconcile inventory costs with the general ledger](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-how-to-post-inventory-costs-to-the-general-ledger)
- The Item Card documentation says deleting cards with ledger entries is disallowed in the normal workflow due to valuation/audit needs. [Create item cards for goods or services](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-register-new-items)

### Inferences
- Stock availability should be a projection over inventory movements and reservations/demand/supply, segmented by dimensions such as location and variant, rather than a mutable product-level quantity field. Maintain append-only, attributable movements and derived balances.
- Serial/lot identity, reservation allocation, warehouse movement, physical count and valuation require their own records and invariants; they cannot be credibly represented by a checkbox on product master.
- Reports should distinguish physical/on-hand quantity, available quantity, expected versus actual cost, inventory subledger totals, and posted G/L totals.

### Gaps
- The successful Microsoft Learn URLs used here establish the capability boundary but do not give full item-tracking assignment and availability formula details. A current exact item-tracking/availability article URL and reservations/availability edge cases should be verified against Microsoft Learn search for the target BC deployment (online versus on-premises, localization, and extensions).

## Conversion and reclassification path

### Takeaway
The documented supported conversion is catalog item → regular item at selection or explicit Create Item. Do not assume an existing posted item can be safely changed between Inventory, Non-Inventory, and Service; classify conversion as an explicit migration with historical and stock-accounting controls unless Microsoft confirms a supported native action for the target build.

### Cited Findings
- Catalog conversion creates a new regular Item Card prefilled from the catalog item and a template, and automatically creates a vendor item-number reference. [Create and manage catalog items](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-work-nonstock-items)
- A catalog-generated item may be automatically deleted if the originating sales line is removed, except after use in sales/purchase lines, BOMs, or ledger entries. [Create and manage catalog items](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-work-nonstock-items)
- Regular item deletion is prohibited through normal workflow after a transaction is posted. [Create item cards for goods or services](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-register-new-items)
- The item-type documentation defines different available accounting and operational features but does not describe a conversion/reclassification command. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)

### Inferences
- Preserve stable item identity and treat a change in stock-tracking semantics as a governed migration: stop new use, reconcile and close old-stock balances, create or designate a successor master, migrate mappings/references deliberately, and retain lineage. Never retroactively reinterpret old movements under a new type.
- Track the effective classification/setup at posting time and enforce no silent switch where it would invalidate outstanding reservations, open documents, warehouse activity, or uncosted quantities.

### Gaps
- No official Learn source located in this research establishes a general supported Item Type conversion path for BC 26+. Custom AL code may alter behavior; a sandbox test and Microsoft/partner confirmation are needed for any required native conversion.

## Architectural invariants to emulate

### Takeaway
The useful BC design lesson is that master classification constrains which ledgers and workflows can be affected, while posted facts remain durable and accounting is a configurable projection of those facts.

### Cited Findings
- Type controls inventory quantity/value tracking and the availability of tracking, reservation, warehousing, planning, consumption, and costing capabilities. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- Posting groups map business and product context to G/L accounts; inventory valuation uses ledger/value entries and may reconcile/post to G/L asynchronously or in a batch. [Posting group setup](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-posting-groups); [Reconcile inventory costs with the general ledger](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-how-to-post-inventory-costs-to-the-general-ledger)
- Posted item history constrains deletion, and catalog conversion has conditional rollback/deletion semantics only before durable use. [Create item cards for goods or services](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-register-new-items); [Create and manage catalog items](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-work-nonstock-items)

### Inferences
- Enforce: (1) immutable posted movement events; (2) balance projections derived from events; (3) type-gated operation authorization; (4) transactionally consistent fulfillment and ledger posting; (5) durable source-document and master references; (6) versioned/effective accounting mappings; (7) explicit reconciliation and exception queues; (8) no destructive reclassification after use.
- Distinguish three concepts in data model: sellable offering/catalog, item master classification, and inventory-bearing stock identity. This avoids conflating “not stocked yet” with a non-inventory consumable or a service.
- Treat receipt/shipment and invoice as independently postable events when partial workflows are required. Store quantities already posted per stage and prevent duplicate posting on retry.
- Make audit lineage queryable end-to-end: order line → receipt/shipment → item/value movement (where applicable) → subledger posting → G/L entry, with original configuration and actor/time.

### Gaps
- Exact behavior can differ with localization, feature switches, costing setup, warehouse configuration, and installed extensions. The cited Microsoft Learn material is current documentation retrieved for this research and has 2026 page updates, but it does not pin every statement to a BC 26 runtime build; verify target tenant/build behavior for accounting-critical parity.
