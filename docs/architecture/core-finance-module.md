# Core Finance — Module Design (General Ledger, Receivables, Customer Wallet, Refunds)

**Owner:** Finance. Finance is a **top-level sidebar module** (decided), not a sub-module of Sales. Its sub-modules: **General Ledger**, **Accounts Receivable**, **Accounts Payable**, **Bank & Cash** (bank accounts, mobile-money settlement accounts, statements, reconciliation), **Payment Setup** (providers and methods, §7.0–7.1), **Tax & Currency** and **Finance Settings**. Receivables and Payables share the journal engine, the payment methods, the bank accounts and the payment providers; they differ in their sub-ledger (customer vs vendor) and in the direction of money. Sales documents (invoices, credit notes, payments taken at the till) *cause* postings; Finance *owns* the books. Finance owns: the chart of accounts, fiscal calendar, posting setup, the journal engine and every ledger, tax setup, currencies and rates, receivables (payments, allocation, **customer wallet**, **refunds**), bank accounts and reconciliation. Accounts Payable (vendors, purchase invoices, vendor ledger, payment journal, vendor prepayments) is designed here where it shares machinery (§6a) and built after Receivables; fixed assets and cost accounting come later and must fit the same engine.

**Status:** DRAFT, revised 2026-10-12 after your answers (finance top-level; AR and AP; payment providers vs payment methods as in Business Central; no secrets in env; Daraja sandbox available; high-traffic target). Nothing here is built. This document replaces the "AC-1..AC-8 draft" that was awaiting approval (§9 holds the revised, numbered rules that supersede it). Part of the [Sales Order Platform blueprint](./sales-order-blueprint.md); read with [approvals-module.md](./approvals-module.md) and [pricing-module.md](./pricing-module.md).

**Goal:** a core finance system with the power and posting discipline of Microsoft Dynamics 365 Business Central, configurable to the core so that any African market, tax regime, chart of accounts and payment habit can be expressed **as data**, with nothing hard-wired to a national standard. Where this document says "default", it means a shipped, editable configuration, never a rule in code.

---

## 1. Principles (Finance-specific, on top of blueprint P1–P10)

| # | Principle | Consequence |
|---|---|---|
| F1 | **One door for money.** Every financial effect is a *journal* posted by the posting engine. No service writes to a ledger table directly. | Ledgers are written by exactly one module, so they cannot disagree. |
| F2 | **Posted means immutable.** Ledger entries, registers and posted documents are never updated or deleted (database triggers enforce it, as the decision log already does). Mistakes are corrected by a *reversal* or a *further document*, each with a reason. | The books are trustworthy to an auditor and to the owner. |
| F3 | **Sub-ledgers and the General Ledger always agree.** Every sub-ledger entry (customer, wallet, bank) is posted together with its G/L entries in the same transaction, and a control-account check proves it. | No month-end "why are the debtors different from the GL" hunt. |
| F4 | **Configuration, not code, for every business rule.** Accounts, posting groups, payment methods, refund policy, wallet policy, rounding, tax, fiscal year shape, numbering: all data, all versioned, all effective-dated, all approvable. | An exact local business can be configured without a release. |
| F5 | **Secure by default; one explicit permission per action.** Nothing is allowed because a user is "an admin". Every action that changes money or finance configuration has its own permission key (§12). | If something happened, it was done by someone holding that exact permission. |
| F6 | **Everything records who, what, when, why and from where** (§13). | Trace any figure back to the actor, reason, time and the part of the system it came from. |
| F7 | **Money out is never silent and never single-handed.** Any action that pays money out can be put behind approval, evidence and limits. Automated payout (M-Pesa) has its own permission, its own limits and its own kill switch. | A compromised or mistaken user cannot drain the business. |
| F8 | **Defaults are shipped data.** The "standard way of doing things" (IFRS-style chart, double entry, accrual) ships as the default *template*; every part of it can be replaced. | Standard where useful, never a cage. |
| F9 | **Both flows, completely.** Wallet (money kept for the customer) and refund (money returned to the customer) are two fully built, independent flows. A company chooses per policy which it offers, to whom, and for which reasons; either can be off. | Businesses that refund and businesses that never refund both work. |

---

## 2. What Business Central does, and what we keep, change, improve

| Business Central concept | Ours | Note |
|---|---|---|
| **G/L Account** (Posting, Heading, Begin-Total, End-Total, Total; account category and subcategory; Direct Posting; Blocked) | `gl_accounts` with the same types, plus **statement mapping** (balance-sheet and income-statement lines are configurable report layouts, not hard-wired to the account number) | Account numbers are free text per company; ranges are only for totals. |
| **General Journal / Cash Receipt Journal / Payment Journal** (batches, templates, lines) | `journal_templates`, `journal_batches`, `journal_lines` (draft, editable) → **post** → `ledger_registers` | Documents (invoice, credit note, payment, refund) *build* journal lines in memory and post them through the same engine, as BC documents do. |
| **G/L Entry** | `gl_entries` (append-only, partitioned by month) | |
| **Cust. Ledger Entry + Detailed Cust. Ledger Entry** | `customer_ledger_entries` (exists; extended) + `customer_detailed_entries` (new: initial entry, application, unapplication, FX gain/loss, discount, write-off, rounding) | The detailed ledger is what makes *unapply* and exact aging possible. |
| **Unapplied payment / prepayment** (a negative customer ledger entry) | **Customer Wallet** (§8): a separate liability sub-ledger, not a negative debtor | Requested explicitly: wallet is *not* a refund and not a debtor credit. |
| **Bank Account Ledger Entry**, Bank Reconciliation, Payment Reconciliation Journal (auto-match, statement import) | `bank_accounts`, `bank_ledger_entries`, `bank_statements`, `bank_statement_lines`, matching rules (§7.4) | Includes mobile-money settlement accounts. |
| **Posting groups** (General Business, General Product, Customer, VAT Business/Product) and **General Posting Setup**, **VAT Posting Setup** | Same model: *which account does this kind of thing post to* is a table lookup, never code. Setup is effective-dated and versioned. | |
| **VAT entries** | `tax_entries`: one per tax line posted, linked to the G/L entry, with the tax rate, base, jurisdiction and the fiscal document that carries it | Tax regimes (VAT, GST, sales tax, withholding, excise) are configured, not coded. |
| **Dimensions** (global 1–2, shortcut 3–8, dimension sets) | The existing `dimensions`, `dimension_values`, `dimension_sets`: every journal line carries a dimension set; accounts can require, allow or forbid a dimension | Already built; Finance becomes its heaviest user. |
| **Accounting periods**, "Allow Posting From/To", fiscal year close | `fiscal_calendars` (any shape: 12 months, 4-4-5, 13 periods, a year starting in July), period status (open, soft-closed, closed, locked), per-user posting windows | |
| **Posting Preview** | `preview()` runs the full posting in a rolled-back transaction and shows every entry that *would* be written | Required before any posting button in the UI. |
| **Reverse entries**, **Unapply** | `reverse(register)` posts an equal-and-opposite journal linked to the original; `unapply(application)` | Both need explicit permission, reason, and respect period locks. |
| **Payment Terms / Payment Methods / Payment Registration** | `payment_terms`, `payment_methods` (§7.1), a quick "register payment" screen | |
| **Reminders / Finance Charge Memos** | Later: dunning levels as configured, traced actions (blueprint §9) | |

**Improvements over Business Central:** per-document *posting trace* (which setup row chose which account, and why), preview everywhere, effective-dated posting setup, a first-class wallet and refund lifecycle, mobile-money and evidence as native concepts, configuration-as-data localisation packs (§4.3).

---

## 3. The posting architecture

### 3.1 The pipeline (one for every financial event)

