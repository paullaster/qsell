# Partial billing: invoicing part of an order (S-9)

**Status:** decisions taken 2026-11-18; **built** (B-0..B-4) with the limits in section 8. **Owner:** Selling documents (Sales Orders, Sales Invoicing), with Credit notes and KRA signing as users of it.

## 1. Why

Today an order has one tax invoice for the whole order. Real sales are delivered and invoiced in parts: a customer orders 100 chairs and 5 desks, 40 chairs go out this week, the rest next month, and each supply needs its own tax invoice. This slice lets a company invoice **part of an order, by quantity**, with each part a full fiscal document (its own number, its own signing, its own PDF), until the order is invoiced in full.

It is **off by default** and turned on and off only through its own setting, behind its **own permission** (`partial_billing:manage`), which no other permission includes, so a company decides deliberately who may change how it invoices.

## 2. The setting

`billing_settings` (company, `partial_billing` on/off, version, updated by and at). Changed in *Settings → Partial billing* with a **reason**, recorded in the decision log (who, from what, to what, why), refused for anyone without `partial_billing:manage`. Reading it needs no special right (the order screens must know), but nothing except that permission can change it.

| State | What staff can do |
|---|---|
| Off (default) | An order has one tax invoice for the whole order, exactly as today. |
| On | On a sales order that is not yet invoiced, staff choose **Invoice the whole order** (as today) or **Invoice part of the order** (lines and quantities). Once an order has a part invoice, the way to finish it is **Invoice what is left**. |
| Turned off while orders are part-invoiced | No new part invoices; **Invoice what is left** stays available for orders already started, so nothing is stranded. Existing part invoices are untouched. |

## 3. Rules (pure module `domain/partial-billing.ts`)

- Applies to **sales orders** (staff orders invoiced later). A credit sale or a direct sales invoice is invoiced with the document; a cash sale is its own receipt; the web shop invoices in full.
- A part invoice has **at least one line**; each line is an order line and a **quantity** greater than nothing and at most what is **left to invoice** (ordered, less already invoiced), in the unit the line was sold in (decimals only where the product allows them).
- **Amounts are the order's own**: a line's unit price and tax rate as the order was priced, so the part invoices of an order add up to the order's total **to the cent**: the last part absorbs the rounding.
- **The delivery charge** is billed once: on the part invoice where the person ticks *Include the delivery charge*, which is offered until it has been billed (and is billed by *Invoice what is left* if it has not been).
- A part invoice can only be raised on an order that is **approved** and not cancelled, like any tax invoice.
- **Never both**: an order with a whole-order tax invoice takes no part invoice; an order with part invoices refuses the whole-order invoice ("invoiced in parts: invoice what is left").
- Part invoices are **numbered in order for the order** (1, 2, 3) and from the same gap-free tax-invoice series as every other tax invoice (one legal sequence).

## 4. Fiscal and corrections

- **Each part is signed on its own** under the company's KRA rules, as its own source (like the delivery invoice already is), with its own log and status; the order's own KRA status follows the most recent signing result.
- **A credit note is issued against one part invoice** and can only credit that invoice's lines and amounts; the credit note's original-document key is that invoice's. Returned goods, restock, refund and the books follow the existing credit-note flow unchanged.
- An invoice is never edited: a correction is a credit note, then (if needed) another part invoice for the same lines.

## 5. Data

`order_billings` (id, company, order, **sequence** per order, invoice number, document id, goods, tax, delivery, total, delivery included, KRA status, created by and at; unique on order and sequence; unique invoice number). `order_billing_lines` (billing, order line, product, description, quantity, unit price, net, tax, gross, unit as sold). A database trigger refuses any change to a billing or its lines (they are documents). Indexes: billings by order; lines by billing and by order line (to sum what is invoiced per line in one query).

## 6. Screens

- *Settings → Partial billing*: the switch, its reason, who changed it last.
- *Sales Orders*, the order's documents panel: shows **invoiced and left** per line, the part invoices with their numbers and signing status, and (when on) **Invoice part of the order** (quantity per line, include delivery, a preview of the amounts) and **Invoice what is left**.
- *Sales Invoicing* lists part invoices like any invoice, with their order and sequence.

## 7. Slices

| Slice | What |
|---|---|
| **B-0** | The setting, its permission, its screen, decision log; pure rules and their tests |
| **B-1** | Data (migration), the service that raises a part invoice (numbering, amounts that add up, the guard against double invoicing), the PDF of a part |
| **B-2** | KRA signing of a part on its own |
| **B-3** | Credit notes against a part invoice |
| **B-4** | The order screen: invoiced and left, Invoice part, Invoice what is left; the invoice lists; implementor guide; browser test |

## 8. Not in scope

Billing plans and milestones (a fixed schedule of invoices by date or percentage), billing in advance of the order, invoicing a part of one line's *amount* (not quantity), and merging several orders into one invoice.

## 9. As built

- Setting: `billing_settings`; permission `partial_billing:manage` (seeded to the Admin role like any other, assignable to anyone, held by no other permission); screen *Settings → Partial billing* with a reason; every change in the decision log.
- Data (migration 0202): `order_billings`, `order_billing_lines`; triggers refuse any change to a part invoice or its lines (only the KRA status is written, by signing). Each part also has an `invoice_documents` row of type `tax_invoice_part` (`meta.billingId`), so it appears in Sales invoices and in the order's related documents.
- Rules: `domain/partial-billing.ts` (pure). The part invoices of an order add up to its total and tax to the cent: a line finished by an invoice takes what is left of its amount, and the invoice that finishes the goods takes the rest of the order's total (the delivery charge, rounding) and the rest of its tax. The order row is locked while an invoice is made, so concurrent invoices cannot take the same units.
- PDF: `InvoiceService.generatePartPdf` from the saved billing. Signing: `DocumentSigningService.processOrderBillingDocument` (source `order_billing`; the finishing part carries the delivery charge as the delivery service item, as a whole invoice does). Credit notes: `CreditNoteService` takes an optional `billingId` (document key `order_billing:<id>:tax_invoice`); an order invoiced in parts refuses a credit against the whole.
- Limits of this release: orders whose delivery is billed on its own invoice are invoiced in one piece; emailing a part invoice again is not offered (PDF only); the delivery charge carried by the finishing part cannot be credited by itself; billing plans and milestones remain out of scope.
