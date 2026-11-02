# Business Central item types and related workflows, versions 26 onward

## What actually changed by release/version?

### Takeaway
Across versions 26–28, Microsoft documents substantial workflow, item-tracking, product-catalog, manufacturing, posting, and analytics changes, but no new core item type replacing or extending the longstanding Item Type distinction. The release material's mentions of “item” often concern ordinary inventory items and should not be read as adding a new item/service/non-inventory type.

### Cited Findings
- Business Central 2025 release wave 1 covers April–September 2025; its version 26.0 what's-new page is dated April 24, 2025 and says update 26.0 starts that wave. [2025 wave 1 overview](https://learn.microsoft.com/en-us/dynamics365/release-plan/2025wave1/smb/dynamics365-business-central/); [26.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-26-0)
- Version 26 includes workflow changes relevant to item inventory and supply chain: multiple users can post item ledger and value entries concurrently (feature disabled by default in 26.0); project items can be received using receipts/put-aways; manufacturing changes include blocking items/variants from production output and improved production operations; cost adjustment troubleshooting and enhanced inventory analytics are also listed. These change posting/handling/reporting, not the item type taxonomy. [26.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-26-0)
- The 2025 wave 1 plan describes Copilot support for creating product information such as variants and units of measure and Shopify integration improvements around inventory across locations and variants. These are catalog/data-entry and connector enhancements; they do not announce new item types. [2025 wave 1 overview](https://learn.microsoft.com/en-us/dynamics365/release-plan/2025wave1/smb/dynamics365-business-central/)
- Version 27 is the 2025 release wave 2; its what's-new page is dated October 2, 2025. Listed supply-chain change includes sorting lines by type and number in sales and purchase postings (public preview); Shopify market-specific prices and company-location data are catalog/channel-adjacent. No new item type-specific capability is listed in the 27.0 feature table. [27.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-27-0); [2025 wave 2 overview](https://learn.microsoft.com/en-us/dynamics365/release-plan/2025wave2/smb/dynamics365-business-central/)
- Version 27 makes the feature update for package tracking in physical inventory orders mandatory/removes it from Feature Management. This is a rollout/state change for package tracking in physical inventory—not a new tracking number concept or item type. [27.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-27-0)
- Version 28 is 2026 release wave 1. Its what's-new page is dated April 1, 2026 and its feature list labels item-variant images, item attributes on variants, Shopify product options based on attributes, custom Shopify collections, and variant image synchronization as generally available. These improve product catalog presentation/variant export, not the foundational item type model. [28.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-28-0); [2026 wave 1 overview](https://learn.microsoft.com/en-us/dynamics365/release-plan/2026wave1/smb/dynamics365-business-central/)
- Version 28 also lists inventory insights/advanced item KPIs, enhanced analytical inventory reports, and operational changes such as purchase invoices matched to multiple order/receipt lines, drop-shipment posting/reversal improvements, and item-journal/requisition approvals. These affect analysis, procurement, and posting rather than adding item types. [28.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-28-0)
- Current Microsoft tracking documentation describes serial, lot, and package tracking numbers assigned to inbound/outbound documents and transferred to item ledger entries after posting. This documents established tracking behavior; the 27.0 note above is specifically package tracking enabled for physical inventory orders. [Track items with serial, lot, and package numbers](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-work-item-tracking)

### Inferences
- Release-note claims about product information, item variants, Shopify, or “item insights” should be classified as catalog/integration/analytics changes unless the individual feature explicitly changes a type field or its transaction eligibility.
- Of the reviewed official version summaries, none announces a new core item type or a change to the distinction among inventory goods, services, and non-inventory purchases/sales. “No item-type-specific change” is the appropriate conclusion for versions 26, 27, and 28 based on their published feature inventories, while acknowledging that these inventories are not a formal exhaustive proof of every code change.

### Gaps
- Microsoft release summaries do not present a formal version-by-version change log specifically for the item type enum or all item-type posting rules. To prove there was no internal change whatsoever would require comparing the versioned base application source/schema and release-specific technical notes, not just release plans.
- Version 28's 28.0 page is a preview-oriented What's New page and its release timing is future/planned relative to its publication; feature availability can vary by rollout. Treat listed status as Microsoft's published status, not proof of deployment in every tenant.

## What is longstanding behavior versus release-note novelty?

### Takeaway
Business Central’s core item tracking and inventory ledger mechanics are documented as general product behavior, not as features newly introduced by 26–28. Distinguish these baseline rules from the releases' incremental improvements to concurrency, warehouse posting, physical inventory package tracking, production, and catalog integration.

### Cited Findings
- Microsoft's item-tracking guidance says serial, lot, and package numbers can be assigned on inbound/outbound documents and tracked entries appear on related item ledger entries. It also describes inventory journals, warehouse physical inventory, source-document assignment, transfers, and posting—without tying these core mechanics to a specific 26+ release. [Track items with serial, lot, and package numbers](https://learn.microsoft.com/en-us/dynamics365/business-central/inventory-how-work-item-tracking)
- The 26.0 what's-new inventory marks concurrent item-ledger/value-entry posting as a new optional feature disabled by default. Therefore the novelty is concurrent posting support/locking behavior; inventory posting itself and item ledger/value entries are pre-existing. [26.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-26-0)
- The 27.0 what's-new inventory marks package tracking for physical inventory orders as a feature update becoming mandatory. This indicates prior feature-management-controlled rollout, not that package numbers or item tracking originate in version 27. [27.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-27-0)
- Version 26 product/catalog features include Copilot assistance for item summaries/autofill and manufacturing product design, while version 28 adds item-variant images, attributes, and Shopify product options. None of the cited summaries describes a new inventory/service/non-inventory type. [26.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-26-0); [28.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-28-0)
- The Business Central documentation hub separately organizes inventory, purchasing, sales, and service management, confirming these are distinct documented functional areas. [Business Central documentation](https://learn.microsoft.com/en-us/dynamics365/business-central/)

### Inferences
- A release note saying a workflow was enhanced or “enabled by default/mandatory” describes rollout or changed usability/operation, not necessarily the creation of the underlying business concept.
- Do not infer that a generic “item” mention includes service and non-inventory lines: verify feature scope in its detailed page, particularly where posting creates item ledger entries or product variants.

### Gaps
- The reviewed official release pages do not give a single stable, versioned reference that exhaustively compares service and non-inventory line behavior against inventory item behavior. Specific claims about which document types permit each type should be cited to the relevant functional how-to page for that workflow.

## Source dates, scope, and cautions

### Takeaway
Use version what's-new pages for what shipped or was listed in a specific update, release plans for intended wave scope, and current Learn workflow articles for operating rules. Release plans are plans and can change; distinguish preview, generally available, and feature-management status explicitly.

### Cited Findings
- The 2025 wave 1 plan covers April through September 2025; version 26.0 what's-new page dated April 24, 2025 says 26.0 starts wave 1 and reports the update beginning April 14, 2025 for the noted on-premises build. [2025 wave 1 overview](https://learn.microsoft.com/en-us/dynamics365/release-plan/2025wave1/smb/dynamics365-business-central/); [26.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-26-0)
- The 2025 wave 2 plan covers October 2025–March 2026. The 27.0 what's-new page is dated October 2, 2025, identifies 27.0 as the wave-start update, and says the online update period ended February 28, 2026. [2025 wave 2 overview](https://learn.microsoft.com/en-us/dynamics365/release-plan/2025wave2/smb/dynamics365-business-central/); [27.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-27-0)
- The 2026 wave 1 plan covers April–September 2026. The version 28.0 What's New page is dated April 1, 2026 and describes online rollout/update scheduling through August 31, 2026. [2026 wave 1 overview](https://learn.microsoft.com/en-us/dynamics365/release-plan/2026wave1/smb/dynamics365-business-central/); [28.0 what's new](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/whatsnew/whatsnew-update-28-0)
- Microsoft marks release plan pages archived as of October 2026; they remain useful as historical plans, while Microsoft directs readers to current Learn product documentation for authoritative guidance. [2025 wave 1 overview](https://learn.microsoft.com/en-us/dynamics365/release-plan/2025wave1/smb/dynamics365-business-central/); [2025 wave 2 overview](https://learn.microsoft.com/en-us/dynamics365/release-plan/2025wave2/smb/dynamics365-business-central/); [2026 wave 1 overview](https://learn.microsoft.com/en-us/dynamics365/release-plan/2026wave1/smb/dynamics365-business-central/)

### Inferences
- The most reliable synthesis is the intersection of release feature inventory and the detailed feature page, then compare with current procedural documentation to separate novelty from baseline behavior.

### Gaps
- A version 29 release plan/what's-new inventory was not included; “28 onward” here means version 28 and releases covered by the retrieved official material, not a claim about later versions beyond the research date/material.
