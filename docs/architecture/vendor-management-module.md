# Vendor Management and Accounts Payable — Module Design (F-7)

**Owner:** two modules that share one set of records.
**Vendor Management** (a new top-level sidebar module, "Vendor Management") owns everything about *who we buy from and how we buy*: vendor accounts and the vendor portal, onboarding and profile, prequalification, requests for quotation (RFQ), purchase orders, received goods notes and the processing of supplier invoices.
**Accounts Payable** (the existing Finance sidebar module, sub-module "Accounts Payable", already reserved in `core-finance-module.md` §6a) owns *what we owe and how we pay it*: vendor posting groups, the vendor ledger, posted purchase invoices and credit memos, advance payments, payment vouchers, payment proposals and batches, vendor statements and ageing, withholding tax, and every posting to the general ledger.

The rule that divides them: **Vendor Management decides that a supplier invoice is good; Accounts Payable books it and pays it.** A supplier invoice is a Vendor Management document until the moment it is *posted*; from then on it is a vendor ledger entry owned by Finance, and Vendor Management can only read it.

**Status:** APPROVED 2026-10-23 (your answers are recorded in §24.3, and slice V-0 is approved to start). **Nothing here is built yet.** The document is the contract for the slices in §22; each slice adds an "as built" note at the end when it is done. Section 24 lists the readings I made of your brief and your answers. Part of the Core Finance design ([core-finance-module.md](core-finance-module.md), §6a, §15 slice F-7) and the Sales Order Platform ([sales-order-blueprint.md](sales-order-blueprint.md)).

**Goal:** a procurement-to-payment system with the discipline of Microsoft Dynamics 365 Business Central (vendor card, vendor posting groups, purchase quote → order → receipt → invoice → payment, vendor ledger and detailed vendor ledger, payment proposals, prepayments), plus what Business Central does not ship: a vendor self-service portal, vendor onboarding with prequalification, sealed RFQ rounds with a revision loop, and a supplier-invoice workflow in which the *vendor* creates the invoice and our staff process it. Everything configurable is data, nothing national is hard-wired.

---

## 0. How to read this document

* §1 principles; §2 what Business Central does and what we keep, change and improve.
* §3 the end-to-end flow on one page; §4 how the two modules divide the work.
* §5 identity: how a vendor has an account and logs in. §6 vendor lifecycle and profile. §7 prequalification. §8 RFQ. §9 purchase orders and advance payment. §10 received goods notes. §11 supplier invoices (the longest section, with the complete state machine). §12 Accounts Payable.
* §13 the posting recipes (every journal, line by line). §14 permissions. §15 data model. §16 screens. §17 security and fraud controls. §18 approvals. §19 numbering. §20 notifications. §21 where this fits the code that exists.
* §22 delivery plan and exit gates. §23 what I will not promise. §24 readings, decisions and open questions.

Words used the same way everywhere: **vendor** (Business Central's word; "supplier" is shown wherever your brief used it, and the two are one thing), **staff** (people with a back-office role, `roles.is_staff`), **portal user** (a person who logs in to the vendor portal), **stage** (a named step in the supplier-invoice workflow), **document** (anything that has a number, a state and a history).

---

## 1. Principles

1. **One engine.** Every posting goes through `src/server/domains/finance/engine.ts`, the only writer of ledgers (core-finance §3). Vendor Management never writes a ledger row and never posts.
2. **Immutable once posted.** Posted purchase documents, vendor ledger entries and detailed entries are append-only (database triggers, as for customers). A mistake is corrected by a reversal or a credit memo with a reason, never an edit.
3. **State machines, not flags.** Every document has an explicit state machine (kernel state-machine kit), with the allowed moves, who may make them, and what each move writes. An impossible state cannot be stored: constraints and keys, not only the UI.
4. **Vendors are untrusted input.** A portal user is a stranger holding a login. Everything they send is validated on the server; every query is scoped by the `vendor_id` taken from the *session*, never from the request; they can never see another vendor, another vendor's quote, a price they were not invited to bid on, or an internal note.
5. **Segregation of duties is data.** The person who creates a purchase order cannot approve it; who approves an invoice cannot pay it; who changes bank details cannot approve the change (§17). Enforced by the same rule shape as refunds (`approver ≠ requester ≠ payer`).
6. **Every action has its own permission** and a full who / what / when / why / from-where trace (decision log + document history), as everywhere else (core-finance §12–13).
7. **No secrets in env; sealed in the database** (core-finance §16). Vendor bank details are sealed at rest and masked on screen; the full number is shown only to the person holding the permission, and every view is logged.
8. **Reuse before inventing.** Numbering (`DOCUMENT_KINDS`), approvals engine, reason codes, dimensions, units of measure, taxes, currencies and rates, payment methods / bank accounts / providers, bank payment files, the media store, the outbox, and the lookup and Autocomplete machinery are all used as they are. New parallel versions are a defect.
9. **Project rules apply to every screen:** server components by default, no logic in components, Autocomplete (never `<select>`) with server search, non-blocking parallel loading, 390 px to desktop with no sideways scroll, 40 px touch targets, labelled and keyboard-operable, real 404 behaviour through `MissingAs404`, ESLint 10.12 clean, and the full test pyramid (unit, integration, API, e2e) with each slice. See `docs/PROJECT_RULES.md`.

---

## 2. What Business Central does, and what we keep, change and improve

| Business Central | What it is | Our equivalent |
|---|---|---|
| **Vendor card** (General, Address & Contact, Invoicing, Payments, Receiving, Foreign Trade) | The vendor master record. Blocked = none / payment / all. | `vendors` (§15), with the same three blocks and the same sections. **Improved:** the vendor fills most of it themselves in the portal; staff verify. |
| **Vendor Posting Group** | Which accounts a vendor's payables, discounts, rounding and FX post to. | `vendor_posting_groups` + the general posting setup (§13), same shape as customer posting groups. |
| **Vendor Bank Account** | Payee details. | `vendor_bank_accounts` with change control (§17.2). BC lets anyone with edit rights change them; we do not. |
| **Contacts** | People at the vendor. | `vendor_contacts` (named person, role, phone, email, can-log-in flag). |
| **Purchase Quote → Purchase Order** | BC has a single "purchase quote" per vendor and a *Make Order* action. No bid comparison, no portal. | **RFQ** (§8): one request, many invited vendors, a sealed round, a comparison sheet, a revision loop, award, then *make order*. |
| **Purchase Order** (header + lines, Release, Reopen, Prepayment %) | The commitment. | `purchase_orders` (§9), same release/reopen idea, versioned amendments, approval, and the advance-payment rule you described. |
| **Purchase Receipt (posted)** | Received goods against a PO line, partial receipts allowed. | **Received Goods Note** (RGN, §10), immutable once posted, partial receipts, acceptance and rejection per line. |
| **Purchase Invoice (posted) / Credit Memo** | The vendor's bill; matched to receipts; posts to payables. | **Supplier invoice** (§11) is the vendor's own submission, processed by staff, then **posted purchase invoice** (§12). |
| **Vendor Ledger Entry / Detailed Vendor Ledger Entry** | The sub-ledger: open items with remaining amount; every application, discount, FX difference as a detailed row. | `vendor_ledger_entries` / `vendor_detailed_entries`, exact mirrors of the customer tables (core-finance §3.2–3.3). |
| **Payment Journal, Suggest Vendor Payments, Payment Proposals, Payment Export** | Build a batch of due invoices, review, export a bank file or send electronically. | **Payment voucher** and **payment proposal → batch** (§12.5–12.6) reusing the bank-file generator and the M-Pesa disbursement path already built. |
| **Prepayment invoice / % on PO** | Pay part up front; later invoice deducts it. | **Advance payment document** (§9.4), linked to the PO and to the payment voucher; applied against the final invoice. |
| **Approval workflows** | Approve PO, invoice, payment. | Our approvals engine with new triggers (§18), versioned workflows, escalation. |
| **Item Vendor Catalog / Vendor Item No.** | A vendor's own code and lead time per item. | `vendor_items` (vendor's own item number, lead time, minimum quantity); fed by accepted quotes. |
| **Vendor Statistics, Ageing, Statement** | Reports. | §12.8. |
| **(Not in BC)** Onboarding, prequalification, portal, sealed RFQ rounds, vendor-created invoices | Partner add-ons only. | Built in, §5–8, §11. |

**What we deliberately improve on Business Central:**

