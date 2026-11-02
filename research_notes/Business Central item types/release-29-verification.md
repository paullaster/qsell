# Business Central item types: release 29 verification (as of 2026-11-01)

## Does Business Central 29.0 / 2026 release wave 2 change the Item Card Type options?

### Takeaway
No direct change is documented: Microsoft’s 29.0 What's New inventory/supply-chain feature list contains no addition or modification to the Item Card Type choices. The current official item-type matrix still lists Inventory, Non-Inventory, and Service. This conclusion is limited to the reviewed official 29.0 note; it is not a claim that no extension or localization can add behavior.

### Cited Findings
- Microsoft identifies 29.0 as the start of 2026 release wave 2. The What's New article is published 2026-09-29 (page metadata; updated 2026-10-01) and lists the version’s new/changed capabilities. [What's New or Changed in Business Central 2026 release wave 2 - Update 29.0](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-29-0)
- The current item-type article lists exactly three Item Card Type options: Inventory, Non-Inventory, and Service. Its publication date is 2026-04-07 (updated 2026-04-09). [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- The 29.0 note specifically includes supply-chain/manufacturing improvements (subcontracting instructions, subcontracting setup, warehouse picks/put-aways for subcontracting, manufacturing documents/capacity calendars), quality inspections, and item-related sustainability functionality; it does not announce another item type or revised type matrix. [29.0 What's New](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-29-0)

### Inferences
- The available official evidence supports retaining the three-type model in any current Item Card Type enum. 29.0’s nearby item/supply-chain work should be treated as adjacent capabilities, not as enum expansion.

### Gaps
- The 29.0 overview is a release summary, not a published exhaustive schema diff of the base-app enum. Confirm the actual deployed build’s enum metadata/source if a code-level guarantee is required.

## What operational distinctions and adjacent changes matter?

### Takeaway
Type determines inventory-process support, not whether an offering is a service/catalog record in a broader sense. Inventory supports the full tracking, costing, warehousing, and planning matrix; Non-Inventory and Service do not track inventory quantity/value and have narrower support. Release 29 features expand workflows around items without changing those distinctions in the published matrix.

### Cited Findings
- The Microsoft matrix marks Inventory as supported across sales/purchasing, consumption/output, transfers, counting, revaluation, costing, item tracking, reservations, warehousing, planning, and order planning. Non-Inventory retains sales/purchasing and several consumption scenarios plus order planning, but not output, transfers, physical counting, inventory revaluation/costing, tracking, reservations, warehousing, or planning. Service supports sales/purchasing and job/service consumption plus order planning; it does not support assembly/production consumption or the inventory-management features listed. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- For Non-Inventory and Service, costs are recorded as non-inventory costs and are not reconciled to the general ledger as inventory cost; Inventory uses item/value ledger entries and inventory costing. [Understand item types](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-about-item-types)
- Item attributes are described as a way to group/classify inventory items (distinct from categories and variants); the general item setup guidance also discusses replenishment and planning separately from Type. [Create item cards for goods or services](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-register-new-items) — published 2026-04-07.
- Catalog items are separate from regular Non-Inventory items: they are not managed in Business Central until selected for a sales document, when they convert to a regular item. [Create and manage catalog items](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-work-nonstock-items) — published 2024-11-21.
- 29.0 includes subcontracting process/setup and warehouse execution features, manufacturing-document/capacity-calendar improvements, and supply-chain quality inspection improvements. These change operational workflows, not the item-type matrix as documented. [29.0 What's New](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-29-0) — published 2026-09-29.
- 29.0 sustainability items include carbon-footprint tracking with item journals and item reclassification journals, emissions formulas in purchase documents, and a specific carbon-footprint calculation method when enabling item tracking. These are sustainability/accounting additions around item transactions, not a new Item Card Type. [29.0 What's New](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-29-0) — published 2026-09-29.
- The 29.0 list includes Shopify B2B catalogs/pricing and catalog/order synchronization capabilities. In this context “catalog” is ecommerce product/catalog functionality; it does not redefine the core Item Card Type options or the separate BC Catalog Items conversion workflow. [29.0 What's New](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-29-0) — published 2026-09-29; [Create and manage catalog items](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-work-nonstock-items).

### Inferences
- Treat item attributes, planning parameters, subcontracting, ESG/carbon accounting, and Shopify/product-catalog work as orthogonal dimensions or workflows. None is evidence that Inventory, Non-Inventory, or Service semantics have changed.
- Do not model Catalog Item as a fourth Item Card Type: Microsoft documents it as a separate record that converts to a regular item when offered/sold.

### Gaps
- The What's New summary does not detail every field-level change in the 29.0 item, manufacturing, ESG, or Shopify features. This note makes no claims beyond their listed scope and the current published type matrix.