```
Business event (invoice posted, payment received, credit note issued, refund paid, restock confirmed …)
  → Posting request (document kind, document id, posting date, currency, amounts, dimensions, idempotency key, origin)
  → Setup resolution   (posting groups → accounts; trace recorded)
  → Journal build      (balanced lines in document currency and base currency)
  → Validation         (period open, accounts postable and not blocked, dimensions satisfied, balanced, currency rate present, permissions)
  → [Preview?]         (stop here: return the would-be entries)
  → Post, one DB transaction:
        ledger_register row  ·  gl_entries  ·  sub-ledger entries (customer, wallet, bank, tax, detailed)  ·  decision-log row  ·  outbox events
  → After commit: signing/transmission (KRA etc.), notifications, projections
```

* **Single transaction, all or nothing.** If posting fails, the business event fails (a credit note without its postings must not exist). Fiscal signing and other external calls stay *after* commit and never block, as today.
* **Idempotent.** The idempotency key (`<document kind>:<document id>:<posting purpose>`) is unique on the register; posting twice returns the first result.
* **Balanced by construction.** Debit total equals credit total in document currency *and* in base currency, per posting date, enforced in code and by a deferred database constraint on the register.
* **Ordered and gap-free where it matters.** Register numbers and G/L entry numbers come from the kernel numbering (gap-free series in the posting transaction).
* **Concurrency.** No global lock. Contention is per customer (application) and per document (idempotency). Balances are derived or held per account per period in a summary table updated in the same transaction (needed at 900k documents a day; see §14).

### 3.2 Ledgers (all append-only, all with triggers that reject UPDATE/DELETE)

| Ledger | One row per | Key columns (besides ids, amounts, currency, rate, posting date, document type/no, dimension set, register id, origin) |
|---|---|---|
| `ledger_registers` | posting run | `register_no`, `from_entry`, `to_entry`, `source` (document kind/id or journal batch), `posted_by`, `reason_code`, `reversal_of`, `idempotency_key`, `posting_trace` |
| `gl_entries` | account × side × line | `account_id`, `debit`, `credit` (positive; one is zero), `base_debit`, `base_credit`, `description`, `source_ledger` + `source_entry_id`, `reversed_by`, `tax_entry_id` |
| `customer_ledger_entries` | invoice, credit note, payment, refund, finance charge | `customer_id`, `document_type`, `open` (bool), `remaining_amount` (the *only* mutable-looking field: it changes **only** through detailed entries, never by UPDATE of the posted row; see 3.3) |
| `customer_detailed_entries` | every change to a customer entry | `entry_type` (initial, application, unapplication, fx_gain, fx_loss, payment_discount, write_off, rounding), `applied_to_entry_id`, `amount` |
| `wallet_entries` | wallet movement | §8 |
| `bank_ledger_entries` | movement on a bank or mobile-money account | `bank_account_id`, `amount`, `statement_line_id` (when reconciled), `open` |
| `tax_entries` | tax line | `tax_code_id`, `jurisdiction`, `base`, `amount`, `direction`, `fiscal_document_id` |
| `refund_entries` / `refund_events` | see §10 | lifecycle, append-only |

### 3.3 About "remaining amount"

`customer_ledger_entries.remaining_amount` exists today and is updated in place. Under F2 this changes: the posted row is never updated; `remaining_amount` becomes the **sum of detailed entries** for that entry. For speed the sum is kept in a `customer_entry_balances` row updated *in the same transaction* as the detailed entry that changes it (and verified by a nightly job that recomputes it from the detailed ledger and raises an alert on any difference). This is the one deliberate denormalisation.

### 3.4 Posting setup (the "which account?" tables)

All effective-dated, versioned, approvable, with a **resolution trace** stored on the register:

* `posting_groups` of kinds: customer, item/service, business (market/channel), payment method, bank account, tax.
* `general_posting_setup (business_group × product_group → sales, sales credit memo/returns, sales discount, COGS, inventory adjustment, … accounts)`.
* `customer_posting_groups → receivables account, customer deposits (wallet) account, service charge, payment discount, rounding, FX gain/loss, bad-debt write-off, refunds payable`.
* `tax_posting_setup (tax business × tax product → output tax, input tax, withholding, reverse-charge accounts)`.
* `bank_account_posting → G/L account, clearing account, fee account`.

A missing row is a hard, explained error naming the exact setup row to create (never a silent default). The shipped **template** fills these in for the default chart.

### 3.5 Periods, dates and currency

* **Posting date** is separate from **document date** and **creation time**. The posting date must fall inside an open period and inside the user's own allowed window.
* Period statuses: *open*, *soft-closed* (only users with the "post to soft-closed period" permission), *closed* (only the period-reopen permission, approval-gated), *locked* (year-end; no reopening, correction goes in the next open period).
* Every posting stores document currency amount, the rate, the rate source (rate table, manual, document-fixed) and base-currency amount (blueprint §4.6a). Application across currencies posts realised FX gain/loss through the detailed ledger. Month-end revaluation of open foreign balances is a later, journal-based job.

---

## 4. Chart of accounts and localisation

### 4.1 Chart of accounts

* `gl_accounts`: `no` (free text, unique per company), `name`, `type` (posting, heading, begin-total, end-total, total), `category` (assets, liabilities, equity, income, cost of sales, expense) and `subcategory`, `normal_balance`, `direct_posting` (false for control accounts: receivables, customer deposits, inventory, tax, bank — only the engine may post to them), `blocked`, `requires_dimension` rules, `currency_policy` (base only / any / one specific), `reconcile` flag for sub-ledger control accounts, `totaling` for total accounts, `translations`.
* Indentation, ranges and totals are presentation; they never change what an account *is*.
* A control account (debtors control, customer deposits control, bank) can be posted **only** by the engine from its sub-ledger. A manual journal to a control account is refused, with the reason. This is what keeps F3 true.

### 4.2 Templates ("the default that can be completely reconfigured")

Chart templates are data bundles: accounts, statement layouts, posting groups and setup, tax codes, payment methods, wallet and refund policies, number series, fiscal calendar. Shipped templates (all editable after import, none privileged in code):

* **International default** (IFRS-style, English), the "standard way".
* Regional starting points, one per accounting tradition we will cover: **Kenya** (KRA eTIMS, VAT 16 %, withholding VAT/income tax), **Nigeria**, **Ghana**, **Tanzania/Uganda/Rwanda**, **South Africa**, **Egypt/Morocco** (including a French/Arabic-named chart), and a **SYSCOHADA/OHADA** francophone chart (17 countries), **Ethiopia**.
* A **blank** template, and **import from CSV/Excel** for a company bringing its own chart.

A template is applied once, in a transaction, with a preview. After that the company owns the rows. Template updates never overwrite a company's data; they are offered as a diff.

### 4.3 Localisation packs (nothing national lives in code)

A *pack* is configuration the platform ships per market and a company can adopt, copy or ignore:

| Part | Examples of what varies across Africa |
|---|---|
| Fiscal calendar | January–December, July–June, Ethiopian calendar, 13 periods |
| Tax | VAT/TVA rates and classes, withholding, excise, stamp duty, reverse charge, tax-inclusive vs exclusive prices, rounding rules |
| Statutory e-invoicing | KRA eTIMS (built, becomes the **Kenya adapter**), Tanzania TRA VFD/EFD, Rwanda EBM, Uganda EFRIS, Nigeria e-invoicing, Egypt ETA, South Africa SARS, Ethiopia: each an *adapter* behind the same port the KRA service already uses |
| Payment methods | §7.1 |
| Statutory reports | trial balance, VAT return, withholding certificates in each market's layout (report layouts as data) |
| Language and format | currency symbol position, decimals, date formats, RTL, translated account names |

**Rule:** if a behaviour differs by country it must be a row in a pack, an adapter, or a policy. A country name in an `if` is a defect.

---

## 5. Where the existing code fits

