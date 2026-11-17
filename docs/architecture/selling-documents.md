# Selling documents: Sales Orders, Cash Sales, Credit Sales and Sales Invoicing

**Status:** DRAFT, decisions in section 11 approved 2026-11-16 with two changes by the owner: **Cash Sales need shifts** (section 4.5) and a fifth type, the **direct Sales Invoice** (section 4.4), was added. **S-0 is built** (registry, selling settings and their screen, `sales_invoice` as a channel); nothing else is. **Owner:** Sales, with Pricing, Packages, Finance (receivables), Invoices/KRA signing, Stock and Delivery as users of it.

This document turns things the platform has anticipated but never given screens into modules: **Sales Orders** (the staff order), **Credit Sales** (on the customer's account), **Sales Invoices** (a sale invoiced directly, with no sales order and neither credit nor counter cash), **Cash Sales** (paid now, at the counter, inside a **shift**) and **Sales Invoicing** (the screens for invoice documents). It extends, and does not replace, [`sales-order-blueprint.md`](./sales-order-blueprint.md) (Phases 1, 2 and 4) and answers section 10.7 of [`configurable-packages.md`](./configurable-packages.md) ("every place something is sold"). Where this document is silent, the blueprint governs.

## 1. Why now

Staff can sell today only through a **quote** (Sales Quotes, then accept, then convert) or by the customer using the web shop. There is no way for staff to take a phone order, a walk-in sale or an account sale directly. Configurable packages made the gap visible: a package can be quoted and bought on the shop, but a cashier cannot sell it and a sales person cannot enter an order for it.

## 2. What exists today (evidence, so nothing is built twice)

| Capability | Where it is | State |
|---|---|---|
| One order record with a **sales module** (`ecommerce`, `sales_order`, `credit_sale`, `pos_cash_sale`) | `orders.sales_module`, `kra/signing/types.ts` | Built; only `ecommerce` and the quote-conversion `sales_order` are ever written by a screen. **`sales_invoice` is not one of them yet**: today that name is only the general ledger's name for a credit invoice (`finance/sales-posting-service.ts`). Adding it as a sales module (with its signing switch and approvals) is new work in S-0 |
| Order writer that already takes `salesModule` and `paymentMethod: 'on_account'` (which makes it a `credit_sale`) | `orders/write-service.ts` | Built: pricing with channel and sales type (cash or credit), stock reservation, packages, credit-limit check, approvals, stage timeline, in one transaction |
| Approvals for `sales_order` and `credit_sale` (never the shop, never the till) | `orders/approval.ts` | Built |
| **Credit check:** for any staff order of a customer whose account type is *credit*, balance plus this document against the credit limit; over it, an approval workflow may release it, otherwise it is refused. The check keys off the **customer**, not the document type, so a sales order is checked too. **Credit days:** every order writes a ledger entry due on the placing date plus the customer's payment terms. Not considered today: overdue invoices, open-order exposure, hold-and-release | `write-service.ts` (`overCreditLimit`), `customers/master-service.ts` (ledger entry and due date), `finance/receivables/credit-policy-service.ts` | Built as described |
| **Stock timing:** stock is *reserved* when an order is placed, and *issued* (taken off on-hand, stage `stock_issued`) when payment is confirmed, at a door payment, or at goods issue on delivery; released on failure or cancel | `inventory/reservation-service.ts` (`reserveForOrder`, `fulfilOrder`, `releaseOrder`) | Built; the trigger is fixed by the path, not chosen |
| **Tax invoice** per order, numbered once, KRA-signed by module; **proforma** for quotes | `invoices/service.ts`, `invoice_documents`, `kra/signing` | Built for orders; no staff screens beyond "Generate PDF" and "email" on an order |
| Number series kinds: `sales_order`, `proforma_invoice`, `tax_invoice` (fiscal, per branch), `pos_receipt` (fiscal), `credit_note` | `kernel/numbering/document-kinds.ts` | Built; bindings per branch |
| Receipts, cash application, customer ledger, cash counts, wallet, refunds, credit notes | `finance/receivables/*` | Built (finance F-1 and later) |
| Order stage timeline (every stage timestamped, with actor, source, reason) | `orders/stages.ts`, `order-stage-timeline.md` | Built; the writer already chooses source `staff` or `pos` for non-shop channels |
| Packages sold by any document that registers in `PACKAGE_DOCUMENT_TYPES`; staff documents skip the cart-only refusal | `pricing/domain/package-documents.ts`, `PackageOrderService` | Built for orders and quotes |
| Cash counts of a drawer against the books (denominations, difference posted) | `finance/receivables/cash-count-service.ts` | Built; the close of a shift reuses it |
| A staff order screen, a till, a shift, an invoice list | none | **Missing** |

**Consequence:** the hard parts (pricing, stock, packages, credit, approvals, fiscal numbering, signing, timeline) exist behind one door. What is missing is the **front of the house**: the screens, the permissions, the few records that tie the documents together, and the rules for what each type does.

## 3. Design stance

1. **One order aggregate.** Sales Orders, Credit Sales, Sales Invoices and Cash Sales are **types of the same order** (blueprint 6.2: "order types are a table, not code branches"), not three new tables. A type fixes: the sales module (so the right approvals, signing switch, price channel and sales type apply), the payment rule, and the document it ends with.
2. **An invoice is a document about an order**, not a status of it. The invoice record (`invoice_documents`) already exists; Sales Invoicing gives it screens and, later, partial billing (section 8).
3. **Draft is the quote's job.** A staff member who needs to think, price and send a document first uses a **quote**. An order screen **places** the order (stock is held, approvals start, the stage timeline begins). We do not add a second kind of draft.
4. **One selling screen.** All the order types use one editor made of parts that already exist (customer picker, catalogue lines, `PackageBuilder`, price trace, delivery or collection, payment). The type switches what is asked and what pressing **Place** does.
5. **Every selling document sells packages** and is proven to by the shared test of section 10.7, which gains a case for each type.
6. **Nothing here weakens the rules.** Server-side checks of every permission and every price; client sends ids and counts only; company-scoped queries; failures as data; the stage timeline and the single stage writer unchanged.

## 4. The modules

### 4.1 Sales Orders

**For:** a phone order, a walk-in order to be collected or delivered later, a repeat customer's standing order, a B2B order that needs approval.

**Flow:** choose or create the customer, add lines (products, kits, packages through the shared builder), see the price and its explanation, choose delivery, collection or none and the date, choose how it will be paid (on delivery, later, on account, or take payment now), **Place**. The order is created `sales_order` with stock held; approval workflows apply (`sales_order` is already approved by staff); the stage timeline records "placed by staff" with the person.

**Created:** the order and its lines (and package instances); stock reservation; approval entries when a workflow matches; for a package, its preparation-sheet entry. Not created: an invoice (that is a choice, section 4.4).

**Link to quotes:** a quote converted to an order already becomes a `sales_order`. The order shows its **source quote** and the quote shows its **order**, both ways.

**Screens:** `Sales and Fulfillment → Sales Orders` (new): a list (paged, keyset, filtered by status, customer, date, branch) of orders with sales module `sales_order`, and **New sales order**. The existing *Customer Orders* screen stays the place to **process** any order (courier, packing, delivery); Sales Orders is where staff **take** them.

**Permissions (new):** `sales_orders:read`, `sales_orders:create`. Cancelling and approving stay `orders:cancel` and `orders:approve`.

### 4.2 Cash Sales

**For:** the counter. The customer pays now and takes the goods now (or a package is made while they wait).

**Flow:** a fast, touch-friendly version of the same editor: scan or search, add lines or a package, choose the **tender** (cash, M-Pesa till, card, split), enter what was handed over, **Complete**. In one transaction: the order (`pos_cash_sale`), stock out, the payment(s) recorded as received, and the **receipt** numbered from the fiscal `pos_receipt` series and signed under the `pos_cash_sale` switch. Change due is shown. No approval holds a cash sale (as today).

**Created:** order, payments (tenders), receipt document; stock movement; nothing waits.

**A cash sale needs an open shift** (decision of the owner): it is refused unless the person has an open shift on a register in their branch, and it is recorded against that shift. The shift, the register, the float, the X and Z reports and the cash declaration are section 4.5 and are built **before** Cash Sales. **Not in this build:** offline mode, returns at the till (a void is a return, section 11.6), omnichannel sourcing.

**Screens:** `Sales and Fulfillment → Cash Sales` (new): the sale screen (with the open shift, register and running totals always in view) and the shift's cash sales list. Branch is the person's branch.

**Permissions (new):** `cash_sales:create` (also needs an open shift), `cash_sales:read`; the receipt reprint is `cash_sales:read`; voiding a sale is a **return** (blueprint section 10), never an edit.

### 4.3 Credit Sales

**For:** an account customer buys now and pays on their terms.

**Flow:** the same editor with the customer required to be an **account customer**; before Place the screen shows their **credit position** (limit, balance, overdue, this sale), and the server decides: within the limit it places; over it the existing credit-limit refusal applies. A **credit hold with release** (the order is kept, on hold, and an approval is requested instead of being refused) is described in blueprint section 6.5 but is **not built**; it is a decision below (11.9) whether to build it in this slice. Terms (days) come from the customer. The order is `credit_sale`; an **invoice on account** is raised at once (the tax invoice, numbered and signed under `credit_sale`) and the amount lands on the customer's ledger.

**Created:** order, invoice, ledger entry (receivable), approval entry when needed.

**Screens:** `Sales and Fulfillment → Credit Sales` (new): list and the sale screen. A customer's statement and ageing already live under Finance (receivables).

**Permissions (new):** `credit_sales:read`, `credit_sales:create`; releasing a held sale is the approval (`orders:approve`), as for any order.

### 4.4 Sales Invoices (a direct sale) and Sales Invoicing (the documents)

**Sales Invoice, the type (`sales_invoice`), added by the owner.** Some sales are **invoiced directly**, with no sales order in front of them: the invoice is the selling document. It is for **account customers** and, by default, **does not skip the credit check and does use credit days**: the customer's credit limit is checked and the invoice falls due after the customer's payment terms. Because a company's practice differs (pay before release, no credit, fixed days, hold until paid), **every one of these behaviours is a setting** of the type (section 4.6), not a rule in code. Flow: choose the customer, add lines (products, kits, packages), see the price and why, see the **credit position** when the type checks credit, **Issue**. In one transaction: the order record (`sales_invoice`) is created, the credit rule of the type is applied, the **tax invoice** is numbered from the fiscal `tax_invoice` series and signed under a new `sales_invoice` switch, the amount lands on the customer's ledger as a receivable due per the type's terms, and stock is reserved, to be issued at the moment the type's **stock release** setting says (section 4.6). Created: order, invoice, ledger receivable, approval entry when the type's approval setting asks for one.

**Sales Invoicing, the screens.** For raising, finding, re-sending and correcting the **invoice** of any order.

Today an order gets its tax invoice when it is placed on account (and on request through "Generate PDF"); a quote gets a proforma. Sales Invoicing gives staff the screen for them:

- **Sales Invoices** list (new): every invoice document with its order, customer, total, **status** (draft, issued, signed with KRA, failed to sign, emailed, paid, partly paid, credited), filters, paging. Open one to see the document, the signing trace, the payments applied and the credit notes against it.
- **Raise an invoice** from an order that has none (a sales order delivered or collected), for the whole order (first build). The fiscal rules already in place hold: not before approval; the number is gap-free per branch; signing never blocks the invoice.
- **Re-send and re-print**; **cancel by credit note only** (a signed invoice is never edited or deleted; it is corrected by a credit note through the credit-note service, which exists).
- **Partial billing** (bill each delivery, a part of an order, a milestone) is **not** in the first build: it needs a billing-document record linking order lines to invoice lines, which is blueprint Phase 2. Until then an order has one invoice for the whole order.

**Permissions (new):** `sales_invoices:read`, `sales_invoices:create` (raise, and issue a direct sales invoice), `sales_invoices:send`.

### 4.5 Shifts and tills (required by Cash Sales)

Cash sales are accounted for by **shift**, as in blueprint section 11. A **register** (till) belongs to a branch and to a cash account; a **shift** is one person's period on one register.

- **Open:** choose the register, count the **opening float** (reusing the cash-count denominations), **Open shift**. One open shift per register and one per person at a time. A register left open from a previous day is closed first (by its owner or a supervisor).
- **During:** every cash sale is recorded against the shift with its tenders. **Paid in / paid out** (cash added or taken for a reason) are shift movements with a reason. The shift always shows what the till should hold.
- **X report:** the shift so far, by tender, any time, without closing it.
- **Close:** the person **declares** the cash counted (denominations, the same count as the finance cash count, so the difference is posted to the books the same way); the system compares it with what the till should hold; a **variance** needs a **reason**, and one beyond the company's tolerance needs a **supervisor approval** through the approval engine. M-Pesa and card totals are shown for reconciliation against the provider and bank statements already built.
- **Z report:** the final report of the shift, numbered from a gap-free series (`z_report`, a new document kind), printed and kept; a closed shift is never edited.
- **Handover:** a shift can be closed and the next opened on the same register, with the float carried.

**Created:** `registers`, `shifts` (opening float, declared cash, expected cash, variance, reason, status, Z number) and `shift_movements`; `orders.shift_id`. **Permissions (new):** `registers:manage`, `shifts:open`, `shifts:close` (own shift), `shifts:read`, `shifts:supervise` (close another's, approve a variance). **Screens:** `Sales and Fulfillment → Shifts` (open, current, history, reports) and `Settings → Registers`.

### 4.6 Selling behaviour settings (what each type does is configuration)

The behaviours that differ between selling documents, and between companies, are **settings of the document type**, not code. The code registry (`domain/selling-documents.ts`) holds the **types, the allowed options and the defaults**; a company's overrides are stored (`selling_document_settings`: company, type, version, the values) and changed in **Settings → Selling documents** behind its own permission, with a reason and the decision log, as for Email Routing. Reading a type's behaviour is one pure function (`resolveSellingSettings(type, stored)`), so a missing or invalid row can never break a sale.

| Setting | Choices | Meaning |
|---|---|---|
| **Credit check** | *Off* · *Limit* (balance plus this document against the limit) · *Limit and overdue* (also when an invoice is overdue by more than N days) | Applies to customers with a credit account; a customer without one is handled by the next setting |
| **Customer without a credit account** | *Allow* · *Refuse* (· *Require payment first*, added with the stock settings in S-1b) | What a type does with a cash customer (a sales invoice to a walk-in) |
| **Over the limit** | *Refuse* · *Hold and ask for approval* | The hold keeps the document with its stock reserved, on hold, until the approval releases or rejects it (blueprint 6.5; decision 11.9) |
| **Credit days** | *The customer's payment terms* · *A fixed number of days* · *Due on issue* | Sets the due date of the ledger entry and the invoice |
| **Stock release** | *When the document is issued* · *When payment is received (hold until paid)* · *At delivery or collection* | When reserved stock is **issued** (taken off on-hand). Today's paths are the second and third; the first is new. "Always hold until paid" is simply the second choice on every type |
| **Approval** | *By the company's workflows* · *Never* | Whether the document can wait for approval (today fixed in code for sales orders and credit sales). *Always* is not offered: the approval engine decides by workflows and has no way to force an approver; to be considered with the engine |
| **Invoice** | *Issued with the document* · *Raised by staff later* | When the tax invoice is made (sales orders default to later, credit sales and sales invoices to with the document) |
| **Discounts** | *Allowed* · *Not allowed* | Whether staff may discount on this type (the pricing guard and override limits still apply) |

**Defaults** (what a company that changes nothing gets): *Sales order*: credit check *Limit*, over the limit *Hold and ask for approval*, credit days *customer's terms*, stock *at delivery or collection*, approval *by workflows*, invoice *later*. *Credit sale*: as the sales order, invoice *with the document*, stock *at delivery or collection*. *Sales invoice*: credit check *Limit*, credit days *customer's terms*, approval *by workflows*, invoice *with the document*, stock *when issued*. *Cash sale* (needs a shift): credit *Off*, stock *when issued*, approval *Never*, invoice *with the document* (the receipt). The web shop is not a selling document type and is untouched.

**Scenarios it must cover, by setting alone:** an account customer on 30 days (credit check *Limit*, credit days *customer's*); a company that sells **only after payment** (credit *Off*, credit days *Due on issue*, stock *When payment is received*); a pay-before-release customer among account customers (a per-document **Hold until paid** switch, offered where the type allows it, overriding stock release for that document); a service or non-stock invoice (stock release has nothing to do); a strict company (credit check *Limit and overdue*, over the limit *Refuse*). A **per-customer** rule (this customer pays first) stays on the customer master (account type, limit, terms) and is not a setting of the type.

## 5. The shared selling editor

One client editor, `SellingDocumentEditor`, wraps parts that exist:

| Part | Reused from |
|---|---|
| Customer (find, or **create new** through the existing intercepting route) | quote editor / customer lookups |
| Lines: catalogue products and kits | quote editor lines |
| Packages | `PackageBuilder` through a small wrapper like `QuotePackageDialog` (staff builder: every option choosable, the package need not be on the shop) |
| Price and why | the pricing trace the quote already shows |
| Delivery, collection, date | delivery module slots and the order's fulfilment fields |
| Payment | the payment methods and tenders already used by checkout |

What changes per type is a **document type definition** in one place (`domain/selling-documents.ts`): the sales module, the label, whether a customer is required, whether payment is taken at placing, whether credit is checked, which number series and signing switch, the permission keys, and the default after placing (open the order, print the receipt). A new type is a new entry, not new code paths.

**Server:** one action per type that checks its permission, validates input (ids and counts, never prices), and calls the order writer with the type's `salesModule`; the writer does the rest. The browser never sends a price, a customer's credit, or a flag.

## 6. Document flow and statuses

- **Links:** `quote → sales order → (delivery) → invoice → receipt(s) → (credit note)`. Add `orders.source_quote_id` (the quote that produced it) and show a **document flow** panel on every order: what came before, what came after, with status and links. Invoices and receipts already know their order.
- **Statuses:** unchanged. The order's status, payment status and approval status are projections of the **stage timeline**; this work adds the stages "placed by staff", "invoice raised" and "receipt issued" (each with actor, source, reason, server time), never a new way to write status. Every refusal (credit limit, approval, stock) is recorded as a stage with its reason, as the rules require.
- **Cancel / change:** a placed order is cancelled with a reason (existing); a signed invoice is corrected by a credit note; a cash sale is undone by a return. Nothing is edited after the fact.

## 7. Packages in every type

- Register `sales_order`, `sales_invoice`, `pos_sale` and `credit_sale` in `PACKAGE_DOCUMENT_TYPES` (their order lines are order lines, so the check "the line exists in this company" is the order's) and add each to the shared test that runs the same package cases against every type.
- **Staff documents may sell what the shop does not**: a package kept off the shop, a package sold by quote only, a package with an audience. The rules of ordering (notice, closing time, daily limit, who may order) **still apply** to a sales order for a date; a cash sale is "now".
- **Where it is offered** (section 6 of the packages design) becomes real here: a package, and later any product, lists the document types it may be sold in. Until then every type may sell every package. This is slice S-6 below.
- A cash sale of a package takes its parts out of stock when it is sold (the existing kit machinery), prints the selection on the receipt, and, for made-to-order food, shows on the preparation sheet for the day.
- Group orders and "order again" stay web shop features.

## 8. Data (the least that is needed)

| Change | Why |
|---|---|
| `orders.source_quote_id` (nullable, indexed) | document flow, both ways |
| `invoice_documents`: `status`, `signed_at`, `paid_amount` projections, `branch_id`, `created_by` | list, filters and the screen; invoices are today a log of PDFs |
| Tenders for a cash sale: reuse `orders.tendered_amount` and receipts; a `sale_tenders` table only if split tenders need their own rows | split cash and M-Pesa |
| `registers`, `shifts`, `shift_movements`; `orders.shift_id`; the `z_report` document kind; idempotency keys on the placing commands | shifts and tills (4.5), safe retries |
| `sales_invoice` added to the sales modules and signing switches | the direct sales invoice (4.4) |
| Permission keys (section 4) and nav entries | access and navigation |
| **No** new orders table, no new invoice number scheme | one aggregate, one numbering |

All new tables and columns are company-scoped, migrations are generated and hand-reviewed, and the shared test of section 10.7 gains the new types.

## 9. Security and controls

Every action checks its permission on the server; a person may only act in their branch unless granted otherwise; a cash sale cannot be created without an open shift of the person's own, on a register of their branch; a closed shift and its Z report are never edited; a till variance needs its reason and, beyond the tolerance, a supervisor; prices, discounts and floors go through the pricing guard as today (a discount past a person's override limit needs approval); a credit sale cannot raise a customer past their limit without the configured hold and approval; fiscal documents are numbered gap-free and signed under their module switch; every change and refusal is on the timeline with who, when and why.

## 10. Order of work (slices, each ships with unit, database, API and browser tests and its implementor guide)

| Slice | What | Notes |
|---|---|---|
| **S-0** (built) | The type registry with options and defaults; the **selling settings** (table, service, pure resolver, screen under Settings with its permission); `sales_invoice` as a sales module (signing switch, pricing channel, stock channel) | Foundation; no selling screen yet |
| **S-1a** (built) | The order writer honours the credit check, the customer-without-account rule, over the limit, credit days, approval and discounts for every staff sales order, including one from an accepted quote | Defaults leave behaviour as it was |
| **S-1b** (built) | Stock release (when issued, when paid, at delivery), a per-document hold until paid, "require payment first" and invoice timing. The choice is kept on the order (`orders.stock_release`, migration 0185); *when paid* is issued by a one-minute sweep because finance transactions cannot run after-commit work; *at delivery or collection* follows the stock module's own issue moment (unchanged); a hold of a document the company's settings govern does not lapse | Decisions accepted 2026-11-16 |
| **S-1c** (built) | **Sales Orders** screens: list, editor with packages and credit position, the place action, nav and permissions. No on-account payment: the writer turns it into a credit sale, so it belongs to Credit Sales; credit comes from the customer's account | The staff order; closes the packages gap |
| **S-1d** (built) | `sales_order` registered as a package document type in the shared test (migration-free); `orders.source_quote_id` (migration 0186, existing converted quotes backfilled) set when a quote becomes an order; a *Related documents* panel on an order's details (the quote it came from, its invoices; deliveries and credit notes keep their own panels) and *Became the order* on the quote | |
| **S-2** (built) | **Sales Invoicing**: invoice list and detail, raise for a whole order, send again, download, statuses, payments and credit notes shown. No new columns: signing status is the latest event of the signing log, payment is the order's payment status, credited is the sum of credit notes against the invoice, all read when listed; the *read*, *create* and *send* permissions are as designed | Screens over what exists |
| **S-3** (built) | **Sales Invoices (direct)**: *New sales invoice* on the Sales Invoices screen, with the editor of sales orders and the company's settings for the `sales_invoice` kind. The sale is an order record with sales module `sales_invoice` (so pricing, stock channel, KRA signing switch and approval all key off it); the tax invoice is made with it; the ledger carries the receivable under the credit-days rule. `sales_invoice` is an approved sales module and is registered as a package document type in the shared test. When approval holds it, the invoice is made automatically once it is approved, by a setting that is on by default (`invoiceAfterApproval`, kept on the order as `invoice_when_approved`, migration 0187), or staff raise it from Sales Invoices when the company turns that off | Builds on S-1 and S-2 |
| **S-4** (built) | **Credit Sales** screen (`/admin/credit-sales`, permissions `credit_sales:read` and `create`): the editor of sales orders in its credit sale form, account customers only, the position shown, no payment to choose, placed as an order on account (the order writer makes that a credit sale), invoiced at once, falling due on the customer's days, with the company's settings for the `credit_sale` kind. *Credit hold with release* is the approval workflow on `customer.overCreditLimit` (the approval engine already supported it; no new engine). Registered as a package document type in the shared test. The list also shows shop orders paid on account, since the order writer marks them the same | Builds on S-1 and S-2 |
| **S-5** (built) | **Shifts and tills**: registers (`registers`, Settings, Registers), open with a counted float, cash in and out with reasons, X report, close with a counted declaration, difference and reason, supervisor rule, gap-free Z numbers (`z_report` kind) and Z report; `shifts`, `shift_movements`, `shift_settings` (migration 0188) with a trigger that refuses any change to a closed shift or to a movement. Differences from the first design: a difference beyond the tolerance is closed by someone holding `shifts:supervise` rather than through the approval engine (simpler, no extra workflow to configure), and the difference is recorded on the shift but **not yet posted to the books through the finance cash count** (follow-up S-5b). The cash sales line is nothing until Cash Sales (S-6) records against a shift | Required before any cash sale |
| **S-6** | **Cash Sales**: counter screen inside an open shift, tenders and change, receipt on the fiscal series, atomic with stock | Needs S-5 |
| **S-7** | Receipt reprint and the shift's sales list; void by return | Voids need the returns flow (blueprint Phase 3); reprint first |
| **S-8** | **Where it is offered** per package and product by document type | The "channels" item |
| **S-9** | Partial billing, billing per delivery, billing plans | Blueprint Phase 2; own design |
| Later | Offline selling, omnichannel sourcing, returns at the till | Blueprint Phase 4 |

**Blueprint exit gates apply to every slice** (blueprint section 14), which the first draft of this document left out: unit tests on domain logic, contract tests on ports, property tests on state machines, a browser test of the flows, a **load test at twice peak against the targets of blueprint section 2** (placing a sales order and completing a cash sale each have a p99 target), a **migration rehearsal on a production-sized copy**, and updated runbooks. Every placing command (order, invoice, cash sale, shift open and close) carries an **idempotency key** so a retried request never doubles a sale (blueprint 4.3), and a document that two people can change carries an **optimistic `version`** (blueprint 4.5).

Each slice follows the standing rules: server-side validation and permissions, non-blocking pages, shared Autocomplete pickers, the full test pyramid, ESLint and types clean on touched files, implementor guide in the same change, SEO registry entries for each new navigation sub-module, and no database drops or pushes.

## 11. Decisions needed (my recommendation first)

1. **Sales Orders place immediately; drafting is the quote's job.** Recommended. The alternative, a draft order stored before placing, adds a second draft concept and a release step for little gain.
2. **Order types are a typed registry in code; their behaviour is configuration (changed by the owner on 2026-11-16).** The registry holds the types, options and defaults; companies change behaviour in Settings (section 4.6), as the blueprint's P9 asks. Company-defined new types (rush, contract) remain out of scope.
3. **Cash Sales need shifts. Decided by the owner (changed from my recommendation).** Shifts, registers, float, X and Z reports and the cash declaration are built first (S-5), then Cash Sales (S-6). A cash sale is refused without an open shift.
4. **One invoice per order until partial billing.** Recommended. It matches what exists and keeps the fiscal numbering simple; billing per delivery is its own design.
5. **When is an invoice raised for a sales order?** Recommended: when staff press **Raise invoice** (usually at collection or delivery), not at placing, except credit sales, which are invoiced at once. Alternative: invoice every sales order at placing.
6. **Voiding a cash sale.** Recommended: a **return** with reason and approval (never an edit), which needs the returns flow; until it exists, the till can reprint but not void.
7. **Menu placement.** Recommended: under *Sales and Fulfillment*, after Sales Quotes: Sales Orders, Cash Sales, Credit Sales, Sales Invoices; *Customer Orders* stays as the place to process.
8. **Branch rule for staff sales.** Recommended: a person sells in their own branch only; a permission grants other branches.
9. **Credit hold with release.** Recommended: build it with Credit Sales (S-3), because a sales person who is refused at the limit needs a way to ask for an exception; the approval engine already supports the request. Alternative: keep today's refusal and let the customer's limit be raised by finance.

10. **Approval of a direct sales invoice** is the type's **Approval** setting (default *by the company's workflows*, like a sales order).
11. **Stock for a direct sales invoice (decided by the owner as a setting).** The type's **Stock release** setting chooses *when issued*, *when payment is received* (always hold until paid) or *at delivery*; a document may carry its own **Hold until paid** switch where allowed. "Stock leaves" means the reservation becomes an issue: on-hand falls and the `stock_issued` stage is recorded.
12. **Accounting of a direct sales invoice.** The general ledger already posts a credit invoice as a receivable (`sales-posting-service`); a direct sales invoice needs the same entry (receivable against sales and tax) with the receipt clearing it. To be confirmed against the posting setup in S-3, and the customer's group posting rules apply.
13. **Variance tolerance and supervisor approval at shift close.** Recommended: a company-set tolerance (an amount and a percentage); within it a reason is enough, beyond it a supervisor must approve through the approval engine.
14. **One open shift per person, one per register.** Recommended: yes, so every sale has exactly one shift and one till.

Decisions 1 to 9 were approved as recommended by the owner on 2026-11-16, except 3 (above). Decisions 10 to 14 are new and open.

## 12. Not in scope

Returns and credit-memo requests (blueprint Phase 3, except that a signed invoice is already corrected by credit note), warehouse picking depth (Phase 5), consignment, drop-ship and intercompany order types, billing plans and milestones (S-9), offline selling, customer-facing self-service invoices, and any change to how the web shop checks out.

## Appendix: how much of the sales order blueprint this document draws on

The blueprint has 14 numbered sections. Counting honestly by section, this document **builds on 2 substantially, 5 partly, refers to 2 without drawing on them and does not draw on 5**: roughly a quarter to a third of the blueprint by section count, and less by depth. It is the front-of-house slice of Phases 1, 2 and 4, not the whole of them.

| Blueprint section | Used here | What was taken, and what was not |
|---|---|---|
| 1 Principles P1 to P10 | Partly | P1 (explains itself), P2 (one door), P3 (state machine through the stage timeline), P6 (side effects never block) and P7 (money) are followed. **P4, P5, P8, P9, P10 were not drawn on explicitly**; the exit gates and idempotency keys above now bring in P5 and P10 |
| 2 Capacity and SLOs | Now, partly | The first draft ignored it; the exit gates now name it, but **no p99 targets are written for these screens yet**: to be set from blueprint section 2 in each slice |
| 3 Architecture patterns | Referenced | Inherited (modular monolith, outbox); not restated |
| 4 Kernel (decision log, state-machine kit, outbox, numbering, concurrency, money, currency) | Partly | Existing numbering kinds, decision log and stage writer are reused; **idempotency keys and optimistic versions** were missing and are added above; multi-currency not addressed |
| 5 Approvals | Partly | The existing engine is used; `sales_invoice` joins the approved modules (decision 10); no new approval design |
| 6 Sales domain | **Substantially** | 6.1 document flow, 6.2 order types (as a typed registry in code, a deliberate deviation from "a table"), 6.5 the pipeline (as already built in the writer), 6.6 quote to order. **Not drawn: 6.3 partners (sold-to, ship-to, bill-to, payer) and schedule lines (partial delivery, backorder), and 6.4's separate credit, delivery, billing and block statuses** |
| 7 Inventory | Not drawn | Stock per location and availability outcomes (confirm, partial, backorder, substitute) are not designed here |
| 8 Fulfilment and warehouse | Not drawn | Picking, packing and goods issue are Phase 2 and 5 |
| 9 Billing, receivables, fiscal | Partly | The invoice as a document apart from the order, fiscal numbering and signing, receipts and credit notes. **Deferred: billing per delivery and plans (S-9), dunning, write-offs** |
| 10 Returns | Referenced | Only as the dependency of voiding a cash sale |
| 11 POS and omnichannel | **Substantially (now)** | Shift, float, tender types, cash declaration, X and Z reports, variance with reason and supervisor override, cash sale atomic with receipt. **Not drawn: offline mode, returns at the till, omnichannel sourcing** |
| 12 Experience principles | Not drawn | Not applied explicitly; the standing UX rules of the project apply to every screen |
| 13 Traceability matrix | Not used | Should be extended with the rows for these documents when the slices are built |
| 14 Delivery plan and gates | Partly | Slices are drawn; **the exit gates (load test at 2x peak, migration rehearsal, runbooks) were omitted in the first draft and are now stated** |