* **Matching is visible and tolerance-based.** BC posts and shows a difference; we hold an invoice at the *match* stage until quantities, prices and tax agree with the PO and RGN, or a permitted person overrides with a reason (§11.6).
* **Duplicate invoices are blocked at the door** (vendor + vendor's invoice number must be unique, case- and spacing-insensitive), not warned about afterwards.
* **Bank-detail changes are a controlled event**, not a field edit (§17.2). The single largest payables fraud is a changed account number.
* **Recall and return** (your brief) give both sides a safe way to correct an invoice before it is booked, with a reason on every move.
* **One audit trail** across RFQ, PO, RGN, invoice and payment: from any payment you can walk back to the invoice, the RGN lines, the PO, the winning quote, the RFQ and the prequalification of that vendor.

---

## 3. The whole flow on one page

```
 Vendor registers ──► completes profile ──► applies for prequalification (per category) ──► approved / rejected (reason) / revision asked
                                                                                                  │
 Admin creates RFQ for a category ──► (approval) ──► invites qualified vendors ──► vendors quote (sealed) ──► deadline
                                                                                                  │
        revision requested ◄─────────────── evaluation (comparison sheet, scores) ───────────────► reject (reason)
                                                                                                  │ award
 Purchase order (draft) ──► approval ──► released ──► sent to vendor ──► vendor confirms
        │  flagged "requires advance payment"?                                                    │
        └─► advance payment document ──► approval ──► payment voucher (linked) ──► paid           │
                                                                                                  ▼
 Goods arrive ──► RGN (accept / reject per line, vendor delivery note no.) ──► stock in at PO cost, books: Dr Inventory / Cr Stock received not invoiced
                                                                                                  │
 Vendor (portal) creates supplier invoice ──► draft ──► submit  (can close while draft; can recall until staff act)
        │ attaches its own invoice document and delivery notes (with its delivery-note numbers)
        ▼
 Staff: received ──► STAGE 1 link RGN(s) / delivery note(s) ──► match (3-way) ──► approval ──► post
        │ (staff may return it to the vendor, with a reason, at any point before it is posted)
        ▼
 Posted purchase invoice = vendor ledger entry: Dr Stock received not invoiced (+ variance, + input VAT), Cr Payables
        ▼
 Payment proposal ──► batch ──► approval ──► payment voucher(s) ──► bank file / M-Pesa ──► bank statement match ──► closed
```

---

## 4. How Vendor Management and Accounts Payable divide the work

| Concern | Vendor Management | Accounts Payable (Finance) |
|---|---|---|
| Vendor master (profile, business, contacts, documents) | **Owns** | Reads; owns only the *financial* part (posting group, payment terms, payment method, bank accounts, tax/withholding settings, block status for payment) |
| Prequalification, categories, evaluation | **Owns** | — |
| RFQ, quotes, award | **Owns** | — |
| Purchase order | **Owns** (commitment); advance flag set here | Sees commitments in the payables outlook |
| Advance payment document | Requests it | **Owns** the document, approval and payment |
| RGN | **Owns** (the receiving staff) | Reads; the posting it causes is Finance's |
| Supplier invoice, up to *approved* | **Owns** | — |
| Posted purchase invoice, credit memo, vendor ledger | Reads | **Owns** |
| Payments, proposals, batches, statements, ageing, WHT | — | **Owns** |

Sidebar:

* **Vendor Management**: Vendors, Applications (prequalification), Categories & prequalification areas, RFQs, Quotes comparison, Purchase orders, Received goods, Supplier invoices, Vendor documents (expiring), Vendor settings.
* **Finance → Accounts Payable**: Vendor ledger, Purchase invoices (posted), Credit memos, Advance payments, Payment vouchers, Payment proposals, Payment batches, Ageing, Vendor statements, Withholding tax, Payables reconciliation, Vendor posting groups.

---

## 5. Identity: a vendor has an account and can log in

### 5.1 Account type

The `users` table already carries `role` (`customer` by default) and the access-control engine decides staff by `roles.is_staff`. A vendor portal user is a user whose **primary role is `vendor`**, a built-in non-staff role seeded like `customer`. Consequences, all already enforced by the existing code: a non-staff role cannot enter `/admin` (`proxy.ts` and the session `isStaff` flag), the session refuses an unverified email, and the 60-second staff revalidation does not apply.

New, and only for vendors:

* A new route group `/vendor` (the portal) with its **own proxy matcher** (`/vendor/:path*`) that admits only a session whose role is `vendor` **and** whose user is linked to an active `vendor_users` row. Staff are never sent into `/vendor`; a vendor is never sent into `/admin`.
* The session carries `vendorId` and `vendorUserRole`, read from the database at sign-in and **revalidated every 60 seconds like staff** (a suspended vendor or removed portal user loses access within a minute, not after the 30-day token).
* Portal users cannot hold staff permission grants. Their abilities are a fixed capability set (§5.3) kept in the vendor tables, not in the staff RBAC tables, so a mistake in role setup can never give a vendor a back-office permission.

### 5.2 How an account comes into being

Two routes, both ending with the same record:

1. **Self-registration** at `/vendor/register` (business name, contact person, email, phone, password). Rate-limited, email verification required before sign-in (existing flow), the vendor lands in status `registered`. No category, RFQ or pricing is visible until the profile is complete and approved (§6.2).
2. **Invitation** by staff with `vendors:invite`: a single-use, expiring (7 days) link carrying a hashed token; the vendor sets a password and lands in status `registered` with the invited category pre-selected. Used to bring a known supplier in quickly; it does not skip the profile or the prequalification.

A vendor *business* has one `vendors` row and many `vendor_users` (the portal users). The first user is the **owner**. The owner can invite colleagues.

### 5.3 Portal capabilities (fixed; per portal user)

| Capability | Owner | Finance | Sales | Read-only |
|---|---|---|---|---|
| See and edit profile, business, financial, contacts, documents | ✔ | financial + documents | contacts + documents | view |
| Apply for prequalification | ✔ | — | ✔ | view |
| Quote on RFQs | ✔ | — | ✔ | view |
| Create and submit supplier invoices | ✔ | ✔ | — | view |
| Change bank details (starts the change-control flow) | ✔ | ✔ | — | — |
| Invite or remove portal users | ✔ | — | — | — |

Staff can see which portal users did what (every portal action is attributed to the portal user, never to the business).

### 5.4 A vendor can also be a customer

`vendors.customer_id` is an optional link to `customers`, so a business that both buys from and sells to us is one party in reports and can be netted later (contra). Nothing in V-0 to V-7 depends on it.

---

## 6. Vendor lifecycle and the profile

### 6.1 The profile is five sections, each with its own completeness

After the first sign-in the dashboard shows a checklist; each section is `not_started`, `draft` or `complete`, and the vendor cannot apply for prequalification until the required sections are `complete`.

| Section | What the vendor provides | Notes |
|---|---|---|
| **Vendor profile** | Legal name, trading name, vendor type (company, sole trader, partnership, NGO, government body), country, year established, website, description of what they supply, physical and postal address, logo | |
| **Business information** | Registration number and date, KRA PIN (or the local tax ID; the label comes from the country pack), VAT number, number of employees, directors / owners (name, ID type, ID number, share), previous experience and references (client, value, contact), certifications (ISO etc.), licences with expiry | PIN format is checked by a pack rule, never in code |
| **Financial information** | Payment terms they offer, currency, bank accounts (bank, branch, account name, account number, SWIFT/IBAN where relevant), mobile money payout number (optional), annual turnover band, tax-exemption status, withholding certificate | Bank accounts go through change control (§17.2); the *first* account is accepted at approval, later changes are controlled |
| **Contact persons** | Named people (role: management, sales, finance, technical), email, phone, whether they have a portal login | At least one primary contact |
| **Attachments** | Certificate of incorporation, tax compliance certificate, KRA PIN certificate, business permit, bank confirmation letter, ID copies, CVs, company profile, insurance, anything the admin marks required | Each file has a *type*, an issue date and an **expiry date**; types and which are required are admin data (§6.4) |

The vendor can save a section as a draft, leave, and come back. **Submit profile** is one action once all required sections are complete; it freezes the submitted version (`vendor_profile_versions`) and puts the vendor in review.

### 6.2 Vendor state machine

```
registered ──► profile_in_progress ──► profile_submitted ──► under_review ──┬─► active
                       ▲                                                     ├─► revision_requested ──► (vendor edits) ──► profile_submitted
                       └─────────────────────────────────────────────────────┴─► rejected (reason, may re-apply after a set period)
active ──► suspended (reason, reversible) ──► active
active ──► blocked_payment | blocked_all  (BC's Blocked field; reason)
any ──► archived (only when nothing open; keeps history)
```

* **Active** means the profile is verified. It does *not* mean prequalified; prequalification is per category (§7). A vendor with no approved category can log in and keep the profile current but sees no RFQs.
* `blocked_payment`: invoices can be received and posted, payments are refused. `blocked_all`: no new documents of any kind (BC's *All*). Both need a reason and `vendors:block`.
* A changed **legal name, tax ID or registration number** on an active vendor sends the vendor back to `under_review` for that change (a versioned diff), without losing access.

### 6.3 What staff do

* **Review** the submitted version section by section: accept, or *request revision* on a section with a comment (the vendor sees exactly which section and why), or reject the whole application with a reason code (reason codes kernel, `vendor_rejection`).
* **Verify** each attachment (valid / not valid / expired) and record the verification date and person. A tax-compliance certificate with an expiry date feeds the expiry job (§6.5).
* **Create a vendor directly** (a walk-in supplier or a migration): the same vendor row, status `active` at once but only by `vendors:create_active`, and it is flagged `created_by_staff` so reports can tell.
* Assign a **vendor number** from the number series (§19) at approval, not at registration (a registration is not a vendor yet).

### 6.4 Configuration as data (admin, `vendor_settings:manage`)

* **Vendor types**, **document types** (name, required for: all vendors / by type / by category, whether an expiry date is required, reminder days before expiry), **business sections** and their required fields, **reference checks**. A country pack can add a PIN pattern and labels.
* **Rejection and revision reason codes.**
* **Payment terms** and **vendor posting groups** (§12.1) offered as defaults to new vendors.

### 6.5 Expiry job

A daily worker job (`vendor-document-expiry`) marks an attachment `expired` the day after its expiry date, emails the vendor (and the responsible staff) at the configured reminder days (30 / 7 / 0), and, if the document type is configured *blocking*, moves the affected **category prequalification** to `suspended_documents` until the vendor uploads a fresh one (§7.5). An expired document never silently leaves a vendor trading.

---

## 7. Prequalification

### 7.1 Categories and areas (created by staff with `prequalification:manage`)

* A **procurement category** is the thing a vendor is qualified *for* (e.g. "Office stationery", "Solar panels and inverters", "Civil works up to KES 5M"). Categories form a tree (`parent_id`); an RFQ is raised for one category, and only vendors qualified in it (or a child) can be invited.
* A category may be linked to **product categories** and **item types** already in the catalogue, so a PO line can suggest its category, and to an optional commodity code (UNSPSC or other, as data).
* **Prequalification area** = a category plus its **requirements**: required document types, a **questionnaire** (typed questions: yes/no, number, text, choice, file), a **scoring scheme** (weight per question, pass mark) or *pass/fail only*, **validity** (months a qualification lasts), and the **application window** (open from / to, or always open).
* States of a category: `draft` → `open` (vendors can apply) → `closed` (no new applications; existing qualifications stand) → `archived`.

### 7.2 Application (the vendor, in the portal)

The vendor sees the open categories, picks one or more, answers the questionnaire, attaches the evidence, and submits. **A vendor can select several categories (specialisation areas) in one application.** The application is one submission with one questionnaire section per chosen category (shared answers such as company profile are asked once); each category is **decided separately**, so a vendor can be approved for two categories, asked to revise a third and rejected for a fourth, and each has its own validity, conditions and renewal. A vendor can also add categories later by a new application. At most one live application per vendor per category per round.

```
draft ──► submitted ──► in_review ──┬─► approved (valid until …)
   ▲                                ├─► revision_requested (comment; new due date) ──► (vendor edits) ──► submitted
   │  vendor may withdraw           └─► rejected (reason code + comment; may re-apply after N days)
   └─ withdrawn (vendor, any time before a decision)
approved ──► expired (validity ended) ──► (renewal = new application, answers pre-filled)
approved ──► suspended (documents expired, or staff, with reason) ──► approved
approved ──► revoked (staff, reason; permanent for the round)
```

### 7.3 Evaluation (staff)

* The application is assigned to one or more **evaluators** (people with `prequalification:evaluate`). Each scores the questions and writes a comment; the system totals the weighted score against the pass mark; the **decision** is a separate action by someone with `prequalification:decide`. Evaluator ≠ decider where the category is flagged "four eyes" (default on).
* A category can require **approval** by the approvals engine (trigger `vendor.prequalification`, §18); the decision is final only after approval.
* **Decision is explained**: approve (with validity and any conditions, e.g. "up to KES 2M per order"), reject (reason), or ask for revision. What the vendor sees of an evaluation is **configurable** (`vendor_settings:manage`, per category, with a company default): the decision and the reason are always shown; the vendor's own total score, the pass mark, the per-question scores and the evaluators' comments are each a switch, off by default. Other vendors' results are never shown.

### 7.4 What qualification gates

* **RFQ invitations** can only go to vendors with an `approved`, unexpired qualification in the RFQ's category (§8).
* **Purchase orders** can only be raised to a vendor qualified in the order's category (a permitted person may override once, with a reason, for emergency purchases; the override is reported).
* Condition limits (a maximum order value) are checked at RFQ award and PO release.

### 7.5 Suspension by documents

A required document type marked *blocking* for a category and then expiring moves that qualification to `suspended` automatically (§6.5); uploading a verified replacement restores it with no staff action, and the history records both moves.

---

## 8. Requests for quotation (RFQ)

### 8.1 Why not Business Central's quote

BC's purchase quote is one document to one vendor. A real tender is one request to many vendors, answered in confidence, compared, negotiated, and only then ordered. We model that, then convert the winning lines to a purchase order exactly as BC's *Make Order* does.

### 8.2 The RFQ document

* **Header:** number, title, category, description and terms, delivery location (branch), required-by date, **quotation deadline**, validity required (days a quote must hold), currency (or "vendor's currency, converted for comparison"), visibility (*sealed*: staff cannot open quotes before the deadline), evaluation method (lowest total, lowest per line, weighted score), whether **partial quotes** and **alternative offers** are allowed, attachments (specifications, drawings, conditions), responsible buyer, branch and dimensions.
* **Lines:** product (or a free description for non-stock goods and services), quantity and unit (units-of-measure module, decimals respected), specification text, required delivery date, and for services a scope. A product line reuses the catalogue so the PO line later carries the product, unit and cost correctly.
* **Invited vendors:** a list drawn only from vendors qualified in the category (the picker is a server-side Autocomplete limited to them). A vendor not invited cannot see or find the RFQ.

### 8.3 RFQ state machine

```
draft ──► pending_approval ──► approved ──► issued (invitations sent; portal shows it)
   ▲            │ rejected (reason) ─► draft
   │                                   │ deadline (or staff close early, with reason)
   │                                   ▼
   │                               closed ──► evaluating ──► awarded ──► (PO created) ──► completed
   │                                   │                          │
   └── reopen/extend deadline (staff, reason; notifies all)       └─► cancelled (reason; notifies all)
issued ──► cancelled (reason)    awarded ──► (some lines re-tendered = new RFQ from selected lines)
```

* Issuing needs approval when the RFQ's estimated value exceeds the threshold in the approvals workflow (trigger `rfq.issue`, §18). Editing an issued RFQ is not allowed; a **clarification** (a numbered addendum sent to every invitee, with an optional deadline extension) is the controlled way.
* **Vendor questions** during the open window go through a Q&A log on the RFQ: the question is visible to staff only; the answer, if staff publish it, is sent to *all* invitees with the asker anonymised (fair-tender practice).

### 8.4 The vendor's side (portal) — every RFQ in every stage

The portal's *RFQs* page lists every RFQ the vendor was ever invited to, by stage, with the same words as the buyer's side:

| Vendor sees as | Meaning | What the vendor can do |
|---|---|---|
| **New** | Issued, not opened | Open, decline to bid (with a reason), ask a question |
| **In progress** | The vendor has a draft quote | Edit, attach, save draft, submit, decline |
| **Submitted** | Quote sent | View, **withdraw** while the RFQ is open (it becomes editable again), nothing else |
| **Revision requested** | Staff asked for a revision (comment, new deadline) | Edit **a new version** and resubmit; the old version stays visible, read-only |
| **Under evaluation** | Closed, being compared | View only |
| **Awarded** / **Not awarded** | Result (and reason if not awarded, as far as the buyer chose to disclose) | View; for awarded, jump to the PO |
| **Rejected** | Quote rejected with a reason | View reason |
| **Expired / Cancelled** | Deadline passed with no quote, or RFQ cancelled | View |

A quote is **versioned**: version 1 on first submit, +1 on each revision, every version immutable and visible to the vendor. Quote lines mirror the RFQ lines: unit price, quantity offered (may be less than asked when partial quotes are allowed), tax code and rate, lead time, brand/model, warranty, an alternative offer (marked as such), validity date, and a per-line **no bid**. The quote also carries payment terms offered, delivery terms, total (computed on the server from the lines, never taken from the browser), and attachments (data sheets, certificates).

### 8.5 The buyer's side

* **Receive:** sealed quotes are unreadable by staff until the deadline (a database-level `opens_at`, not a UI check); *unsealed* RFQs show quotes as they come.
* **Compare:** the **comparison sheet** (BC's "quote comparison" / tender abstract): one row per RFQ line, one column per vendor, in a common currency at the rate of the RFQ's issue date, the lowest highlighted, totals, taxes, lead times, plus evaluation scores when the method is weighted. Exportable.
* **Act on each quote:** *accept for award*, *reject with reason* (reason code + comment; the vendor is told only what the **disclosure setting** allows: the standard reason chosen by the buyer, optionally the winning price band, never another vendor's identity or prices), or *request revision* (comment, new deadline, which lines). Each is a distinct permission and a recorded event.
* **Award:** per line or whole RFQ, to one or several vendors, with a justification when the lowest is not chosen. Awarding needs approval above the threshold (trigger `rfq.award`).
* **Make order:** the award creates a **draft purchase order per awarded vendor**, lines prefilled with the quote's price, quantity, tax and lead time, linked back to the quote version and RFQ (§9). Nothing is re-typed.

### 8.6 Direct purchases without an RFQ

A purchase order can be created without an RFQ (below a configured value, or an approved single-source), but is then flagged `no_rfq` with a reason and reported. Policy is data: the threshold above which an RFQ is mandatory is a setting.

---

## 9. Purchase orders

### 9.1 The document

Header: number, vendor, vendor contact, category, RFQ and quote version (when it came from one), order date, expected delivery date, delivery branch and location, currency and rate, payment terms, delivery terms, **requires advance payment** (yes/no, with amount or percentage and a due date), buyer, dimensions, notes to the vendor, attachments. Lines: product or free text, quantity and unit, unit price, discount, tax code, line total, expected date, **received**, **invoiced** and **cancelled** quantities (maintained by RGN and invoice posting, never edited), and a line state.

### 9.2 State machine

```
draft ──► pending_approval ──► approved (released) ──► sent ──► confirmed (vendor accepts in the portal, or staff record it)
   ▲            │ rejected (reason) ──► draft
   └── reopen (before any receipt; cancels approval)
confirmed ──► partially_received ──► received ──► partially_invoiced ──► invoiced ──► closed
any open state ──► cancelled (reason; only the unreceived part if partly received) — "force close" of a short-delivered PO needs a reason
approved/confirmed ──► amendment_pending ──► approved (new version)   (§9.3)
```

A PO number is assigned when it is **approved** (a draft has a working number; a sequence of released numbers has no gaps from abandoned drafts). `trigger po.release` runs on the approvals engine; the **creator cannot approve their own PO**.

### 9.3 Amendments

After release a PO changes only through an **amendment**: a new version with a reason; if the value goes up beyond a tolerance or any price changes, it goes to approval again; the vendor must **re-confirm** in the portal. Every version is kept and the portal shows what changed. Quantities already received cannot be amended below.

### 9.4 Advance payment (your rule)

* The PO carries `requires_advance_payment`, set **only by a person with `purchase_orders:flag_advance`** and approved with the PO (changing it after release is an amendment).
* An **advance payment document** (`vendor_advance_payments`, owned by Finance, §12.4) is raised against the PO: amount (≤ PO total, as an amount or a percentage), due date, vendor bank account, reason. It has its own approval (trigger `vendor.advance_payment`) and states `draft → pending_approval → approved → paid → (applied | refunded | written_off)`.
* **The payment voucher that pays it must reference the advance payment document**; the voucher refuses to be created otherwise, and the document refuses a second voucher beyond its amount. No other way to pay an advance exists.
* **What it unlocks:** a supplier invoice that claims payment for **no delivery note at all** is accepted **only when** its PO is flagged `requires_advance_payment` **and** an advance payment document for that PO exists in state `approved` or `paid` (§11.5). Without both, such an invoice cannot be submitted, and the portal says exactly why.
* **At final invoicing**, the advance is **applied** against the vendor invoice (a detailed ledger entry, §12.2): the invoice shows "less advance paid", only the balance is payable. An advance never applied is shown on the vendor's statement and in the *advances outstanding* report.

### 9.5 What the vendor sees

Every PO sent to them: lines, terms, status, what has been received and invoiced, amendments to confirm, and a button to start a supplier invoice from it (§11.2). They cannot see other vendors' orders.

---

## 10. Received goods notes (RGN)

### 10.1 Why an RGN and not a stock adjustment

Today `InventoryService.receive` (stock in from a purchase order number typed by hand) changes the quantity and writes a movement that the finance job posts against "stock received not yet invoiced" (`2130`, `inventoryClearingAccountId`). We keep that accounting, and replace the typed-in PO number with a real document that can be matched, reversed and invoiced against.

### 10.2 The document

Header: RGN number, PO (one per RGN; a delivery covering two POs is two RGNs), vendor, receiving branch and location, received date, **vendor's delivery note number** (as printed on the physical note) and a photo or scan of it, received by, vehicle / driver (optional), notes, attachments. Lines: PO line, quantity **delivered**, **accepted** and **rejected** (with a reason code each), unit, batch / lot / expiry / serial where the product is tracked, storage location.

States: `draft → posted → (reversed)`; `draft → cancelled`. A **posted** RGN is immutable.

### 10.3 What posting does (one transaction)

1. For each accepted stock line: stock quantity goes up through `applyStockDelta` with change type `purchase_order_receipt`, `referenceId` = the RGN number, **unit cost = the PO line's net cost** (in base currency at the PO's rate; landed costs are a later enhancement, §23). The existing finance job posts **Dr Inventory / Cr Stock received not invoiced (2130)** from that movement; the RGN does not post twice.
2. For **non-stock lines** (services, expenses): a *service acceptance* line posts **Dr the line's expense account / Cr Accrued purchases**, through the posting engine, so the cost is recognised when the service is accepted and relieved when the invoice is posted (§13.2).
3. PO line `received_qty` increases; the PO state moves to `partially_received` or `received`; over-receipt beyond the tolerance (default 0 %, configurable per category) is refused unless the PO is amended.
4. Rejected quantities create a **return to vendor** record (disposition `return_to_supplier` already exists in the returns module) with no stock change and no posting.

### 10.4 Reversal and returns

A mistaken RGN is reversed (permission `rgn:reverse`, reason, only while not yet invoiced; otherwise a **purchase return** / vendor credit memo is the route, §12.3). Reversal posts the mirror movement and re-opens the PO line.

### 10.5 What links an RGN to an invoice

An RGN line is *invoiceable* up to its accepted quantity. The supplier-invoice stage 1 (§11.4) attaches RGN lines to invoice lines; each RGN line tracks `invoiced_qty`. The same RGN line can be split over several invoices, and one invoice can cover several RGNs ("demand payment for 1 or more delivery notes").

---

## 11. Supplier invoices

This is the workflow you described. A **supplier invoice** is a document the **vendor creates in the portal**; our staff process it; at the end it becomes a posted purchase invoice in Accounts Payable.

### 11.1 Two numbers, two owners

* `vendor_invoice_no`: what the vendor calls it (printed on their paper invoice). Unique per vendor, case- and space-insensitive; this is the duplicate guard.
* `invoice_no`: our own number from the number series, assigned **at submission** (a draft has none), the number staff and the vendor both quote afterwards.

### 11.2 Creating it (portal, vendor)

The vendor opens *Invoices → New*. They can start from a purchase order (recommended: lines and prices prefill from the PO and from the RGN lines still invoiceable) or, only for a vendor an administrator has marked an **approved expense vendor** (and for an advance invoice), with free lines. Fields:

* Vendor invoice number and date, due date they ask for, currency, PO(s) referenced, notes.
* **Lines:** description, PO line reference, quantity, unit, unit price, tax code (as the vendor charges it), line total. Totals (subtotal, tax, total) are **computed on the server**; the browser's sums are only a preview.
* **Their own invoice:** an attachment of the physical (paper or PDF) invoice, required to submit.
* **Delivery notes:** the vendor adds one or more delivery notes. Each has the **vendor's external delivery note number**, the date, and an attachment (signed copy). The invoice then claims payment for those delivery notes. A delivery note is matched, at stage 1, to the RGN we recorded for the same delivery (§11.4).
* A **declaration** that the invoice is for goods and services delivered (or, for an advance, for the advance claimed).

Validation at submit (server): at least one line; totals consistent; attachment present; vendor invoice number not used before by this vendor; every line either linked to a PO line *with remaining invoiceable quantity* or the buyer allows free lines; delivery notes present **unless the advance rule applies** (§11.5); currency equals the PO's; the vendor is `active`, not blocked, and (for PO-based invoices) still qualified for the category or a documented exception exists.

### 11.3 The state machine

Vendor-side states are bold; staff-side stage names are in italics.

```
                       vendor can CLOSE          vendor can RECALL
                       (drops it, terminal)      (only while untouched, §11.7)
 draft ───submit───► submitted ───────────────────────────────────────────────┐
   │  ▲                 │ staff opens the first stage                          │ recall
   │  │ edit            ▼                                                      ▼
   │  └─────────── received ──► rgn_linked ──► matched ──► pending_approval ──► approved ──► posted ──► (partly) paid ──► settled
   │                  │  ▲          │   ▲         │              │
   │                  │  │          └───┴─────────┴──────────────┴──► returned (to the vendor, with a reason)
   │                  │  └── returned invoices re-enter as `draft` for the vendor to correct, then are submitted again as the same invoice (revision n+1)
   ▼                  └─► rejected (staff, reason code; terminal; the vendor may create a new invoice)
 closed (vendor, from draft or returned, with a reason; terminal; kept for the trace)
```

| State | Who acts | Meaning |
|---|---|---|
| `draft` | vendor | Being prepared; editable; saved as often as wanted; no invoice number yet |
| `submitted` | — | Sent; a number is assigned; waiting in the staff queue; **no staff action yet** |
| `received` | staff | A staff member took it (picked up from the queue) |
| `rgn_linked` | staff | **Stage 1 done:** RGN lines and delivery notes linked (§11.4) |
| `matched` | staff / system | Three-way match passed or was overridden with a reason (§11.6) |
| `pending_approval` | approver | Waiting on the approvals engine (`vendor.invoice`) |
| `approved` | staff | Approved for posting |
| `posted` | Finance | Posted to Accounts Payable; now a vendor ledger entry. **Immutable.** |
| `paid` / `settled` | Finance | Maintained from the vendor ledger (remaining amount) |
| `returned` | staff | Sent back to the vendor with a reason and a list of what to fix |
| `rejected` | staff | Refused with a reason code (duplicate, not ours, no delivery, fraud suspicion …); terminal |
| `recalled` | vendor | Pulled back by the vendor before staff acted; the invoice is a `draft` again with a history entry |
| `closed` | vendor | Abandoned by the vendor; terminal; never deleted |

Every transition writes an **event** (who, what, when, why, from where; `supplier_invoice_events`, append-only) and, where it matters, a notification to the other side.

### 11.4 Staff processing, in order

The responsible staff member (permission `supplier_invoices:process`) sees the **Supplier invoices** queue (filter by state, vendor, age, assigned to). The lifecycle on their side **begins at `submitted`** and has these stages, in this order, none skippable:

1. **Stage 1 — link the received goods note(s).** For each invoice line, pick the RGN line(s) the line is for (a picker limited to this vendor's posted, still-invoiceable RGN lines for the referenced PO). The vendor's delivery-note numbers on the invoice are matched to the RGN's recorded `vendor_delivery_note_no`; an unmatched delivery note is flagged for the staff member to resolve (receive the goods first, or return the invoice). *Exception:* an advance-payment invoice has no RGN; its stage 1 links the **advance payment document** instead (§11.5).
2. **Match.** The system compares invoice vs PO vs RGN (§11.6). Differences within tolerance pass; beyond tolerance the invoice stays here until the vendor corrects it (return) or a permitted person overrides with a reason.
3. **Approve.** The approvals engine (`vendor.invoice`): thresholds by amount, by category, by branch, escalation on overdue, creator-of-the-PO cannot approve.
4. **Post.** One action (`purchase_invoices:post`) by Finance: creates the posted purchase invoice, the vendor ledger entry and the journal (§13.3); updates the PO lines' `invoiced_qty`, the RGN lines' `invoiced_qty`, and applies any advance.

### 11.5 The advance-payment exception, exactly

| The invoice… | Allowed when |
|---|---|
| claims one or more delivery notes | always (goods were delivered; stage 1 links their RGN) |
| claims **no** delivery note | **only if** every PO it references is flagged `requires_advance_payment` **and** an advance payment document exists for that PO in state `approved` or `paid`; the invoice amount cannot exceed what the advance document allows |

The portal tells the vendor which of these applies as they build the invoice, and refuses to submit otherwise with the specific reason ("This order is not set up for advance payment"; "No advance payment has been approved for this order yet"). Staff see the same rule re-checked at stage 1 and at posting; a vendor cannot get around it with a crafted request.

### 11.6 Three-way match and tolerances

For each invoice line the system compares **quantity** (invoice ≤ RGN accepted quantity not yet invoiced), **unit price** (invoice vs PO line price) and **tax** (invoice vs expected), and the **total** (vendor's vs computed). Tolerances are data (percentage and absolute amount) per vendor category, with defaults in vendor settings. A line outside tolerance is `exception` with the difference shown; staff can *return to vendor*, or *override* with a reason code (permission `supplier_invoices:override_match`, always approval-gated above a value, always reported). Services without an RGN use **two-way match** (invoice vs PO) plus a *service acceptance* record from the requesting department.

### 11.7 Recall, return and close (your three controls, exactly)

* **Close (vendor).** Only from `draft` (or from `returned`, which re-enters as a draft). The vendor gives a reason; the invoice becomes `closed`, kept for the trace, and its vendor-invoice number is released so it can be reused.
* **Recall (vendor).** Only while the invoice is `submitted` **and untouched**: no staff has opened it, no stage has been completed and no one is assigned. "Untouched" is a fact stored on the row (`first_action_at is null`), set in the same transaction as the staff member's first action, so a recall and a pickup cannot both succeed; the loser is told plainly. A recalled invoice returns to `draft` with its number retired (the number is kept in history, a new one is assigned at the next submission) and an event "recalled by <portal user>".
* **Return (staff).** Permission `supplier_invoices:return`. Allowed **at any point before posting** (`received`, `rgn_linked`, `matched`, `pending_approval`, `approved`): the staff member chooses a **reason code and writes what to fix**; any approval in flight is cancelled; the vendor sees the invoice as `returned` with the reason, edits it (it is a draft again, `revision + 1`) and submits again, after which it re-enters the queue at the start. A returned invoice keeps its number. Once **posted** an invoice cannot be returned; a **credit memo** (§12.3) is the correction.

### 11.8 The vendor's view of an invoice

A timeline (submitted → received → RGN linked → matched → approved → posted → paid), the current state in plain words, the reason when returned or rejected, the payment status and the **remittance** (date, reference, amount, which invoices) once paid. Nothing internal (who approved, internal notes, override reasons) is shown.

---

## 12. Accounts Payable (the Finance side)

### 12.1 Vendor posting groups and setup

`vendor_posting_groups`, one per class of vendor (local, foreign, related party …): **payables account**, **vendor prepayments (advances) account**, **payment discount received account**, **payment tolerance / rounding account**, **realised and unrealised FX gain/loss accounts**, **withholding tax payable account**. The accounts for **input VAT**, **purchase price variance** and **accrued purchases** live in the general posting setup and the tax setup, like their sales counterparts. Posting setup is *traced* (the screen shows which group and which accounts a document would use, as for sales).

Vendor financial settings (on the vendor): posting group, payment terms, payment method, preferred bank account, **currency**, early-payment discount terms, withholding-tax code, tax-exempt flag, payment block (`none | payment | all`).

### 12.2 The vendor ledger

`vendor_ledger_entries` (one per posted document: invoice, credit memo, payment, advance, refund received) and `vendor_detailed_entries` (initial entry, application, unapplication, payment discount, payment tolerance, realised FX gain/loss, advance application, write-off). Both **append-only by trigger**. `remaining_amount` is the only mutable-looking figure and, as for customers, is **derived and maintained in the same transaction** as the detailed row (core-finance §3.3), with a nightly integrity check that recomputes it. Signs: purchases credit the vendor (we owe); payments debit.

### 12.3 Posted purchase invoice, credit memo, debit adjustments

* **Posted purchase invoice:** produced by posting an approved supplier invoice (§11.4 stage 4). Immutable. Carries the vendor invoice number, dates, lines with RGN/PO links, tax, withholding, dimension set.
* **Vendor credit memo** (a credit note *from* the vendor): the vendor can submit one in the portal exactly like an invoice (`document_type = credit_memo`, referencing the invoice or RGN it corrects); same states; posts as the reverse. Used for returned goods, price corrections and over-billing.
* **Purchase return (return to vendor):** a document that sends rejected or returned goods back, reduces stock at cost (Dr Stock received not invoiced or Payables, Cr Inventory) and expects the credit memo.
* **Corrections never edit:** a posted invoice is corrected by a credit memo plus a new invoice, or by **reversing the register** (reason, permission, only if nothing has been applied to it and the period is open).

### 12.4 Advance payments

`vendor_advance_payments` (§9.4): the document. Posting an advance payment: **Dr Vendor prepayments (asset) / Cr Bank** (or Accrued payments while a batch is pending) at the *payment*, never at the request. It sits in the vendor ledger as an open **advance** entry. Applying it to the final invoice: a detailed `advance_application` entry reduces both, with no further bank movement. An unapplied advance can be **refunded by the vendor** (a vendor refund received, matched to a bank statement line), or written off with approval.

### 12.5 Payment vouchers

A **payment voucher** is the document that authorises one payment to one vendor.

* **Types:** payment of invoices (applies to chosen invoices), **advance payment** (must reference an advance payment document, §9.4), payment on account (no invoice yet, needs `vendor_payments:on_account`), refund of an overpayment.
* **Method and bank:** the existing `payment_methods` and `bank_accounts` (cash, **petty cash**, bank transfer, cheque, M-Pesa B2B/B2C, EFT file), including the **provider** link for automated payout; amounts in the vendor's currency with the rate of the day.
* **State machine** (kernel state-machine kit; same shape as refunds):

```
draft ──► pending_approval ──► approved ──► (in a batch / sent) ──► paid ──► (reconciled)
   ▲           │ rejected (reason) ─► draft                              │ failed / returned ──► approved (re-pay) or cancelled
   └ cancel (draft only)                                     in_doubt (provider unsure: check / close, as for B2C refunds)
paid ──► reversed (reason; cheque stopped or bank recall; unapplies; needs permission)
```

* **Controls:** the **approver ≠ the creator ≠ the person who releases the payment** (three different people above a configurable value, default 100,000). Payment to a vendor in `blocked_payment` / `blocked_all` is refused. Payment to a bank account changed within the cool-off period is refused (§17.2). The *destination* (bank account or phone) is frozen on the voucher at approval; a later change of vendor details does not change an approved voucher, and a mismatch at release stops it.
* **Withholding tax:** computed at voucher time from the vendor's WHT code and the invoice's WHT base; the voucher pays the net, posts the withheld amount to **WHT payable**, and produces a **withholding certificate** (number, vendor, period, base, rate, amount) the vendor can download in the portal. The rate and the base rule are data (tax setup), never in code.
* **Discounts and tolerance:** an early-payment discount inside its date is taken as a detailed `payment_discount` entry (Cr discount received); a small difference within the tolerance is closed as `payment_tolerance`.

### 12.5a Petty cash

Petty cash is a payment channel with its own controls (decided 2026-10-23):

* A **petty cash float** (imprest) is a cash account of its own with a **custodian**, a float amount, a **per-voucher limit** and a **daily limit**; it is a bank account of kind `petty_cash` so it reuses payment methods, the bank ledger, cash counts and the GL.
* A **petty cash voucher** pays a small vendor invoice, or a small expense with **no vendor** (category, narration, receipt attached, payee name); same state machine as a payment voucher, with approval thresholds set for petty cash, and the custodian can never approve their own voucher.
* **Replenishment** is a request to top the float back up to its amount (Dr Petty cash / Cr Bank), approved like any payment; the request lists the vouchers it covers, and a **cash count** (existing module) shows the variance before the top-up is released.
* A voucher over the limit is refused with the reason; a float below its minimum blocks new vouchers.

### 12.6 Payment proposals and batches (BC's *Suggest Vendor Payments*)

* A **proposal** is built by a filter: due on or before, discount date, vendors / categories / posting groups, currency, minimum and maximum amounts, "include advances", "skip blocked". The system lists the open invoices, the amount to pay (after discount and WHT), and **exclusions with reasons** (blocked vendor, dispute, pending bank-detail change, on hold). The user can edit the lines, set the method, and save.
* The proposal becomes a **batch** of payment vouchers (one per vendor and method), through **one approval** (trigger `vendor.payment_batch`) that can approve all, some, or none; a rejected line returns to open.
* **Release** produces what the method needs: a **bank payment file** (CSV or ISO 20022 pain.001) through the existing refund-file generator (three different people: prepared by, approved by, released by), **M-Pesa B2B / B2C** requests through the existing disbursement path (the existing `provider.disbursement` approval applies on top), or a **cheque run** (printed list and cheque numbers).
* **Reconcile:** bank statement lines are matched to payment vouchers by the existing matching engine (reference, amount, window); an unmatched debit can create a vendor payment from the line, as for receipts.

### 12.7 Bank statements and the GL

Payables and the bank: payments leave the bank ledger at release, reconcile at the statement. The nightly **payables reconciliation** compares the vendor ledger total to the payables control account (and prepayments to the prepayments account); any difference is a defect and is listed by document.

### 12.8 Reports

Vendor statement (open items, applications), **payables ageing** (by due date and by invoice date, by vendor / category / posting group, in base currency and vendor currency), vendor balances, **purchases by vendor / category / period**, **RGNI** (received goods, not invoiced, with age: BC's *Inventory Posted To GL / Uninvoiced Receipts*), **advances outstanding**, **PO commitments** (ordered, received, invoiced, open), **RFQ cycle time and savings** (awarded vs highest and vs budget), **vendor performance** (on-time delivery from RGN dates, rejection rate, invoice accuracy from match exceptions, response rate to RFQs), **expiring documents**, **withholding tax**, **prequalification status by category**.

---

## 13. Posting recipes (every journal)

All amounts in base currency at the document's rate; document-currency amounts are stored beside them (core-finance §3.5). Dimensions follow the document.

### 13.1 RGN of stock goods (already supported by the inventory job)

| Event | Debit | Credit |
|---|---|---|
| Accepted stock received at PO cost | Inventory (per product posting group) | Stock received not invoiced (2130) |
| RGN reversed | Stock received not invoiced | Inventory |

### 13.2 RGN of non-stock lines (service acceptance)

| Event | Debit | Credit |
|---|---|---|
| Service accepted | Expense account of the PO line | Accrued purchases |

### 13.3 Posted purchase invoice

| Part | Debit | Credit |
|---|---|---|
| Goods invoiced at the PO price (RGN-linked, up to the received value) | Stock received not invoiced (2130) | — |
| Price difference (invoice price vs PO price, beyond zero, within the approved tolerance) | **Purchase price variance** | — (or the reverse for a favourable difference) |
| Non-stock lines | **Accrued purchases** (relieves the accrual) | — |
| Input VAT (recoverable) | **Input VAT** account (tax setup) | — |
| Total payable | — | **Payables** (vendor posting group) |
| Advance already paid (applied) | **Payables** | **Vendor prepayments** |
| Withholding on the invoice (if the code withholds at invoice rather than at payment) | Payables | WHT payable |

### 13.4 Vendor credit memo / purchase return

The mirror of §13.3 (Dr Payables, Cr Stock received not invoiced / Accrued purchases / Input VAT; a goods return also moves stock out at cost).

### 13.5 Advance payment, payment, discount, FX

| Event | Debit | Credit |
|---|---|---|
| Advance paid (voucher paid) | Vendor prepayments | Bank (or Payments in transit) |
| Invoice payment | Payables | Bank, WHT payable, Discount received (for the parts) |
| Payment discount taken | Payables | Payment discount received |
| Realised FX (payment rate vs invoice rate) | Realised FX loss / | Realised FX gain |
| Daily revaluation of open foreign balances | FX unrealised loss / | Unrealised gain, undone next day by the existing `fx-reverse-revaluations` job |
| Payment reversed (bounce, recall) | Bank | Payables (re-opens the invoice) |
| Advance refunded by the vendor | Bank | Vendor prepayments |

### 13.6 Failure and idempotency

Every posting carries an idempotency key (`supplier_invoice:<id>:<revision>`, `rgn:<id>`, `voucher:<id>`), is one transaction with its subledger rows, and is refused (with the reason shown) when the period is closed, the account is blocked, or a required rate is missing — never posted at a guessed value (core-finance §21).

---

## 14. Permissions

Every action has its **own key** (resource, action). Writes default to super-admin only until granted, as for finance. A person without a key sees neither the button nor the data; the server checks every time.

**Vendor Management:** `vendors:read | create | edit | invite | review | verify_documents | approve | reject | request_revision | suspend | block | archive | view_bank_details | view_audit`; `vendor_settings:read | manage`; `procurement_categories:read | manage`; `prequalification:read | manage | evaluate | decide | revoke`; `rfq:read | create | edit | issue | clarify | close | evaluate | accept_quote | reject_quote | request_revision | award | cancel | view_sealed_early`; `purchase_orders:read | create | edit | submit | approve | release | amend | flag_advance | cancel | close | skip_rfq`; `rgn:read | create | post | reverse`; `supplier_invoices:read | assign | process | link_rgn | match | override_match | return | reject | approve | export`.

**Accounts Payable:** `vendor_finance:read | edit` (posting group, terms, WHT, payment block), `vendor_bank:read | propose_change | approve_change`, `purchase_invoices:read | post | reverse`, `vendor_credit_memos:read | post`, `vendor_advances:read | create | approve | pay`, `vendor_payments:read | create | approve | release | on_account | reverse`, `payment_proposals:read | create | approve | release`, `vendor_ledger:read | unapply`, `withholding_tax:read | issue_certificate`, `payables_reports:read`.

**Segregation rules enforced in code, not only by who is granted what:** the person who created a PO cannot approve it; who processed (stage 1 or match) a supplier invoice cannot approve it; who approved an invoice cannot post the voucher that pays it; who proposed a bank change cannot approve it; who created a payment voucher cannot approve it; and the releaser of a payment batch is neither its preparer nor its approver (above the configured value).

**Vendor portal:** no staff permission applies. See §5.3.

---

## 15. Data model

Names are indicative; the migration is hand-reviewed like the finance ones (`pnpm db:generate`, review, `pnpm db:migrate`). Every table is company-scoped; every foreign key and every query path has an index; no table grows per row at render time; long lists are keyset-paged.

**Identity and master**

* `vendors`: id, company_id, number (assigned at approval), status (§6.2), block (`none|payment|all`), type, legal_name, trading_name, tax_id, vat_no, registration_no, country, customer_id?, posting_group_id, payment_terms_id, payment_method_id, currency, wht_code_id, created_by_staff, created_at; **unique** (company, tax_id) where not archived; **unique** (company, lower(legal_name), country) warn-level (not a constraint) to catch duplicates.
* `vendor_users`: id, vendor_id, user_id (unique), portal_role (`owner|finance|sales|readonly`), status, invited_by, last_seen; at most one *active* owner per vendor (partial unique index).
* `vendor_profile_versions`: vendor_id, version, section, data jsonb, submitted_at, decided_at, decision, decided_by, comment (immutable after decision).
* `vendor_contacts`, `vendor_addresses`, `vendor_references`, `vendor_directors`.
* `vendor_bank_accounts`: vendor_id, bank, branch, account_name, **account_number_sealed**, account_hash (for duplicate detection across vendors: the same account on two vendors is flagged), status (`active|pending_change|retired`), effective_from; a change creates a **new row** `pending_change`, the old stays `active` until the change is approved and the cool-off has passed (§17.2).
* `vendor_documents`: vendor_id, document_type_id, media_asset_id, file_hash, issued_on, expires_on, status (`submitted|valid|invalid|expired`), verified_by, verified_at, note.
* `vendor_document_types`: name, required_for rules, needs_expiry, reminder_days, blocking.
* `vendor_posting_groups`, `vendor_settings` (tolerances, thresholds, reminders), `vendor_events` (append-only history).

**Prequalification**

* `procurement_categories` (tree, status), `procurement_category_links` (product categories, item types), `prequalification_areas` (category, requirements, validity, window, scoring, four_eyes), `prequalification_questions`, `prequalification_applications` (vendor, area, round, status, valid_from/to, conditions), `prequalification_answers`, `prequalification_scores` (evaluator, question, score, comment), `prequalification_events`.

**RFQ**

* `rfqs`, `rfq_lines`, `rfq_invitations` (vendor, state, viewed_at, declined_reason), `rfq_clarifications`, `rfq_questions`, `rfq_quotes` (invitation, **version**, status, total, valid_until, sealed_until), `rfq_quote_lines`, `rfq_quote_attachments`, `rfq_awards` (line, vendor, quote version, justification), `rfq_events`.
* Constraint: **at most one `submitted` quote version per invitation**; a quote is immutable once submitted (a trigger refuses updates; a revision is a new row).

**Purchasing**

* `purchase_orders` (+ `version`), `purchase_order_lines`, `purchase_order_events`, `purchase_order_amendments`.
* `vendor_advance_payments` (po_id, amount, status, voucher_id), unique *(po_id, active)* so there is one live advance document per PO unless explicitly split.
* `rgns`, `rgn_lines` (accepted, rejected, reasons, invoiced_qty with `CHECK (invoiced_qty <= accepted_qty)`), `rgn_events`; `purchase_returns`.

**Supplier invoices**

* `supplier_invoices`: id, vendor_id, number (at submit), vendor_invoice_no, **unique (vendor_id, normalised vendor_invoice_no) where state not in (`closed`,`recalled`)**, state, revision, currency, subtotal, tax, total (all computed server-side), claimed_delivery_notes jsonb summary, advance_document_id?, assigned_to, **first_action_at** (null until staff touch it), submitted_at, posted_register_id, created_by_portal_user.
* `supplier_invoice_lines` (po_line_id, rgn_line_id[s] via `supplier_invoice_line_rgn`, qty, price, tax), `supplier_invoice_delivery_notes` (external DN number, date, media_asset_id, matched_rgn_id), `supplier_invoice_attachments`, `supplier_invoice_matches` (per line: expected vs actual, delta, status, override reason), `supplier_invoice_events` (append-only).
* A **trigger** forbids any change to a row after `posted`; a **CHECK** forbids `state = 'posted'` without `posted_register_id`.

**Accounts Payable**

* `vendor_ledger_entries`, `vendor_detailed_entries` (append-only triggers), `purchase_invoices` + lines (posted, immutable), `vendor_credit_memos` + lines, `vendor_payment_vouchers` + `vendor_payment_applications`, `payment_proposals` + `payment_proposal_lines`, `payment_batches`, `withholding_certificates`.

Existing tables reused or touched: `payment_methods`, `bank_accounts`, `payment_provider_*`, `refund_files` (generalised to *payment files*), `gl_*`, `ledger_registers`, `inventory_movements`, `finance_inventory_events`, `approval_*`, `document_numbering`, `reason_codes`, `media_assets`, `communication_outbox`, `users`, `roles`, `products`, `units_of_measure`.

---

## 16. Screens

### 16.1 Vendor portal (`/vendor`, 390 px up, no sideways scroll)

* **Dashboard**: profile completeness checklist (the five sections), what needs action (RFQs awaiting a quote, quotes returned for revision, POs to confirm, invoices returned, documents expiring), recent activity.
* **Profile** (five section pages), **Documents**, **Users**.
* **Prequalification**: open categories, my applications and their status, questionnaires, decisions and reasons.
* **RFQs**: all stages (§8.4); **Quote editor** (lines, attachments, save draft, submit, withdraw, new version); **Q&A**.
* **Purchase orders**: list, detail, confirm, amendments to confirm, "create invoice".
* **Invoices**: list by state; **Invoice editor** (PO picker, lines, totals preview, own invoice attachment, delivery notes with external numbers, save draft, submit, close, recall, resubmit); timeline; remittances; credit memos.
* **Payments**: remittance advice and withholding certificates, statement of account.
* Every page: loading, empty, error and success states, `role="alert"` for problems, inline confirm for destructive actions (never `window.confirm`), keyboard operable, WCAG AA.

### 16.2 Admin — Vendor Management

* **Vendors** list (keyset paged, filters by state, category, expiring docs) and **Vendor card** (the five sections, review panel, documents with verify actions, qualifications, activity, RFQ and PO history, performance, bank accounts with pending changes).
* **Applications** worklist; **Application review** (answers, scores, evaluators, decision).
* **Categories & prequalification areas** designer (tree, requirements, questionnaire, scoring, window).
* **RFQs** list and **RFQ workspace** (lines, invitees, clarifications, Q&A, quotes, **comparison sheet**, award); **Make order**.
* **Purchase orders** list/detail/amendments; **Received goods** list/detail (receive against a PO, partial); **Supplier invoices** queue and **Invoice workspace** (stages in order: link RGN, match, approve, post-ready; return / reject with reason; timeline).
* **Settings:** vendor types, document types, tolerances, thresholds, reason codes.

### 16.3 Admin — Accounts Payable

Vendor ledger (per vendor, with applications), purchase invoices, credit memos, advance payments, payment vouchers, proposals and batches, ageing, statements, RGNI, withholding, payables reconciliation, posting groups. All with Autocomplete pickers from registered lookup sources (`vendors`, `vendor-categories`, `purchase-orders-open`, `rgn-lines-invoiceable`, `payment-methods-payout`, `wht-codes`, …); **"create new" and "view all" open as intercepting-route modals** (`@create`, `@modal`), full pages on a direct URL. Pages stream (`FinancePage` / `SettingsFrame` pattern); they never block on data that is not a security decision.

---

## 17. Security and fraud controls

### 17.1 Vendor isolation

* `vendor_id` in the session only; every portal query joins on it; an object id from the request that does not belong to the vendor returns **not found**, not forbidden (no existence oracle). Integration tests prove this for every portal route and action with a second vendor.
* A vendor sees **its own** quote, never another's, and never an RFQ it was not invited to. RFQ sealing is enforced in the query (`sealed_until`), not in the screen.
* Portal actions are server actions returning results as data, each naming its portal capability; CSRF is covered by Next's action protections plus an origin check; rate limits on registration, login, upload and submit.

### 17.2 Bank-detail change control (the largest payables fraud)

A vendor's bank account is never edited. A change creates a **pending** account and: (1) notifies the vendor's *other* contacts and the buyer, (2) requires `vendor_bank:approve_change` by a person other than the proposer, (3) requires evidence (bank letter on the bank's letterhead) and a **call-back verification** recorded by staff (number *from our records*, not from the request), (4) starts a **cool-off** (default 3 business days) during which payments to the vendor use the old account or are held, and (5) shows the change in the vendor activity and on every payment voucher created afterwards. The same account number on two vendors is flagged on both.

### 17.3 Documents

Files are validated by content (magic bytes, as the logo upload already does), size-capped, stored through the media module with a hash, served only through an authorised route (never a public URL for vendor documents, invoices or delivery notes), antivirus-scanned when a scanner is configured, and every download by staff is logged. Invoice and delivery-note attachments are immutable after submit; a replacement is a new attachment with the old kept.

### 17.4 Duplicate and anomaly detection

Same vendor invoice number (blocked), same amount + date + vendor within a window (warned), invoice for a PO already fully invoiced (blocked), invoice date in the future or beyond the PO's validity (warned), vendor bank account shared with another vendor (flagged), payment to a vendor created in the last N days above a value (held for extra approval). Rules and thresholds are data.

### 17.5 Sealed data and PII

Bank numbers sealed at rest and masked; directors' ID numbers sealed; vendor user passwords as for all users; portal emails never reveal whether an address is registered (same wording for known and unknown, as the existing reset flow does).

---

## 18. Approvals (new triggers on the existing engine)

| Trigger | Fires when | Notes |
|---|---|---|
| `vendor.onboarding` | A profile is submitted for review (optional; off by default) | Conditions on vendor type, country, expected spend |
| `vendor.prequalification` | A prequalification decision is made | By category and score |
| `vendor.bank_change` | A bank change is proposed | Always on; cannot be switched off |
| `rfq.issue` | An RFQ is issued | By estimated value |
| `rfq.award` | An award is made | By value; extra when the lowest bid is not chosen |
| `po.release` | A PO is released or amended | By value, category, branch, `no_rfq` |
| `vendor.advance_payment` | An advance payment document is approved | By value |
| `vendor.invoice` | A matched supplier invoice is sent for approval | By amount; match exception; advance invoices |
| `vendor.payment_batch` | A proposal becomes a batch | By total and per voucher |
| `provider.disbursement` (existing) | An M-Pesa payout is requested | Applies on top |

The engine is used as it is: versioned workflows, ordered approvers, escalation on overdue, simulation, and "the creator is never the approver". A trigger with no enabled workflow **refuses** the action where money moves (as `provider.disbursement` already does) and is open (auto-approved with a note) only where the setting says so.

---

## 19. Numbering

New document kinds in `DOCUMENT_KINDS` bound to series with data (prefix, digits, reset rule, branch): `vendor`, `rfq`, `purchase_order`, `rgn`, `supplier_invoice`, `purchase_invoice` (posted), `vendor_credit_memo`, `vendor_advance`, `vendor_payment` (voucher), `payment_proposal`, `payment_batch`, `purchase_return`, `wht_certificate`. Numbers are assigned at the moment the document becomes real (vendor: at approval; PO: at approval; invoice: at submission) so abandoned drafts leave no gaps. Fiscal kinds (those that are legal documents) are flagged as such like `tax_invoice`.

---

## 20. Notifications

Through the existing outbox (email now; SMS and push are extra channels later). To the vendor: registration verification, invitation, profile revision requested, profile approved / rejected, prequalification decision, RFQ invitation, RFQ clarification, deadline reminder (48 h, 4 h), quote revision requested, quote accepted / rejected, award, PO sent / amended, invoice returned / rejected / posted, payment made (remittance), document expiring. To staff: new application, new quote, deadline passed, invoice submitted, invoice recalled, approval requests (inbox already exists), overdue approvals, document expired, bank change pending. Every message is templated (editable), logged, retried, and carries no more than the person needs; no attachment of an internal file is ever emailed.

---

## 21. Where this fits the code that exists

| Need | Existing piece to extend | Change |
|---|---|---|
| Vendor login | `users.role`, `roles.is_staff`, `auth.ts` session callbacks, `proxy.ts` (`matcher: ['/admin/:path*']`) | Add the `vendor` role; add `vendorId` / `vendorUserRole` to the session; add `/vendor/:path*` to the matcher with a vendor-only guard; extend revalidation to vendors |
| Registration and verification | `/register`, `verify-email`, `reset-password`, token repository | A vendor flavour of the same flow; same token and email machinery |
| Numbering | `src/server/kernel/numbering/document-kinds.ts` | New kinds (§19) |
| Approvals | `src/server/kernel/approvals` | New triggers (§18) |
| Reason codes | `src/server/kernel/reason-codes` | New sets: `vendor_rejection`, `rfq_quote_rejection`, `invoice_return`, `invoice_rejection`, `rgn_rejection`, `po_cancel` |
| Stock in | `InventoryService.receive`, `applyStockDelta`, `finance_inventory_events` job | RGN calls `applyStockDelta`; the typed-PO-number `receive` becomes a thin legacy wrapper that requires an RGN |
| Books | `finance/engine.ts`, posting setup, `inventory-posting.ts` | Vendor posting groups; new posting recipes (§13); RGNI report |
| Payments out | `payment_methods`, `bank_accounts`, Daraja disbursement, `refund-file-service` | Generalise the file generator to payment files; vouchers reuse the method/provider model |
| Bank matching | `bank-reconciliation-service`, rules | Match payment vouchers to debit lines |
| FX | `exchange_rates`, revaluation jobs | Vendor balances join the revaluation |
| Units, products, taxes | `units`, `catalog`, `taxes` | PO/RGN/invoice lines use them as they are; add input-VAT and WHT code types if the tax model lacks them |
| Attachments | `media` module, `evidenceUpload` route helper | A vendor-scoped upload route with its own authorisation |
| Pickers | `LookupAutocomplete`, `ChoicePicker`, `lookups/sources.ts` | New sources (§16.3) |
| Returns | `returns` module (`return_to_supplier` disposition exists) | Link to purchase returns |

---

## 22. Delivery plan

Each slice follows the standing exit gates: unit, integration (database built from migrations), API, **e2e on desktop and 390 px phone**, load where it matters (invoice posting, ledger application, proposal building), migration rehearsal on a restored copy, and a short runbook. Each slice ends with this document updated under "as built", as the finance slices did.

| Slice | Delivers | Depends on |
|---|---|---|
| **V-0 Identity, vendor master and AP foundation** | `vendor` role and portal shell (`/vendor` guard, session, revalidation), registration and invitation, `vendors` and children, vendor posting groups, **vendor ledger and detailed ledger with triggers**, number series kinds, permissions catalogue, admin Vendors list and card (read + create), lookup sources | F-0, F-1 |
| **V-1 Onboarding and profile** | The five profile sections in the portal, documents with types and expiry, profile submit and versions, staff review (accept / request revision / reject), vendor activation, expiry job, vendor settings, bank-change control | V-0 |
| **V-2 Prequalification** | Categories and areas designer, questionnaires, applications, evaluation and decision with approval, validity, suspension by documents, portal views | V-1 |
| **V-3 RFQ** | RFQ document, invitations, portal RFQ pages and quote editor with versions, sealing, Q&A and clarifications, comparison sheet, accept / reject (reason) / revision, award with approval, notifications | V-2 |
| **V-4 Purchase orders and advance payments** | PO from award or direct, approval and release, sending and vendor confirmation, amendments, `requires_advance_payment` flag, advance payment document and its voucher link, payment vouchers (first version, manual methods) | V-3, AP vouchers |
| **V-5 Received goods** | RGN against POs, acceptance / rejection, stock in and accounting through the existing job, service acceptance, reversal, purchase returns, RGNI report | V-4 |
| **V-6 Supplier invoices** | Portal invoice editor (draft, submit, close, recall, resubmit), delivery notes, own-invoice attachment, advance rule, staff queue, stage 1 link RGN, match with tolerances, return / reject, approval, **post to AP** (purchase invoice + ledger + journal), credit memos from vendors | V-5, V-4 |
| **V-7 Payments in full** | Payment vouchers for invoices, applications, discounts, tolerance, FX, withholding and certificates, proposals and batches, bank files, M-Pesa B2B/B2C, cheque run, **cash and petty cash** (floats, vouchers, replenishment), reconciliation to statements, reversal, payables ageing and statements | V-6 |
| **V-8 Reports and hardening** | Performance and commitments reports, anomaly rules, load tests, security review (vendor isolation test matrix), backup/restore rehearsal | V-7 |

Slice order differs from your brief's order of mention only where a dependency forces it (the vendor ledger comes first because every later slice posts to it; the first payment voucher is needed by V-4 for advances; the full payment features follow invoices).

---

## 23. What I will not promise

* **Real-world verification of the providers.** M-Pesa B2B/B2C, bank files and any statement matching are built and tested against our fakes and, where you give me sandbox credentials, the Safaricom sandbox. Nothing is claimed to work against a live provider until it has been run with your credentials.
* **Landed costs** (freight, duty apportioned into inventory cost), **blanket orders and contracts**, **purchase requisitions**, **vendor scorecards beyond the measured ones**, **EDI** and **e-invoicing with a tax authority for purchases** (KRA eTIMS purchase invoices) are designed for (fields exist) but not built in V-0..V-8. Each is a slice of its own.
* **Legal and tax rules.** Withholding rates, input VAT recoverability and their certificate wording are *data you configure with your accountant*; the system will apply the rule you set, not decide the law.
* **Antivirus scanning** works only where a scanner is installed and configured.
* **Dollar-perfect equivalence with Business Central** is not the goal; the same discipline and vocabulary are.

---

## 24. My readings of your brief, decisions taken, and what I need from you

### 24.1 Readings (I will build to these unless you say otherwise)

1. **"Account type of vendor"** = a built-in non-staff user role `vendor`, plus a `vendors` business record, so many people can log in for one vendor business (§5).
2. **"Vendors can close their invoices if not submitted yet"** = the vendor can **close** (abandon) a draft; the invoice is kept as `closed`, never deleted (§11.7).
3. **"Recall … if this invoice has not been acted on"** = the vendor can recall a submitted invoice **only while no staff member has taken any action** on it (§11.7); the check is atomic.
4. **"Return … if has not been acted on or advanced or to any stage since it was submitted"** is ambiguous. I read it as: staff with permission can return an invoice to the vendor **at any stage before it is posted** (not only when untouched), and the vendor then edits and resubmits. If you instead meant "only while untouched", the rule is one line to change.
5. **"Link the supplier invoice with the Received Goods Note as the first stage"** = the first mandatory staff stage after submission (§11.4); an advance invoice links the advance payment document instead of an RGN.
6. **"An invoice can demand payment for 1 or more delivery notes or no delivery note at all, only when the PO is flagged as requiring advance payment and an advance payment document exists and is linked to the payment voucher"** = §9.4 and §11.5, enforced both when the vendor submits and when staff process and post.
7. **"RFQ can be approved, rejected with reason; a vendor could be asked for revision"** applies to the **vendor's quote** on an RFQ (accept for award / reject with reason / request revision), and, separately, an RFQ itself is approved before it is issued (§8).
8. **"Vendors can action on their RFQs … in all stages"** = the vendor portal lists every RFQ with a stage and the actions valid in that stage (§8.4).
9. Vendor invoices are created **by the vendor**, with the vendor's own number and attachments, and **our** number is assigned at submission (§11.1).

### 24.2 Decisions I took (change any of them)

* **Vendor is the word** (Business Central's); "supplier" appears where you used it.
* **Sealed bids on by default**; staff cannot open quotes before the deadline unless the RFQ is flagged unsealed.
* **Prequalification is per category and expires** (default 24 months), renewal is a new application.
* **Four-eyes on prequalification and on bank-detail change** by default.
* **Three-way match tolerance defaults:** quantity 0 %, price 2 % or KES 100 per line, tax 0; per-category overrides.
* **Input VAT is recoverable and posted to its own account**; withholding tax posts at *payment*, not at invoice, unless the code says otherwise.
* **A PO may be raised without an RFQ** under a value threshold you set (default KES 50,000) with a reason.
* **Payment approval thresholds:** one approver below KES 100,000; segregation of three people above.
* **Cool-off after a bank-detail change:** 3 business days.

### 24.3 Your answers (2026-10-23)

| # | Question | Answer, as built into this document |
|---|---|---|
| 1 | Sidebar placement | New top-level **Vendor Management** module (§4) |
| 2 | Free-line invoices | **Never**: every invoice is against a PO, except an advance invoice and vendors an administrator marks as *approved expense vendors* (§11.2) |
| 3 | Currencies | **KES and foreign currency** from the start, using the existing exchange-rate table (§12, §13.5) |
| 4 | Withholding tax | **Configurable codes**; **certificates in the vendor portal** (§12.5) |
| 5 | Inventory vs expenses | **Both, tested deeply**: stock items through the RGN and inventory job; services and expenses through service acceptance (§10.3) |
| 6 | Payment channels | **Everything listed**: bank file, M-Pesa B2B/B2C, cheque, cash, **plus petty cash** (§12.5a) |
| 7 | What vendors see of evaluation | **Configurable**; vendors see reasons only, and the buyer configures what may be shown (§7.3, §8.5) |
| 8 | Retention | **7 years**; deletion inside the period is refused |
| 9 | Registration | **Open to anyone; review is mandatory** before a vendor becomes active (§5.2, §6.2) |
| 10 | First slice | **V-0 approved** |

**Side notes, applied throughout:** the goods document is called the **Received Goods Note (RGN)**, never GRN (including the "received, not invoiced" report, now RGNI); and a **vendor can select several categories (specialisation areas)** in one application, each decided separately (§7.2).

The next step is to build **V-0** with its full test set, then report what is done, what is verified and what is left, as for each finance slice.

---

## 25. V-0 as built (2026-10-23): identity, vendor master and the vendor ledger foundation

**Built.**

* **Identity.** A built-in non-staff role `vendor` (seeded, `is_system`, no grants). `users.role = 'vendor'` plus a `vendor_users` link; one login belongs to one vendor business (unique), a vendor has at most one active owner (partial unique index). The session carries `vendorId` and `vendorRole`; both are read from the database at sign-in and **re-checked every 60 seconds** (a removed portal user or an archived vendor ends the session at the next check). A sign-in by a `vendor` login with no vendor link is refused. `proxy.ts` now matches `/vendor/:path*`: only a session with role `vendor` and a vendor id passes (a staff session is sent to `/admin`; everyone else to sign-in); `/vendor/register` is the only public portal page. The portal layout checks the session again on the server. Every portal action starts at `requirePortalVendor()`, which takes the vendor from the session and re-checks it in the database: **the vendor id is never read from a request**.
* **Registration.** `/vendor/register` is open to anyone. It creates the login (role `vendor`, email not verified) and the business (`registered`, no vendor number) together, in one transaction for the business and its owner link; if that fails the unverified login is removed so the address can try again. The answer is the same for a new and an already-registered address (an unverified existing address is mailed its link again). Sign-in needs the verified email, as for every account.
* **Vendor master.** `vendors`, `vendor_users`, `vendor_events` (append-only), `vendor_posting_groups` (default group `TRADE` made on first use from chart accounts 2110 Trade creditors and 1430 Prepayments when the chart has them). Statuses and blocks as in §6.2 with database CHECKs; **a vendor in `active` status must have a number** (CHECK); the vendor number comes from the number series (`vendor`, `V-000001`, never resets) only when a vendor is made active; unique tax id per company ignoring case and archived vendors. A staff member with `vendors:create` adds a vendor (waiting for its own profile); with `vendors:create_active` it can be made active at once.
* **Vendor ledger.** `vendor_ledger_entries` and `vendor_detailed_entries` mirror the customer tables: append-only by trigger (only `remaining_amount` can move on an entry), an opening detailed entry written with each entry in the same transaction, an idempotency key so a retried posting writes nothing twice, **one vendor invoice number can be booked once per vendor** (unique, case and space insensitive), and a `drift()` check that names any entry whose remaining amount differs from its detailed entries. `VendorLedgerService` has `addEntry`, `balances`, `statement` and `drift`; applications, discounts and exchange differences come with V-7.
* **Admin.** New sidebar module **Vendor Management → Vendors**: a list (server-side search, status picker, keyset paging with microsecond cursors, cards on phones), a vendor card (details, what we owe when the viewer may see the ledger, portal users, history), **Add a vendor** as an intercepting-route modal over the list and as a page of its own. Lookup sources `vendors`, `vendor-statuses`, `vendor-types`. Permissions added: `vendors:read`, `vendors:create`, `vendors:create_active`, `vendor_ledger:read`.
* **Portal.** `/vendor` shows the business, its status, and the five profile sections as "Not started" (the sections open in V-1).
* **Tests.** Unit: `src/lib/vendor-forms.test.ts`. Integration (database from the migrations): `src/server/domains/vendors/vendors.integration.test.ts` (numbering, duplicates, history, paging, company isolation, portal access, the ledger and its triggers). E2E: `e2e/vendors.spec.ts` (admin list, add, add active, bad form, not found, registration, taken address, vendor sign-in and isolation, signed-out and staff redirects), desktop and phone.

**Differences from the plan above, and what is not built yet.**

| Item | State |
|---|---|
| Invitation of a vendor by staff (`vendors:invite`, §5.2) | **Moved to V-1**: an invitation carries a pre-selected category and sits naturally with the profile flow; V-0 has registration and "add a vendor" |
| Portal users beyond the owner (invite colleagues, §5.3) | V-1 |
| Rate limiting of registration and sign-in | **Not built.** The project has no rate limiter yet; registration is open to anyone, so this should be added at the edge (reverse proxy) or as its own piece of work before launch |
| Vendor bank accounts, documents, contacts, profile versions, review and activation by the vendor review | V-1 |
| Withholding, tax and payment terms tables, vendor posting-group screens | V-0 uses the one default group; the screens come with the AP slices |
| `vendors:edit`, `vendors:invite`, `vendors:view_audit` and the other keys in §14 | Added with the slice that uses them (a key with no use is not added) |

---

## 26. V-1a as built (2026-10-23): the vendor's profile, documents, and staff review

V-1 is large, so it is built in parts. **V-1a (this section)** is the core of onboarding. **V-1b** (below) is what is still to come in V-1.

**Built.**

* **Five profile sections in the portal** (`/vendor/profile`, `/vendor/profile/<section>`): profile, business information (with owners and directors, whose ID numbers are sealed, and references), financial information (bank accounts, whose numbers are sealed and shown by their last four digits; payment terms; turnover; mobile money), contact persons (exactly one main contact), and attachments. Each section is saved on its own; each shows what is missing in plain words; completeness is decided by the same pure rules on the server (`src/lib/vendor-profile.ts`) and in the browser.
* **Who may change what** (§5.3, enforced on the server): the owner everything; finance the financial section and attachments; sales the contacts and attachments; read-only nothing. Before approval, and after a revision request, the whole profile is open. While it is with the reviewer nothing can be changed. An approved vendor keeps its contacts and documents current itself; **who it is, its registration and tax ID, and where it is paid are locked** until the controlled change flow exists (V-1b). A refused vendor can apply again 30 days after the decision.
* **Documents.** Document types are data (`vendor_document_types`; a standard set is made the first time: incorporation, tax compliance with expiry, tax PIN, bank letter, business permit with expiry, directors' IDs, company profile, insurance). Files are PDF, JPEG, PNG or WebP, up to 10 MB, **identified by their own first bytes** (never by name or the type the browser says), stored in the database (`vendor_files`, append-only, no public link) and served only through routes that check who is asking: a vendor opens its own files; staff need `vendors:view_documents` and every opening is written to the vendor's history; anyone else, a made-up id and a signed-out caller all get the same "not found". A file nobody may attach is never stored. A newer upload replaces the older, which is kept.
* **Submit.** The owner sends the profile when every section is complete; the copy sent is **frozen** (`vendor_profile_versions`, guarded by a trigger) and the vendor's status becomes "profile submitted". Account and ID numbers are not in the frozen copy.
* **Staff review** (`vendors:review | verify_documents | approve | reject | request_revision | view_documents`): take a profile for review; mark each document valid, or not valid with a note the vendor sees; **approve** (every required document must be valid; the vendor becomes active, gets its number, its bank accounts go into use); **send back** with a note on each section that needs work (the vendor sees the notes against those sections and sends version 2); **refuse** with a reason from a controlled list (a comment where the reason asks for one). Every decision is in the vendor's history with who, why and from where. The review panel is on the vendor card.
* **Portal lists.** The portal's pickers (kind of business, kind of ID, contact role, turnover band) use the same server-searched Autocomplete as the back office. A lookup source may be marked `vendorPortal`, which lets a vendor session use that fixed list; every other list still needs its staff permission, so a vendor cannot reach company data through the pickers.
* **Account-number fingerprint.** `fingerprintSecret()` (a keyed hash under the master key) lets the same bank account on two vendors be found without opening either. Key rotation must recompute it as it reseals the sealed values.
* **Tests.** Unit: `src/lib/vendor-profile.test.ts` (12). Integration against a database built from the migrations: `src/server/domains/vendors/vendor-profile.integration.test.ts` (21: sections, roles, sealing, duplicates, files, isolation, submit, freeze, approval, revision, refusal, history). E2E on desktop and phone: `e2e/vendor-onboarding.spec.ts` (a vendor fills every section and sends it; own files vs another vendor's; staff verify and approve and the vendor becomes active; send back and resubmit; refuse with a reason).

**V-1b: still to build in V-1.**

| Item | Note |
|---|---|
| Controlled change of bank details (§17.2): pending change, other person approves, call-back verification, cool-off | Today an approved vendor's bank account is locked, not changeable |
| Document types screen (admin), vendor settings (tolerances later), pack rule for the tax ID pattern | Types exist as data; there is no screen to edit them yet |
| Expiry job and reminders (§6.5), expiring-documents worklist | The expiry date is stored and required where needed; nothing marks a document expired or reminds yet |
| Invitation of a vendor by staff and invitation of colleagues by the owner (`vendors:invite`, portal users) | Registration and "add a vendor" exist; invitations do not |
| Emails to the vendor and to staff (profile sent back, approved, refused, new application) | Nothing is mailed yet; the vendor sees status when it signs in |
| Suspend / block / archive actions (§6.2) on the vendor card | The states exist; the actions do not |
| Review through the approvals engine (`vendor.onboarding`, optional) | Not wired |
| Real "return to the review queue" worklist screen | The review panel is on each vendor card; the queue query exists (`VendorReviewService.queue`) with no screen yet |

---

## 27. V-1b as built (2026-10-24): controls around a vendor that is already approved

V-1 is now complete except for two items listed at the end. Migration `0074_vendor_bank_change_and_reminders`.

**Changing where a vendor is paid (§17.2).** A bank account is never edited. An approved vendor's owner or finance person asks for a change in the portal (`/vendor/profile/financial`, "Where you are paid"), choosing the account it replaces (or "additional account") and the bank letter it uploaded. That inserts a *pending* account (`vendor_bank_accounts.status = pending_change`; one pending change per vendor, enforced by a partial unique index). Then:

1. Staff with `vendor_bank:verify_callback` phone the vendor **on a number from our own records** and record the call (who, which number, what was confirmed; required).
2. A **different** person with `vendor_bank:approve_change` approves. This is enforced three times: the service refuses it, the screen hides the button, and a check constraint (`vendor_bank_four_eyes_chk`) refuses an approver who is the proposer or the caller.
3. Approval starts a **cool-off of 3 working days** (`BANK_COOL_OFF_DAYS`; weekends skipped, public holidays not known). Until then payments use the old account: `payableAccounts()` returns only `active` accounts, and a pending account never receives money.
4. When the cool-off passes, the account goes live and the account it replaced is retired, in one transaction. This happens from the hourly worker task `vendor-bank-promote` and also whenever `payableAccounts()` is asked (so a payment never waits for the job).
5. Staff may refuse (reason required); the vendor may withdraw until approved; both leave the existing account untouched. The same account number already held by another vendor is flagged on the staff card.
* The vendor and the buyer are mailed when a change is asked for, and the vendor when it is decided. Every step is in the vendor's history. The number is sealed, shown by its last four digits only, and never in a mail.
* Staff screen: **Vendor Management → Bank changes** (`/admin/vendors/bank-changes`).

**Standing (§6.2).** `VendorLifecycleService`: suspend / reinstate (`vendors:suspend`), payments-only or full block / lift (`vendors:block`), archive / restore (`vendors:archive`). Each needs a reason from the reason-code list `vendor_standing` (made on first use; a company adds its own), with a comment where the reason asks for one; each is written to the vendor's history. Archiving is refused while the vendor is owed money (or owes), has a bank change waiting, or its application is undecided; an archived vendor loses portal access within a minute; **restore** returns it as *suspended*, so nothing is bought until someone checks and reinstates it. Panel on the vendor card.

**Document types, expiry and reminders (§6.4–6.5).** Admin screen **Document types** (`vendor_settings:manage`): add, rename, require, set whether it expires, the reminder days, whether an expiry blocks, and switch off (never delete). The worker task `vendor-document-expiry` runs daily: it marks documents past their date `expired` (once, with an event and a mail), and sends the reminders each type asks for, **each threshold once** (`vendor_documents.last_reminder_day`; claimed with a conditional update so two runs cannot both send). Reminders go to the vendor, and to the buyer within 7 days. The screen **Expiring documents** lists what has expired or will, soonest first, paged by a keyset cursor. *"Blocking" is stored and shown, but suspending a category prequalification on expiry arrives with V-2, when categories exist.*

**Invitations.** The owner invites colleagues (finance, sales, read-only; at most 10 people per vendor) at `/vendor/team`; staff with `vendors:invite` invite the owner of a vendor they added (the vendor card). An invitation creates the login with a random password nobody knows and mails a single-use link, valid 7 days, that reuses the existing password-reset token (choosing a password also verifies the address). The answer never says whether an address already has an account. An unused invitation can be resent (the old link stops working) or cancelled (the login is deleted); removing someone who joined switches their login off and ends their access; the owner cannot be removed.

**Mail (`VendorNotifier`).** Application received (to the company's address), profile sent back, approved, refused (with the reason), suspended, bank change asked for / decided, document expiring / expired, invitation. A mail that cannot be sent is logged and never undoes the decision. Links come from configuration only. *Staff mail goes to the company's address; per-user subscriptions need the notification centre, which is not built.*

**Review queue.** **Vendor Management → Review queue** lists applications waiting, oldest first.

**Permissions added:** `vendors:suspend | block | archive | invite`, `vendor_bank:verify_callback | approve_change`, `vendor_settings:manage`.

**Tests.** Unit: `vendor-schedule.test.ts` (working days, days until, reminder thresholds), `vendor-document-types.test.ts`. Integration (database built from the migrations): `vendor-controls.integration.test.ts`, 20 tests — bank change from request to cool-off with fake dates; four-eyes at the database; evidence, role and one-at-a-time rules; refusal, withdrawal, duplicate flag; isolation between vendors; mails; suspend / block / archive / restore and company isolation; expiry once, reminders once per threshold, paging; invitations end to end (set a password from the link and sign in), silent on existing addresses, removal; document types. E2E (`e2e/vendor-controls.spec.ts`, desktop and phone): standing, both invitation flows, the bank change from the vendor's request to staff approval and refusal, the three worklists and document types.

**Not built, on purpose or deferred.**

| Item | Why |
|---|---|
| Country-pack rule for the tax ID pattern | The profile rules already accept a pattern (`taxPattern`); nothing supplies one yet. Foreign vendors make a single national pattern wrong, so it needs the per-country pack design rather than a guess. |
| Review through the approvals engine (`vendor.onboarding`) | Optional in the design. Review has its own permissions and history; wiring it adds a second path to the same decision. Revisit if a company wants multi-step sign-off. |
| Calling the vendor on a number *from our records* is a rule for the person | The system records that it was done and by whom; it cannot place the call. |

---

## 28. V-2 as built (2026-10-24): prequalification

Migration `0075_prequalification`. Vendors are qualified **per category**; an approved vendor with no category sees no RFQs (V-3 will read the gate below).

**Categories (`prequalification:manage`).** `procurement_categories` is a tree (parent, no loops: checked by walking up). Each has a code, name, validity in months, an application window (either end empty), a pass mark as a **percentage of the highest possible score** (empty = pass or fail by the decider's judgement alone), a four-eyes switch, and four visibility switches. Status: draft → open → closed → open again, archived from draft or closed (refused while vendors are still applying or qualified). **Questions** (yes/no, number, written, one-of-several; points 0–100, 0 = asked but not scored; required or not) and the **required document types** can change only while a category is a draft: a database trigger refuses it afterwards, and validity and pass mark are fixed once open. Reason: vendors applied under those terms; to change them, close the category and make a new one. *Not built:* a "file" question kind; evidence is a required document type instead (it already has expiry, checks and storage).

**Applying (vendor portal, owner or sales).** `/vendor/prequalification` lists open categories (those inside their window), what the vendor would still need to upload, and all its applications. **Several categories can be chosen at once**; each becomes its own application, decided separately. One live application or qualification per vendor and category (a partial unique index). Answers are saved apart from sending; sending needs every required answer and every required document held (not replaced, expired or refused). A withdrawn, refused, revoked or expired place is free again, and **a new application starts with the earlier answers filled in** (renewal). Only an approved (active) vendor can apply.

**Evaluating (`prequalification:evaluate`) and deciding (`prequalification:decide`).** Staff take an application (several may), which makes them an evaluator; each evaluator scores each scored question from 0 to its points, with a comment; the total is the average of the evaluators per question, summed, against the points available. The decision is separate: **approve** (valid from today for the category's months; optional largest order value and a conditions note; refused if a required document is not yet *checked valid*, if a pass mark exists and nothing was scored, or if the score is below the pass mark), **refuse** (reason from the list `prequalification_decision`, comment where the reason asks), or **ask for changes** (note, optional due date; the vendor edits and sends again, which clears the scores). Where the category says four eyes, **nobody who took the application can decide it** (service and screen). Suspend, reinstate and revoke are decisions too, each with a reason, all in the vendor's history. *Per-category approval through the approvals engine (`vendor.prequalification`) is not wired; decisions use their own permissions and the four-eyes rule.*

**What the vendor sees.** Always the decision, the reason, the validity and the conditions. The total score, the pass mark, the per-question scores and the evaluators' comments each appear only if the category's switch is on (all off by default). Other vendors' results are never reachable: every portal read and write is scoped to the session's vendor and answers "not found" otherwise.

**Time-based changes (worker task `vendor-document-expiry`, daily).** A qualification past its last day becomes *expired* (vendor told; renewal is a new application). A qualification whose category requires a document type marked **blocking** is *suspended automatically* when the vendor no longer holds a good one, and *restored automatically* when it uploads one; both moves are in the history and mailed. A staff suspension is never undone by this job.

**The gate other modules use** (`PrequalLifecycle`): `qualifiedVendorIds(company, category, today)` returns vendors qualified in the category **or any category inside it**, unexpired, active and not blocked for everything; `qualificationOf(company, vendor, category, today)` returns the qualification with its conditions (largest order value). V-3 (invitations to quote) and V-4 (purchase orders) must call these; the PO override with a reason is part of V-4.

**Screens.** Staff: Vendor Management → *Prequalification* (queue, filterable by status, keyset paging) and its application page; → *Categories* (list and editor). Vendor: *Prequalification* from the dashboard. **Permissions added:** `prequalification:manage | evaluate | decide`.

**Mail:** application received (to the company address), approved, refused, changes asked for, suspended, reinstated, revoked, expired.

**Tests.** Unit `prequalification.test.ts` (10: category and question rules, answers, scoring, pass mark, validity dates, window). Integration `prequalification.integration.test.ts` (14: tree and loops, the database lock on terms, applying for several, window, answers and documents, isolation between vendors, scores bounded, four eyes, pass mark, document verification, refusal reasons, revision loop, visibility switches, the gate through sub-categories, suspension/revoke, expiry and renewal prefill, suspension and restoration by blocking documents, archive refusal). E2E `e2e/prequalification.spec.ts` (desktop and phone).

---

## 29. V-3 as built (2026-10-24): requests for quotation

Migration `0076_rfq`. Number kind `rfq` (`RFQ-<year>-00001`). **Not built here:** attachments to a request or a quote (specifications, data sheets), a weighted-score evaluation method, quotes in a currency other than the request's (so no conversion for comparison), the approval triggers `rfq.issue` and `rfq.award`, and **making the purchase order from an award** (V-4: the award rows carry the vendor, line, quantity and price the order needs). Branch and dimensions on the request are also left for V-4.

**The request.** A draft (header and lines written together; saved as often as wanted) becomes *issued* with a number, then *closed* (at the deadline by the worker, or early by staff with a reason), then *awarded* or *cancelled* (reason; vendors are told). Lines are fixed once issued (a database trigger); changes go out as **numbered addenda** to every invitee, optionally with a later deadline (also how a deadline is moved or a closed request reopened, with a reason). A closed request whose sealed quotes were already opened **cannot be reopened**, so no vendor sees what another sent. Invitations may only go to vendors **qualified in the request's category or one inside it** (V-2's gate), re-checked at issue; a vendor that loses its qualification cannot submit.

**Vendor questions.** Seen by staff only; a *published* answer goes to every invitee without saying who asked; a private answer stays private. Maximum 20 per vendor per request.

**The vendor's side.** `/vendor/rfqs` lists every request ever invited to with one stage word (New, In progress, Submitted, Revision requested, Under evaluation, Awarded to you, Not awarded, Rejected, You declined, Expired, Cancelled), paged. A request not invited to, or still a draft, does not exist for the vendor. The quote is a **versioned document**: lines (price, quantity, tax %, lead time, brand, warranty, alternative offers where allowed, per-line "not bid"), terms and a hold date at least the request's validity ahead; the total is **worked out on the server** from the lines. A sent version never changes (database trigger); the vendor may withdraw it while the request is open and write a new version; every version stays visible. Only the owner and sales roles answer; finance and read-only see. A vendor can decline to bid (with a reason) unless a quote is sent.

**Sealing.** For a sealed request staff see only *how many* quotes have arrived (not who, not what) until `opens_at` (the deadline, or the moment of an early close), decided by the **database function `rfq_quotes_open()` and its own clock**, asked by the one service path that reads quotes. *This is not row-level security: a developer with raw database access can still read the table.*

**Evaluating.** `rfq:evaluate`: the comparison sheet (a row per line, a column per vendor, the lowest price per line and the lowest complete total marked, in the request's currency; amounts in cents), and for each quote **accept for award**, **refuse** (reason from a list, comment where asked; the vendor is told that reason and never another vendor's identity or price) or **ask for a revision** (comment and a send-by time, which reopens the window for that vendor alone; its new version replaces the old one in the sheet and returns it to undecided). `rfq:award`: award line by line to one or several vendors with quantities; a vendor that is not the lowest bid on a line (rejected quotes excluded) **needs a written justification**; quantities cannot exceed what was offered or asked; awards are append-only. Every vendor that quoted is told its result, with no other vendor's details.

**Worker (`rfq-deadlines`, every five minutes):** closes requests past their deadline and reminds invited vendors that have not quoted, 48 and 4 hours before (once each; the nearer covers the farther).

**Permissions added:** `rfq:read | create | issue | close | evaluate | award`. **Screens:** staff *Requests for quotation* (list, editor with invitations, running the request, questions, history) and the *quotes* page (sealed notice or comparison, decisions, award); vendor *Requests for quotation* (list, request with quote editor).

**Tests.** Unit `rfq.test.ts` (header, lines, quote rules and totals, stages, comparison). Integration `rfq.integration.test.ts` (18: document and invitations, issue gate, what a vendor can see, the quote end to end with database immutability, withdraw and versions, bounds, deadline and qualification, decline, sealing by the database clock, early close and no reopening, extension and addenda, questions and anonymity, comparison in cents, accept/refuse/revise windows, award rules and justification, notification counts, cancel, reminders). E2E `e2e/rfq.spec.ts` (desktop and phone).

---

## 30. V-4 as built (2026-10-24): purchase orders and the advance payment document

Migration `0077_purchase_orders`. Number kind `purchase_order` (`PO-<year>-00001`), given at **approval**, so abandoned drafts leave no gaps, and kept if the order is reopened.

**Not built here (deliberate):** the **payment voucher** and its GL posting (V-7; the advance document is complete up to `approved`, and `AdvancePaymentService.recordPayment(voucherId)` is the one door the voucher will use, refusing a second payment); receiving and invoicing (V-5, V-6: the line counters `received_quantity`, `invoiced_quantity` and the later statuses exist and are respected by amendments and cancellation, but nothing moves them yet); the approvals engine (`po.release`, `vendor.advance_payment`) — approval here is one person other than the writer, with the permission, enforced by the service **and** by a database check; approval tiers by value, branch and dimensions on the order, order attachments and order PDF.

**Writing.** A draft (header and lines together) from scratch, or **made from an award**: one draft per awarded vendor, with the awarded quantity and price, the quote's tax, payment and delivery terms, a delivery date from the quote's lead time, and links back to the request, the quote version and each award line; nothing is retyped, repeating it returns the same order, and a cancelled order frees the place (a partial unique index). Totals (discount, then tax, per line) are worked out on the server. A direct order must say why it is not from a request for quotation (`no_rfq`).

**Rules at the moment it is sent for approval.** Only its writer sends it. The vendor must be active and not blocked from everything, and **qualified in the order's category** (V-2's gate, or any category inside it); `purchase_orders:override_qualification` lets someone proceed with a **written reason that is stored and shown on the order**. A direct order above the company's **"request for quotation required above"** value (new `vendor_settings`; screen *Ordering rules*) needs `purchase_orders:skip_rfq`. The **advance flag** can be set or changed only by `purchase_orders:flag_advance`.

**Approval, sending, confirming.** Someone other than the writer approves (or sends back with a reason); `approved` → `sent` (the vendor is mailed) → `confirmed` by the vendor in the portal (owner or sales) or recorded by staff with how it was confirmed. An order not yet sent can be taken back to draft (keeping its number). **Cancel** (reason; the vendor is told if it was sent; refused once goods were received or invoiced; withdraws a waiting change and an unpaid advance; refused if an advance was paid) and **close** (force-close, reason).

**Fixed once released.** Database triggers refuse any change to a released order's number, vendor, currency, totals, advance flag or lines **except through an amendment** (which declares itself for its own transaction); receiving and invoicing may move only their own counters; a released order cannot be deleted; versions and history are append-only; an approver equal to the writer is refused by a check constraint.

**Amendments.** `purchase_orders:amend`. A change (header terms, lines, the advance flag) is compared with the current version: **any price, discount or tax change, any change of the advance flag, or a rise in value above the tolerance setting waits for someone else to approve**; a smaller order or a new date applies at once. Applying makes the next **version** (kept in full), sets the order back to `sent` (or `approved` if it was never sent), clears the vendor's confirmation, and mails the vendor **what changed, in words**. Quantities cannot go below what was received or invoiced, and a line with receipts cannot be removed. The vendor's order page shows the changes of the latest version and asks it to confirm again.

**The advance payment document** (`vendor_advance_payments`, `vendor_advance:create | approve`). Only for an order that is flagged and released; one live document per order (partial unique index); amount no more than the order total; written by one person, **approved by another** (service and check constraint); the vendor's **bank account in use is fixed at approval** (refused if there is none); the vendor is mailed. `hasCover(po)` answers the §9.4 rule for V-6: an invoice with no delivery note is allowed **only** when the order is flagged **and** an advance document for it is approved or paid, and the answer carries the exact reason so the portal can say what is missing. A paid document cannot be cancelled.

**Vendor portal.** `/vendor/orders`: only orders that have been sent (never a draft or one awaiting approval), paged, "Please confirm" marked; the order with lines, totals, terms, what has been received and invoiced, versions and their changes, the advance document's state, and the confirm button. Another vendor's order does not exist for it.

**Screens.** Staff: *Purchase orders* (list; editor for the draft, the released order and its actions; versions; history; advance panel), *Ordering rules*, and a **"Make the purchase orders…"** panel on an awarded request's quotes page. **Permissions added:** `purchase_orders:read | create | approve | release | amend | flag_advance | cancel | skip_rfq | override_qualification`, `vendor_advance:create | approve`.

**Tests.** Unit `purchase-order.test.ts` (amounts, forms, version differences, when a change needs approval, advance ceiling). Integration `po.integration.test.ts` (14: server totals, flag permission, four eyes in the service and at the database, number at approval, immutability by triggers, reject/reopen keeping the number, qualification override and request-for-quotation policy, blocked vendor, vendor visibility and confirmation, staff-recorded confirmation, an amendment through approval to version 2 with the vendor told, immediate and refused amendments, received-quantity floor, cancel and its effects, orders made from an award, the advance document end to end and `hasCover`). E2E `e2e/po.spec.ts` (desktop and phone).

## 31. V-5 as built (2026-10-24): received goods notes

**What it is.** A received goods note (RGN) records what physically arrived against a released purchase order. Tables `rgns` (header: purchase order, vendor, received date, delivery note number, vehicle, notes, who received/posted/reversed) and `rgn_lines` (delivered, accepted, rejected, reject reason, unit cost, `invoiced_quantity`), migration `0078_rgn.sql`. Numbering kind `rgn` (`RGN-{YYYY}-`), the number is assigned **when the note is posted**, not at draft.

**Rules kept by the database.** Per line `delivered = accepted + rejected`; a reason is required when anything is rejected; one *posted* note per vendor and delivery note number (partial unique index, case-insensitive); triggers `rgn_guard` / `rgn_guard_lines` make a posted note immutable except for the posting/reversal transition and the invoiced counters. `vendor_settings.receipt_tolerance_percent` is the over-receipt tolerance.

**Posting** (`RgnService.post`, permission `rgn:post`, one transaction): the order must be released (sent or confirmed or part received); accepted quantity may not exceed what is still outstanding plus the tolerance; stock lines (order line has a product) must have the same unit as the product and increase stock through `applyStockDelta` with change type `purchase_order_receipt`; then the order moves to *part received* or *received* from the totals. **Reversal** (`rgn:reverse`) refuses when any of the note is already invoiced or when the stock is no longer there; it books the stock back out with the new change type `purchase_receipt_reversal` (Dr inventory clearing / Cr inventory, `inventory-posting.ts`).

**Screens.** Staff: *Received goods* (list, editor with "Receive goods…" from a purchase order, outstanding lines prefilled), *Not yet invoiced* report. Vendor portal: the order page shows "What we received". Lookups `po-products`, `rgn-reject-reasons`, `rgn-statuses`, `po-currencies`, `po-statuses`. Permissions `rgn:read | create | post | reverse`.

**Not done on purpose (stated plainly).**
- Stock lines need a product on the order line and the same unit; a different unit is refused, not converted.
- Foreign-currency stock receipts are refused (no rate is available at this slice).
- Service and non-stock lines are only counted; there is no accrual posting to the ledger.
- Rejected goods are recorded, but there is no return-to-vendor document.
- No delivery-note attachment, and no batch or serial tracking.
- Cost follows the existing last-cost behaviour of `applyStockDelta` (it re-bases the product cost and so revalues stock on hand).
- `invoiced_quantity` counters on RGN and order lines are in place and wait for V-6 (supplier invoices).

**Tests.** Unit `rgn.test.ts` (5) and a reversal case in `inventory-posting.test.ts`. Integration `rgn.integration.test.ts` (9, passing). E2E `e2e/rgn.spec.ts` (3 tests, desktop and phone); a clean full run of it with the order and RFQ specs is still outstanding (the last run was stopped by the machine running out of memory).