| Today | Becomes |
|---|---|
| `customer_ledger_entries` (amount, remaining_amount, due date) | Kept and extended (§3.3). Existing rows are migrated into the new shape with an opening-balance register. |
| `transaction_ledger_entries` (debit/credit, invoices and payments only, no accounts) | A **subset view** of the new model for the transition: new postings write `gl_entries` and the engine also writes the legacy row until readers (reports, reconciliation) are moved, then the table is frozen. No history is rewritten. |
| `payment_transactions`, `payment_attempts`, `payment_callback_events`, adapters (M-Pesa Daraja, Jenga, KCB Buni, Pesapal) | Stay as the *gateway* layer. A confirmed gateway payment calls the Finance posting door; gateways never write ledgers. |
| `reconciliation` domain (flags "refund required") | Becomes a producer of *refund requests* and of bank-statement matches; it stops being the place a refund is "decided". |
| `credit-notes` service (CN-1…CN-14, KRA signing) | Unchanged for numbering, signing and quantity rules. It gains a *resolution step* (§9) and posts through the engine in its own transaction. |
| `taxes`, `currencies` | Move under Finance as configuration owners; the exchange-rate table gains dated rates and sources. |
| `permissions.ts` (`payments:refund` etc.) | Replaced by the specific permission set in §12, with migration of existing role assignments (§12.3). |
| Gift card, loyalty and rebate ledgers (pricing P-4) | Their *liability* postings (gift card = deferred revenue/liability, loyalty = provision, rebate = accrued rebate) go through the engine as soon as F-3 lands (§15). |

---

## 6. Receivables overview

Order → billing document (invoice) → **customer ledger entry** (debtor) → payment → **application** → closed. Credit note → application against the invoice → **resolution** of any excess (wallet / refund / write-off). Wallet → utilisation against later invoices. Everything above posts through the engine; every step has a document, a number, an actor, a reason.

---

## 6a. Accounts Payable and the shared machinery

Accounts Receivable and Accounts Payable are two sub-ledgers on one engine. Built second, but designed now so nothing in F-0 to F-6 has to be redone:

| Shared | Receivable side | Payable side |
|---|---|---|
| Journal engine, registers, GL entries, dimensions, periods, preview, reversal | customer ledger + detailed ledger | **vendor ledger + detailed vendor ledger** |
| Posting groups | customer posting group (receivables, customer deposits, discounts, write-off, rounding, FX) | **vendor posting group** (payables, vendor prepayments, discounts received, rounding, FX) |
| Payment methods and bank accounts | customer receipts, refunds | **vendor payments**, vendor refunds received |
| Payment providers | collect (STK, paybill, card); refunds out | **payout** (B2C/B2B, bank payment files), remittance |
| Allocation / unapply / cheques | receipt applied to invoice | payment applied to purchase invoice; cheque issued |
| Customer wallet | liability to customer | mirror: **vendor prepayment** (an asset: advance to a vendor) |
| Refund lifecycle | pay customer back | payment **proposal and batch** lifecycle (suggest due invoices, approve, execute, reconcile): the same state-machine, approvals, evidence and permissions model |
| Bank statements and matching | match receipts | match payments |

Vendor master, purchase documents and goods receipt belong to the future purchasing flow; Finance owns only the ledgers, posting and payment side. Permission keys for AP follow the same pattern as §12 (`vendor_payments:create|approve|post|…`) and are added when that slice is specified.

---

## 7. Payments (receipts), allocation, bank and mobile money

### 7.0 Providers, methods and bank accounts are three different things (as in Business Central)

Today the system has one concept doing three jobs: `orders.payment_method` is free text that holds a **provider code** (default `mpesa_daraja`), and credentials live in `payment_provider_configs` (per branch). Business Central keeps these apart, and so do we:

| Concept | What it is | Business Central equivalent | Owns |
|---|---|---|---|
| **Payment provider** (connection) | A technical integration to an outside service: M-Pesa Daraja, Pesapal, Jenga, KCB Buni, a bank API, later Airtel/MTN. | *Payment Service* / bank export-import setup | Credentials, environment (sandbox/production), base URL, callback/result/timeout URLs, **capabilities** (collect, payout, reverse, status query, statement, balance), limits, health. No accounting. |
| **Payment method** (finance rule) | *How* a customer or vendor pays or is paid, and what that does to the books: cash, EFT, cheque, M-Pesa paybill, M-Pesa STK, wallet, card… | *Payment Method* (balancing account, bank/cash link, direct debit, document defaults) | The balancing account (bank account / cash account / clearing account), reference and evidence rules, settlement delay, fee policy, who may use it, whether it is valid for **collecting**, **refunding** and **paying vendors**, and an optional **provider binding**. |
| **Bank account** (money container) | Where the money sits: a bank account, a cash drawer/till, a mobile-money settlement account (a paybill or till number), a clearing account. | *Bank Account* | G/L account link (posting group), currency, statement format, reconciliation state, and the optional link to the provider account that fills it. |

Linkage: `payment_method → balancing bank_account` (always) and `payment_method → provider binding` (optional, separate bindings for *collect* and *payout*, because the provider that collects (STK) is not always the one that pays out (B2C), and a method with no binding is a purely manual method such as cash or cheque). A provider is **never** referenced from a document; a document references a payment method, and the method resolves the provider at the moment of use (recorded on the payment). `orders.payment_method` (text) becomes `payment_method_id`; the migration maps existing text values (`mpesa_daraja`, `pesapal_v3`, …) to seeded methods so no history is lost, and the original text is kept in the payment record.

**Configuration rule (from you): nothing is read from environment variables.** Every provider credential, base URL, environment flag, shortcode, passkey, initiator name, security credential, callback/result/timeout URL, limit, and method setting is **stored in the database and edited from the screen**, with credentials sealed (AES-GCM, as `payments/crypto.ts` already does) and write-only in the UI (shown masked, replaceable, never read back), each change permissioned, approval-capable and logged. A **Test connection** button per provider and environment runs a harmless call (token request, status query) and records the result. The only things that cannot live in the database are the bootstrap secrets needed to reach it: the **database connection string** and the **master data-encryption key**. Findings from the current code that this design fixes:

* The master key is read from `DATA_ENCRYPTION_KEY`/`PAYMENT_DATA_KEY`, and **outside production a fixed key derived from a constant is used when unset**. Decision: the key is mandatory everywhere (no deterministic fallback, a missing key stops the app with a clear message); sealed blobs carry a **key id** so keys can be rotated and old blobs re-sealed by a permissioned job; the key may be supplied by a secrets manager or file mount instead of a plain variable. This is the single, documented exception to "nothing from env".
* The public base URL used to build callback addresses (`APP_URL`, `NEXTAUTH_URL`, …) becomes a **company setting** ("Public address of this system"), validated as HTTPS, shown on each provider screen beside the exact callback URLs to register with the provider.
* Two config tables exist today: `payment_provider_configs` (per branch, used by the adapters) and `payment_gateway_configs` (global, used by the admin payment screen). F-1 unifies them into one provider model, with a migration that preserves sealed credentials.

**Per-branch and per-company providers.** A provider account can be company-wide or branch-specific (a branch with its own till number), exactly as the current per-branch config allows; the bank account it settles into is chosen per provider account.

**Capabilities are declared, not assumed.** Each adapter declares what it can do (`collect`, `payout`, `reverse`, `status_query`, `register_urls`, `balance`, `statement`), and the UI offers only what the connected provider supports. Today the Daraja code supports **STK Push and its callback only**; reversal, B2C, transaction status, account balance and C2B URL registration are new work in F-6 and are testable on the Daraja sandbox with the credentials you hold (sandbox behaviour for reversal and B2C is partly simulated, so production-only constraints are still verified before go-live).

### 7.1 Payment methods are data

`payment_methods`: `code`, `name`, `kind` (cash, bank_transfer, bank_deposit, cheque, mobile_money, card, gateway, wallet, gift_card, offset, other), `balancing_account` (bank account / cash account / clearing account), `requires_reference`, `requires_evidence`, `requires_counterparty_details` (cheque number, bank, drawer), `balancing_bank_account_id` (required), `provider_binding_collect` / `provider_binding_payout` (optional provider account + capability), `usable_for` (customer receipts, customer refunds, vendor payments, vendor receipts), `settlement` (immediate / delayed N days / on statement), `fee_policy` (fixed, percentage, who bears it, fee account), `allowed_for` (customer groups, branches, channels, amounts), `can_refund_to` (this method is a valid refund destination: yes/no, automatic/manual), `limits`, `enabled`.

Shipped, none privileged: Cash; Bank transfer/EFT/RTGS/SWIFT; PesaLink; Cheque; Bank deposit slip; Direct debit; Card; **M-Pesa** (paybill, till, STK push); **Airtel Money, MTN MoMo, Orange Money, Tigo/Tanzania mobile money, Telecel/Vodafone Cash, EcoCash, Wave, Opay/PalmPay**; USSD/agent banking; Customer wallet; Gift card; Contra/offset. A company adds a new method (a new mobile-money scheme, a local cooperative voucher) from the screen, with no release.

### 7.2 Payment document (cash receipt)

A **payment** is a document with a number (series "RCT"), customer, method, bank/cash account, amount, currency and rate, payment date, posting date, external reference, payer details, **evidence attachments** (deposit slip, screenshot, cheque image), notes, branch and dimensions, **source** (see below) and status: `draft → (pending approval) → posted → (reversed)`; cheques add their own lifecycle. Posting creates: Dr bank/cash (or clearing) / Cr receivables control (or customer deposits when unallocated/excess, §8).

**Sources** (all land in the same document type, differing only in how they arrive):

1. **Manual entry** by a cashier or accountant (cash, bank, cheque, other).
2. **Gateway confirmation** (STK push / paybill callback / card / Pesapal): created automatically from the already-built callback pipeline.
3. **Bank statement line** matched or created from an imported statement (§7.4).
4. **POS tender** (Phase 4) and **customer portal** payment.
5. **Journal import** (CSV) for bulk receipts.

### 7.3 Allocation (cash application)

* A payment is allocated to open invoices (and debit notes) by: automatic (oldest first, or by reference/invoice number in the narration), manual selection, or left **unallocated**.
* Allocation writes **detailed entries** (§3.2), never edits an invoice. **Unapply** is a posted, permissioned, reasoned action that writes the opposite detailed entries.
* **Partial** payment of an invoice, **one payment to many invoices**, **many payments to one invoice**, **payment discount** (terms-based, with its own account), **rounding**, **FX difference**: all supported.
* Excess over what is open is **never** a negative debtor. It becomes a wallet deposit when the policy allows (§8), otherwise it stays *unallocated* in a suspense account until someone decides (wallet, refund, hold), with a reminder.
* Credit-limit effect is computed from open receivables only; wallet balance is shown beside it, never netted silently.

### 7.4 Bank statements and reconciliation

* `bank_accounts` cover bank accounts and mobile-money settlement accounts (paybill/till).
* **Import** statements from CSV/Excel with a saved column mapping per bank, MT940, CAMT.053 and an M-Pesa statement/Org portal export; later direct bank APIs. An import is a batch with a file hash (the same file cannot be imported twice) and an uploaded copy kept as evidence.
* **Matching rules** (configurable, ordered, with a trace): exact reference to payment/invoice number, amount + date window, phone number, bank reference, fuzzy narration; a line is auto-matched, proposed, or left for a human. One line may create a payment; one line may match several; fees and charges lines post to the fee account.
* **Reconcile** = bank ledger entries marked closed against statement lines; the reconciliation is a document with opening/closing balance, difference, who reconciled and when, and is itself immutable once posted.
* A statement line for money the business paid out (refund) closes the refund (§10.6).

### 7.5 Cheques

Lifecycle with postings: `received → deposited → cleared` (clearing moves the money from "cheques in transit" to the bank account) or `bounced` (reverses the payment and re-opens the invoices, optionally posts a bounce fee) or `cancelled`. Post-dated cheques are held as *received* until their date. Every transition is permissioned, reasoned and traced.

---

## 8. Customer Wallet

### 8.1 What it is, and the accounting terms

The wallet is the customer's **credit balance held by the business**. It is **a liability** of the business to the customer, not a debtor: in the books it is **"Customer deposits" (also called customer credit balances or advances from customers)**, in a dedicated control account from the customer posting group. It is *not* an unapplied payment parked in receivables, and *not* a refund. Customer-facing name is configurable ("Wallet", "Account credit", "Store credit"); the ledger terms stay industry standard:

| Movement | Term in the ledger | Posting |
|---|---|---|
| Money received that is not for an invoice (advance, deposit) | **Deposit / advance receipt** | Dr Bank/Cash · Cr Customer deposits |
| Payment exceeding what is owed | **Overpayment credited to wallet** | Dr Bank/Cash · Cr Receivables (to clear) and Cr Customer deposits (excess) |
| Credit note excess (invoice already paid) sent to wallet | **Credit note to wallet** | Dr Sales returns / Cr Customer deposits (after invoice applied) |
| Refund redirected to wallet | **Refund to wallet** | Dr Refunds payable · Cr Customer deposits |
| Wallet used against an invoice | **Wallet utilisation (application)** | Dr Customer deposits · Cr Receivables |
| Wallet balance paid out in cash | **Wallet withdrawal / cash-out** | Dr Customer deposits · Cr Bank/Cash (via a refund, §10) |
| Balance unclaimed and expired by policy | **Expiry / forfeiture** (only where law and policy permit) | Dr Customer deposits · Cr Other income, approval-gated |
| Manual correction | **Adjustment** | Needs permission, reason and approval limits |

### 8.2 Data

* `customer_wallets`: one per customer **per currency**, with status (active, frozen, closed). Created on first use.
* `wallet_entries` (append-only): `wallet_id`, `entry_type` (deposit, overpayment, credit_note, refund_to_wallet, utilisation, withdrawal, expiry, adjustment, reversal), `amount` (signed), `source_document` (payment, credit note, refund, invoice), `applied_to_entry_id`, `reason_code`, `expires_at`, plus the usual actor/origin/register fields. Balance = sum, held in `wallet_balances` updated in the same transaction (same guard as §3.3).
* **Never negative.** A utilisation or withdrawal that exceeds the balance is refused inside the posting transaction (row lock on the wallet, `NOWAIT`/bounded retry).

### 8.3 Utilisation

* **Manual:** at invoice time or from the customer screen, choose how much wallet to apply.
* **Automatic (policy):** on invoice posting, apply the wallet oldest-first up to the invoice amount, or never, or only when the customer ticks it. Per customer group.
* **At the till/checkout:** wallet is a tender (payment method `wallet`).
* Utilisation creates a normal application in the customer detailed ledger plus a wallet debit. Its reversal (invoice cancelled, credit note issued on a wallet-paid invoice) credits the wallet back by default, or goes to refund, per policy (§9).

### 8.4 Policy (the "refund or wallet" switch)

`customer_credit_policies`, effective-dated, attachable to company / customer group / customer / branch / payment method / reason:

* `wallet_enabled` (can a wallet exist), `allow_deposits`, `allow_overpayment_to_wallet`, `overpayment_default` (wallet | hold | ask),
* `refunds_enabled`, `refund_allowed_reasons`, `refund_destinations_allowed` (original method, mobile money, bank account, cheque, cash, wallet),
* `credit_note_excess_default` (wallet | refund | ask), `wallet_expiry_days` (none by default), `wallet_cash_out_allowed`,
* `minimum_wallet_balance_to_keep`, `max_wallet_balance`, `approval_thresholds`.

A **"no refunds" business** sets `refunds_enabled = false`: every excess goes to wallet, there is no refund button, and the engine refuses a refund request with the reason. A **"refunds only" business** sets `wallet_enabled = false`. Both are first-class; the code paths are the same, the data differs.

### 8.5 Screens

Customer → Wallet tab (balance, ledger, expiring soon), "Add deposit", "Use wallet", "Cash out wallet (creates a refund)", "Adjust" (guarded), statement PDF/CSV, wallet in the order and invoice payment panels, wallet liability report (total owed to customers, ageing, by branch), reconciliation of wallet control account to wallet sub-ledger.

---

## 9. Credit notes: revised accounting rules (supersede AC-1…AC-8)

A credit note reduces what the customer owes for goods or amounts invoiced. Its financial effect is decided in three stages: **post**, **apply**, **resolve**.

**CN-AC-1 Post (same transaction as the credit note).** The engine posts the credit note: Dr Sales returns / sales (and Dr output tax, reducing tax payable) · Cr Receivables control, with a customer ledger entry (credit) and tax entries keyed to the credit note and the original invoice. If posting fails the credit note is not created. Signing with KRA (or the market's e-invoicing adapter) stays after commit and never blocks.

**CN-AC-2 Apply.** The credit is applied first to the original invoice's **open** amount (detailed entries). That reduces the debtor and frees credit limit immediately.

**CN-AC-3 Resolve the excess.** Anything beyond the open amount (the invoice was already paid wholly or partly) is a **credit-note excess**. It must be *resolved* by one of: **(a) to wallet**, **(b) to refund**, **(c) leave on account / hold** (rare, timed), **(d) write-off** (only for the business's loss, e.g. goodwill, approval-gated). The destination is chosen by `credit_note_excess_default` and the credit policy (§8.4) and may be changed by a user holding the resolve permission. Unresolved excess stays in a `credit_note_excess` suspense state and appears on a worklist; it cannot be forgotten.

**CN-AC-4 Cash customers** paid at sale: the whole credit is excess and is resolved as above (default: refund to original method if refunds are enabled, otherwise wallet if the customer exists, otherwise refund by another method).

**CN-AC-5 Restock is a confirmed physical act, not a tick.** A credit note can *request* a restock per line with a disposition (return to stock, quarantine, scrap/write-off, return to supplier). Stock is **only** added when someone holding the restock-confirm permission confirms receipt of the goods with quantity and condition (and, per policy, evidence). Posting: Dr Inventory · Cr Cost of sales (for returned stock at its original cost, kept per sale since P-5); scrap/damage: Dr Inventory write-off expense · Cr Cost of sales. Restock is offered only where stock was actually taken for the order (existing rule). Defaults (editable policy by reason): returned goods → request restock; pricing error/goodwill → none; damaged → write-off.

**CN-AC-6 Order status** is unchanged by a credit note; cancelling is a separate action.

**CN-AC-7 Payment status** of the order becomes `refunded` **only** after a *full* refund of the amount paid reaches `paid` in the refund lifecycle (§10), with the whole lifecycle recorded. Partial refund leaves `paid` and records a `partially_refunded` indicator on the refund records (a status can be added later without a data change). A wallet resolution does **not** make an order `refunded`; it records `credited_to_wallet`.

**CN-AC-8 Immutability.** Posted credit notes cannot be edited or deleted. A mistake is corrected by a reversing document (a debit note re-invoicing, or a reversal entry with reason), as in CN-13.

**CN-AC-9 Permissions and reasons.** Issuing, resolving, restock-requesting, restock-confirming and writing off are each their own permission (§12). Every step records actor, reason code, free text where required, timestamp and origin.

**CN-AC-10 Liability instruments (pricing P-4)** use the same door: gift card issuance Dr Bank · Cr Gift card liability; redemption Dr Gift card liability · Cr Receivables/Revenue; breakage and expiry per policy; loyalty points as a provision (accrue at sale, release at redemption/expiry); rebates as accrual Dr Sales rebates expense · Cr Rebates payable, settled via the existing approval to a customer credit (wallet or payment).

---

## 10. Refunds — end to end

### 10.1 What a refund is

A **refund** is money the business **pays out to a customer** because it owes them (credit note excess, cancelled paid order, overpayment the customer asks back, wallet cash-out, duplicate payment, goodwill). It is a first-class document, not a flag. It is always created from a *source obligation* so the amount can never exceed what is owed.

### 10.2 Documents and state machine (kernel state-machine kit)

`refund_requests` (number series "RFD"), `refund_lines` (source obligations), `refund_events` (append-only lifecycle), `refund_evidence` (attachments), `refund_payouts` (one per attempt to send money).

```
draft ─submit→ pending_approval ─approve→ approved ─queue→ processing ─confirm→ paid ─reconcile→ reconciled
   │                  │ reject→ rejected ─reopen→ draft (linked new request)
   │                  └ cancel→ cancelled
   ├─(no approval workflow matches)→ approved
processing ─fail→ failed ─retry→ processing | ─switch method→ approved | ─give up→ cancelled
processing ─timeout/unknown→ in_doubt ─resolve (statement/provider query)→ paid | failed
approved ─waive→ waived (reason, permission; the obligation closes without payout)
paid ─reverse payout (returned by bank/provider)→ returned ─redirect→ wallet | approved (new payout)
```

* States are **terminal-safe**: `paid`, `rejected`, `cancelled`, `waived`, `reconciled` cannot be edited; a mistake is a new document linked to the old one (as for credit notes).
* **Approval:** uses the existing approval engine (a `refund.payout` trigger in module Finance): condition builder (amount, method, reason, customer group, branch, requester, count today), approver chain, limits, escalation, delegation. *No workflow matching = proceed*, as already decided; a company that wants every refund approved sets a catch-all workflow. **Segregation of duties** is a setting: the requester cannot approve, and the approver cannot record the payout, unless the policy explicitly allows it for small amounts.
* **Evidence:** every refund requires evidence according to the method: manual recording requires an attachment (payment slip, bank confirmation, M-Pesa SMS/statement, signed receipt, customer ID photo for cash). An automated payout stores the provider's receipt/response as evidence automatically. Attachments use the media domain, are hashed, and are never deletable after submission.

### 10.3 Destinations (refund methods are data too)

| Destination | Execution | Evidence |
|---|---|---|
| **Original payment method** | Automatic where the provider supports reversal (M-Pesa reversal, card refund via gateway); else manual | Provider reference |
| **M-Pesa reversal** (C2B transaction reversal) | Automated (§10.4) | Result callback |
| **M-Pesa B2C to the customer's phone** | Automated (§10.4) | Result callback |
| **Other mobile money** (Airtel, MTN MoMo, …) | Via adapter when available; otherwise manual | Provider SMS/statement |
| **Bank transfer to the customer's bank account** | Manual, or generated **payment file** (bank bulk format) uploaded to the bank, then closed from the statement | Bank confirmation / statement line |
| **Cheque** | Cheque issued and recorded (number, date), cleared from statement | Cheque copy / statement |
| **Cash** (at branch) | Manual, with the cashier's till and the customer's acknowledgement | Signed receipt |
| **Customer wallet** | Instant, internal; only for customers existing in the system; no approval unless the policy asks | Wallet entry |
| **Contra** (offset against another debt the customer owes) | Internal application | Detailed entries |

Customer bank/phone details used for payout are stored on the refund (snapshot) and require the *change-payout-details* permission when they differ from the customer's recorded details (fraud control); a changed destination always triggers approval regardless of amount, configurable.

### 10.4 M-Pesa automation (Daraja)

Built on the existing Daraja adapter and callback pipeline, with **every Daraja setting (consumer key/secret, shortcode, passkey, initiator name, security credential, result/timeout/confirmation/validation URLs, environment, limits) stored sealed in the database and edited on the provider screen (§7.0), nothing from env**; sandbox and production are separate provider accounts so a sandbox test can never touch production money. **Capability, limits and credential requirements must be re-verified against the current Safaricom Daraja documentation before the build slice starts**, because Transaction Reversal and B2C each have constraints (who may initiate, transaction types and time windows eligible for reversal, required security credentials, per-organisation limits). The design therefore **never assumes reversal will succeed**:

1. **Choose path:** if the original payment was an M-Pesa C2B transaction we hold, attempt *Reversal* (full or as supported) first; if reversal is not possible (ineligible, partial amount, rejected) fall back to *B2C* to the payer's number; if neither is configured, fall back to *manual*. The fallback order is configuration; each fall-back is recorded with its reason.
2. **Safety:** the initiate-payout permission is separate from the approve and record permissions; per-user, per-day and per-transaction **limits**; **kill switch** (company setting that disables all automated payouts instantly, itself guarded and logged); an allow-list of destination numbers (the original payer by default); confirmation re-entry (second factor or re-authentication) for amounts above a threshold.
3. **Idempotency:** a payout carries a deterministic originator conversation ID; a retry after a timeout first *queries* the provider's status, never blindly re-sends. State `in_doubt` exists for exactly this and has a worklist and an SLA alarm.
4. **Callbacks:** result and timeout URLs are authenticated and replay-safe through the existing callback-event pipeline; the handler is idempotent and moves the refund through `processing → paid | failed`, then posts the payout.
5. **Reconciliation:** the provider's settlement statement line closes the refund to `reconciled`; unmatched payouts and unrecognised debits raise exceptions.
6. **Fees:** provider charges post to the method's fee account and are shown on the refund; who bears the fee is a policy.

### 10.5 Accounting for a refund

* On **approval**: no entry, or optionally recognise the obligation: Dr Credit note excess / Customer deposits · Cr **Refunds payable** (policy: recognise on approval vs on payout; default on approval so the liability is visible).
* On **paid**: Dr Refunds payable (or Customer deposits / Receivables as applicable) · Cr Bank / M-Pesa settlement account. Fees: Dr Bank charges · Cr Bank.
* On **returned** (bank/provider bounces the payout): reverses the credit to bank and re-opens the obligation; redirected to wallet or retried.
* The transaction ledger receives a *refund* entry (document type `refund`), keyed by the payout, with the provider reference.

### 10.6 "Refunded" status and full retraceability

The order and invoice payment status `refunded` is reached only when all refund requests against the paid amount are `paid` (or `reconciled`) and sum to the full amount paid. The record keeps, for every step, **actor (user/system/integration), their reason code and note, timestamp, origin (§13), the previous and next state, the approvals involved, the evidence and the provider references**. The refund page shows the whole lifecycle as one timeline; it is exportable.

### 10.7 Controls and fraud guards

Refund cannot exceed obligation or the amount actually paid by the method less already refunded; duplicate-payout detection (same customer, amount, destination within a window); velocity limits per requester/customer/day; blocked customers and sanctions-style deny list; mandatory reason code; dormant-day alerts for `in_doubt`, `failed` and `approved but unpaid` older than N days; daily refund report for the owner.

---

## 11. Restock confirmation

Part of CN-AC-5. Entities: `return_receipts` (document "RRC"): lines with expected vs received quantity, condition (good, damaged, expired, wrong item), disposition, location, serial/batch when available, evidence, confirmer. States: `requested → awaiting_goods → confirmed | partially_confirmed | rejected | cancelled`. Only `confirmed` quantities post stock and COGS reversal; unconfirmed requests expire into a worklist. Confirming needs the restock-confirm permission **and** the user must have access to the receiving location. Detail of the return flow is shared with blueprint §10; this document defines only the posting and permission side.

---

## 12. Permissions

### 12.1 Rule

Every state-changing action, every approval, every configuration change, every export of financial data and every sensitive read has **its own permission key**. Roles are bundles of these keys, never an implicit "admin". A new action does not ship without a key (a test fails the build if an action handler is not bound to a permission). Reads of financial data are permissioned too (`…:view` per ledger/report), with column-level hiding of bank/phone details where the user lacks the `…:view_payout_details` permission.

### 12.2 Catalogue (initial; each is a separate key in resource `finance` or the named resource)

*Chart and setup:* `gl_accounts:view|create|edit|block|delete_unused`, `gl_templates:apply`, `posting_setup:view|edit`, `fiscal_calendar:edit`, `period:open|soft_close|close|reopen|lock`, `period:post_to_closed` , `exchange_rates:edit`, `tax_setup:edit`, `finance_localisation_pack:apply`.

*Journals and ledgers:* `journal_batches:create`, `journals:edit_draft`, `journals:preview`, `journals:post`, `journals:post_to_control_account` (normally nobody), `ledger_entries:reverse`, `gl_entries:view`, `ledger_registers:view`, `trial_balance:view`, `financial_statements:view|export`.

*Receivables:* `payments:create_cash`, `payments:create_bank`, `payments:create_cheque`, `payments:create_mobile_money`, `payments:create_other`, `payments:post`, `payments:reverse`, `payments:allocate`, `payments:unapply`, `payments:edit_methods`, `payments:view`, `payments:view_payer_details`, `cheques:deposit|clear|bounce`, `payment_terms:edit`, `customer_credit_policy:edit`.

*Payment setup:* `payment_providers:view|create|edit|enable|disable`, `payment_providers:set_credentials` (write-only), `payment_providers:test_connection`, `payment_providers:rotate_keys`, `payment_methods:view|create|edit|disable`, `payment_methods:bind_provider`, `public_address:edit`.

*Bank:* `bank_accounts:manage`, `bank_statements:import`, `bank_statements:match`, `bank_statements:reconcile`, `bank_reconciliation:post`.

*Wallet:* `wallet:view`, `wallet:deposit`, `wallet:utilise`, `wallet:adjust`, `wallet:freeze`, `wallet:expire`, `wallet:cash_out_request`, `wallet_policy:edit`.

*Credit notes and returns:* `credit_notes:create` (exists), `credit_notes:resolve_excess`, `credit_notes:write_off_excess`, `credit_notes:request_restock`, `restock:confirm`, `restock:reject`, `restock:override_disposition`.

*Refunds:* `refunds:view`, `refunds:create`, `refunds:submit`, `refunds:approve` (the approval engine's own `approvals:act` still applies), `refunds:reject`, `refunds:cancel`, `refunds:waive`, `refunds:record_manual_payout`, `refunds:upload_evidence`, `refunds:change_destination`, `refunds:initiate_mpesa_reversal`, `refunds:initiate_mpesa_b2c`, `refunds:initiate_bank_file`, `refunds:retry_payout`, `refunds:resolve_in_doubt`, `refunds:to_wallet`, `refunds:configure_methods`, `refunds:automation_kill_switch`, `refunds:override_limit`.

*Audit:* `audit:view_finance_trail`, `audit:export`.

### 12.3 Migration of today's keys

`payments:refund` ("Issue refunds") is replaced by `refunds:create` + `refunds:record_manual_payout`; existing role assignments are migrated **only** to those two (never to M-Pesa or approval keys), recorded in the decision log, and shown to the owner as a one-time review screen. Everything automated is opt-in per role.

### 12.4 Enforcement points

1. Server action/service entry (authoritative, never UI only); 2. approval engine; 3. posting engine (re-checks the *posting* permission and period window); 4. database triggers for immutability. The UI hides what a user cannot do **and** the server refuses it.

---

## 13. Traceability: who, what, when, why, from where

Every posting, document event and configuration change writes the kernel decision-log row (blueprint §4.1) and carries an **origin** block, extended for Finance:

`actor_type · actor_id · acting_for (delegate/approver substitute) · permission_used · reason_code · reason_text · occurred_at · correlation_id · causation_id · ip · user_agent · session_id · origin_surface (module, screen/route or job/integration name, action name) · source_document (type, id) · request_id · before/after state`

* **Origin surface** answers "from which part of the system": e.g. `finance/refunds/refund-detail → record manual payout`, `orders/order-dialog → credit notes → resolve excess`, `job/mpesa-callback`, `integration/bank-statement-import`. It is set by the server entry point, never trusted from the browser.
* **Finance audit trail screen** (permissioned): filter by actor, document, account, customer, period, permission, origin; export; a document's page shows its own timeline.
* **Four-eyes evidence:** the trail records requester, approver(s), executor as separate actors.
* **Tamper evidence:** each register stores a hash chained to the previous register's hash; a daily verification job re-computes the chain and alerts on mismatch (cheap, and gives the owner a provable statement that history was not changed).
* **Retention:** fiscal data is never deleted; partitions are archived (blueprint §4.7).

---

## 14. Scale and reliability

**Target (your figure, interpretation to confirm): 1,000,000 retail and 900,000 wholesale financial documents a day, ≈ 1.9 M/day**, against the earlier 900 k orders/day with 50 k/hour peak. Planning basis: **2× the earlier peak, ≈ 100 k documents/hour (≈ 28/s sustained, ≈ 80/s for bursts of minutes)**, each producing ~4–10 ledger rows, so **≈ 10–19 M ledger rows/day** and ≈ 4 B rows/year in `gl_entries` alone. Retail receipts are small and numerous (till and mobile money); wholesale documents are larger, with allocation and credit checks. The design must hold both on a single primary Postgres with no read replica and no managed queue (graphile-worker), as already decided.

* **Partitioning:** `gl_entries`, detailed ledgers, `wallet_entries`, `bank_ledger_entries`, `tax_entries`, `refund_events` and `ledger_registers` are range-partitioned by posting month (daily sub-partitions for the hottest on retail volume); recent partitions on fast storage, old ones detached and archived, never deleted.
* **Batched posting for retail.** A single till sale posts synchronously (consistency for the customer-facing outcome) but the engine accepts **multi-document registers**: a till session, a shift or an N-second batch of cash sales posts as one register with summarised GL lines (one line per account × dimension set) while keeping **one sub-ledger/tax entry per document**. Summarisation level (per document, per shift, per day) is a posting-setup option per payment method and channel, as Business Central does for batch posting; fiscal documents stay individually numbered.
* **Account balances:** summary table per account × period × dimension set updated in the posting transaction with additive upserts; **hot accounts (cash, sales, tax, receivables control) use sharded balance rows** (shard by branch/till/hash, summed on read), because one row updated 80 times a second would serialise everything.
* **No global locks.** Contention only per customer (application, wallet row `NOWAIT` with bounded retry), per document (idempotency key) and per number-series counter (already branch/period-split and block-allocated for allow-gaps series; fiscal series stay gap-free and per branch).
* **Reports read summaries** (trial balance, aging, wallet liability, bank position) maintained by posting or by incremental jobs; drill-down uses partition-pruned ledgers. Heavy statements never scan the full GL on the primary during trading hours.
* **Async derived work** (statement-match suggestions, notifications, dunning, projections) via the outbox; M-Pesa callbacks are acknowledged immediately and processed by queued, idempotent jobs.
* **Back-pressure:** gateway callbacks, bank-file imports and bulk journal imports are rate-limited and chunked so a statement of 200 k lines cannot starve till posting; each has its own job queue and concurrency cap.
* **Gate F-0:** a load test at **2× the peak above on a production-sized dataset** (multi-hundred-million-row ledgers) must hold p95 posting latency within the blueprint SLOs, with the integrity jobs running concurrently. Nothing depends on the engine until it passes. The same gate repeats for F-1 (allocation under concurrency) and F-6 (callback storms).
* **Nightly integrity jobs:** every register balances; sub-ledger totals equal control accounts; entry balances equal detail sums; wallet balances equal wallet entries; hash chain valid. A failure alerts and blocks period close.

---

## 15. Delivery plan

Each slice follows the standing exit gates (unit, contract, property, browser, load, migration rehearsal, runbook). Every screen is responsive and accessible.

| Slice | Delivers | Depends on |
|---|---|---|
| **F-0 Foundation** | Chart of accounts and templates (international default + Kenya), fiscal calendar and periods, posting groups and setup with trace, journal engine (build, validate, **preview**, post, reverse), `ledger_registers` and `gl_entries`, dimensions on lines, balance summaries, immutability triggers, finance permissions, hash chain, trial balance and GL screens | kernel (built) |
| **F-1 Receivables core** | **Payment providers vs payment methods vs bank accounts split (§7.0)**: unified provider model with sealed DB-only configuration, `payment_methods` and `bank_accounts`, migration of `orders.payment_method` text and of the two existing config tables, provider health/test; payment document (manual cash/bank/cheque/other), allocation and unapply, detailed customer ledger, bank accounts, cheque lifecycle, customer statement and ageing, migration of the existing customer and transaction ledgers | F-0 |
| **F-2 Customer wallet** | Wallet ledger, deposits, overpayment handling, utilisation (manual + automatic + tender), credit policy engine, wallet screens and liability report | F-1 |
| **F-3 Credit-note accounting and restock** | Posting of credit notes through the engine, apply + resolve-excess, `credit_note_excess` worklist, return receipts and restock confirmation, COGS/inventory postings, liability postings for gift cards, loyalty, rebates | F-1, F-2 |
| **F-4 Refunds, manual** | Refund documents, lifecycle, evidence, approval trigger, destinations (cash, bank, cheque, wallet, contra), refunded-status rule, owner reports | F-3 |
| **F-5 Bank statements** | Import (CSV/Excel mapping, MT940, CAMT.053, M-Pesa export), matching rules, create-payment-from-line, reconciliation document, close refunds from statements | F-1, F-4 |
| **F-6 M-Pesa automation** | Daraja capabilities beyond STK: Transaction Reversal, B2C, Transaction Status Query, Account Balance, C2B URL registration and validation/confirmation; callbacks, `in_doubt` handling, limits, kill switch, allow-list, reconciliation; **built and tested against the Daraja sandbox with your credentials, entered on the provider screen (not env)** | F-4, F-5 |
| **F-7 Payables core and more gateways** | Vendor ledger, vendor payments and payment proposals/batches on the shared engine (§6a); | card/other gateways into payments; Airtel/MTN/etc. adapters; payment files for banks | F-6 |
| **F-8 Localisation packs** | Tax regimes and e-invoicing adapters beyond Kenya, further chart templates, statutory reports | F-0 onward, in parallel |

Phase 2 of the sales platform (delivery, billing, per-location stock) starts after F-3, because billing documents post through this engine and must not be built twice.

---

## 16. Decisions taken (from you, 2026-10-12)

1. Excess over an invoice's open amount: **customer wallet**, distinct from refund; both flows built completely; businesses choose.
2. Refunds: manual recording by hand **with attached evidence**, approval where a workflow exists; **automated M-Pesa reversal** end to end; refund to wallet (existing customers only), to the customer's bank, and other methods.
3. `refunded` only after a full refund completes, with full, retraceable lifecycle (actor, reasons, timestamps).
4. Restock only on confirmation by a user with the right permission.
5. Every action needs an explicit, specific permission (including recording a refund and initiating an M-Pesa reversal); everything traceable to who, when, why and from which part of the system.
6. Finance is built properly first: chart of accounts, GL, journals as the central immutable posting mechanism modelled on Business Central, receivables, payments of every kind, allocation, bank statements; configurable to every African market with no national standard hard-wired.

## 17. Open questions: answers recorded

All nine recommendations accepted (2026-10-12): Finance top-level module; "Wallet" label with "Customer deposits" ledger term; refund obligation recognised on approval; strict segregation of duties by default; wallet expiry off; International + Kenya templates first; hash chain on registers; Daraja testable in sandbox (credentials held by you); dual-write then freeze for `transaction_ledger_entries`. Additional decisions: AR and AP are both in scope on one engine (§6a); providers, methods and bank accounts are separate concepts (§7.0); no configuration from environment variables except the two bootstrap secrets (§7.0); the system must hold the §14 volumes.

**Still to confirm (one item):** I read "1M RRP and 900k WRP" as **1,000,000 retail and 900,000 wholesale documents per day**. If RRP/WRP means something else (for example prices, or requests per second), tell me and §14's planning basis changes.

## 18. What I will not promise

* That Safaricom (or any provider) will always allow a reversal: the design handles refusal, timeout and partial support by fallback, and an `in_doubt` worklist.
* That one chart or one tax rule suits a country: templates are starting points that a qualified accountant for that market should review before go-live.
* That posting is free: the GL adds writes to every document; F-0 has a load-test gate to prove it at 2× peak before anything depends on it.

---

## 19. F-0 as built (2026-10-12) and where it differs from this design

**Built:** chart of accounts with Kenya and International templates; fiscal years (monthly, 4-4-5, 4-5-4, 5-4-4, 13×4) and period status (open, soft-closed, closed, locked) with reasons; posting groups and effective-dated general posting setup with resolution trace; the posting engine (validate, preview, post, reverse) with idempotency, per-chain gap-free numbering and hash chain, sharded running balances, decision-log entry per posting; general journals (batch, draft lines, preview, all-or-nothing post); G/L entries, postings (with origin, permission used, hash, timeline, reverse, chain verification) and trial balance screens; 27 finance permission keys; migration `0040`. Verified by 93 new tests (domain and database, including 60-way concurrency, reversal, immutability triggers) and in a browser at desktop and phone width.

**Differences from the design above (decided while building):**

| Design said | Built | Why / what remains |
|---|---|---|
| Entry numbers from gap-free kernel numbering | `gl_entries.id` is a sequence; **register `seq` is gap-free per chain** | Row ids need not be gap-free; the register is the auditable unit. |
| Hash chain over all registers | One chain **per chain key** (a branch, or `general`) | A single global chain would serialise every posting. |
| Registers partitioned by month | Only `gl_entries` is partitioned (monthly, 2025-01 to 2031-12, plus a default partition) | Registers are one row per posting and indexed; partition later if needed. `finance_ensure_gl_partitions()` exists; **the monthly job that calls it was not scheduled in F-0; F-1 schedules it (daily)**. |
| Deferred database constraint that entries sum to the register | `CHECK` that register debit = credit (document and base), plus a check in the posting transaction and `balanceDrift()` | **The nightly integrity check was written as functions in F-0 and is scheduled in F-1 (03:57 UTC, with the customer-ledger and hash-chain-tail checks added).** |
| Per-user posting windows | Company-wide window only | Needs a per-user table; later. |
| Permissions named `…:view` | `…:read` | Matches the existing keys, so admin roles get reads by default. Write keys go to **super admin only** until you assign them. |
| Control accounts: direct posting off | Direct posting on, `engine_only`; manual journals need `journals:post_to_control_account` | "Direct posting off" would refuse everyone. |
| Retained earnings / year-end close | Not built. P&L accounts open each fiscal year at zero in the trial balance | Year-end close job is a later slice. |

**Not in F-0 (still to do):** journal templates and recurring journals, dimensions on the journal screen, financial statement layouts, the scheduled jobs above, and the **2× peak load gate on a production-sized dataset**. `scripts/finance-load.ts` measures the engine: on a shared 4-core laptop (database and client on the same machine, other work running) it did 40 postings/s at 32 concurrent callers (p50 745 ms, p95 1.3 s) and 21/s single-stream (p50 41 ms), with zero failures, zero balance drift and all 200 chains verified. That machine was loaded beyond its core count, so treat the figures as a floor and a correctness check, not as the gate.

---

## 20. F-1 as built (2026-10-12) and where it differs from this design

**Built:**

* **Providers, methods and bank accounts are separate (§7.0).** `bank_accounts` (bank, cash, mobile money, clearing; each carried by a G/L account) and `payment_methods` (rules: where it lands, reference / cheque details / evidence required, limits, refund destination, optional provider binding, the old provider codes it stands for). Standard sets for the Kenya and International templates are created from a screen, never in code. Providers stay in `payment_provider_configs` (per branch), which is now the **one** provider model; its screen is Finance → Payment Setup → Payment providers.
* **Provider connections.** Credentials are write-only (secret fields show only that they are saved), sealed in the database, changed through four separate permissions (edit, set credentials, enable, test). **Test connection** signs in to the provider (Daraja, Pesapal, Jenga, KCB Buni) without moving money and records the result; **a provider can be switched on only after a successful test.** Each adapter declares its capabilities (today: collect). The master key is mandatory everywhere (no development fallback); sealed blobs carry a key id; retired keys are listed in `DATA_ENCRYPTION_OLD_KEYS`; `DATA_ENCRYPTION_KEY_FILE` reads the key from a mounted secret.
* **Receipts (§7.2).** Draft → posted → reversed / cancelled, numbered from the `customer_payment` series. Posting writes, in one transaction: the customer ledger entry, its opening detailed entry, the bank ledger entry, the legacy `transaction_ledger_entries` credit (so reconciliation keeps working), and, from the go-live date, the G/L entries (Dr bank or cheques in transit, Cr trade debtors). A duplicate outside reference on the same method is refused. Evidence (image) can be attached from the screen and is required before posting when the method says so.
* **Allocation (§7.3).** Apply by hand, or oldest-due first; many invoices to one receipt and many receipts to one invoice; partial payment; every change is a **detailed customer entry** (append-only), and the customer-ledger entry's remaining amount moves only with it, under row locks, in the same transaction. **Unapply** undoes a whole application, with a reason. `customerBalanceDrift` (`CustomerLedgerService.drift`) finds any entry whose remaining amount differs from its history; the migration gave every existing ledger entry an opening detailed entry so history and balances agree from day one.
* **Cheques (§7.5).** received → deposited → cleared, or bounced from any of them (bounce undoes every application, reverses the receipt and the books, and reopens the invoices).
* **Reports.** Customer statement (position, ageing, entries), receivables ageing by customer (computed in the database), bank-account movements with a running balance.
* **Guards in the database.** Posted customer-ledger entries cannot change (except what is still open and the tax-signing status) or be deleted; detailed entries, bank ledger entries and receipt events are append-only; a posted receipt keeps its money facts; a reversed or cancelled receipt cannot come back. Customers with financial history can no longer be deleted (block them).
* **Existing sales flow.** `postInvoice` and `receivePayment` now run in one transaction, lock the invoices they settle, write the detailed entries, and no longer read-modify-write the customer balance.
* Migration `0041`, 32 permission keys, scheduled jobs (ledger partitions, nightly integrity check, credential re-sealing), and 50 new tests.

**Differences from the design above (decided while building):**

| Design said | Built | Why / what remains |
|---|---|---|
| Invoices and receipts all post through the engine | **Receipts post to the general ledger only from `finance_settings.sales_gl_go_live`**; before it (the default) they update the receivables and bank sub-ledgers only | A receipt credits trade debtors, so the invoice side must debit it too. Invoices do not post to the G/L yet, and cash invoices are closed at the sale in today's ledger, so turning the receipt side on alone would give a one-sided control account. **The invoice posting, the cash-sale treatment and a control-account reconciliation are the next slice (F-1c); do not set a go-live date before it.** There is deliberately no screen for the date yet. |
| `orders.payment_method` becomes `payment_method_id` | `payment_method_id` is **added** and backfilled from the old text; the text stays | Pricing rules, `on_account` logic and reports still read the text. New orders do not get the id yet (F-1c). |
| Two config tables unified | `payment_provider_configs` is the model; `payment_gateway_configs` is retired (its sealed credentials are copied once by the migration when the provider row has none; nothing is switched on by it). `/admin/gateways` redirects to the new screen | The old `darajaService` / Pesapal `submitOrder` simulations are unused and should be deleted in a cleanup. |
| Gateway confirmations create receipts | **Not yet.** A confirmed STK push still goes through `receivePayment` (now transactional with detailed entries) but creates no receipt document, bank-ledger entry or G/L entry | Same dependency as the first row (F-1c). |
| Excess over invoices sits in a suspense account (§7.3) | It stays as an **unapplied credit on the customer ledger** and is shown beside the debt; the wallet (F-2) is where it will be reclassified | Account `1220` is unused for now. |
| Cross-currency application, payment discount, rounding, FX difference | Same-currency only; a mismatch is refused with a message | Later slice. |
| Evidence: deposit slip, screenshot, cheque image | **Images only** (JPEG, PNG, WebP, GIF, AVIF), private, shown by signed link | PDFs need their own storage path. |
| Statement with running balance | Position, ageing, open items and entries, no running-balance column | Running balance needs a defined opening-balance rule. |
| Permission checks on provider actions use the new keys | The old Settings → Payments screen still uses `payments:manage_gateways` | Retire that screen when its functions are all here. |

**Not in F-1 (still to do):** ageing bucket settings, credit-limit policy, per-product posting groups (sales posting), and the PDF evidence path. **Daraja has not been exercised against Safaricom's sandbox with real credentials in this slice:** Test connection is covered with a mocked HTTP layer and, in the browser, with deliberately wrong credentials (it reports the failure and refuses to switch the provider on). Enter your sandbox consumer key and secret on the screen and press Test connection to verify it end to end.
