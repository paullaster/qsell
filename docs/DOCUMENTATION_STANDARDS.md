# Implementor & Sales Enablement Documentation Standard (ISDS)

This document defines the **permanent, mandatory standard** for all implementor and sales documentation across the QSell Enterprise platform. As codified in Section 12 of [`docs/PROJECT_RULES.md`](PROJECT_RULES.md), no module, sub-module, screen, or action is complete without synchronized documentation meeting this specification.

---

## 1. Dual Audience & Core Purpose

This documentation is written for two specific roles who require deep, exhaustive knowledge of the application without exposure to programming syntax or database internals:

1. **System Implementors / Solutions Engineers**:
   - Responsible for setting up new client organizations, configuring branches, configuring payment gateways, setting up tax compliance, establishing chart of accounts, designing price lists and approval matrices, executing inventory cutovers, and conducting user acceptance testing (UAT).
   - They need to know: *What must exist first? What does this toggle do? What happens if this field is left empty? What triggers an error? How does data flow into downstream modules?*

2. **Sales Team Members & Solutions Consultants**:
   - Responsible for onboarding onto the platform, mastering the system's capabilities, pitching to prospect executives (CEOs, CFOs, Heads of Supply Chain, Operations Directors), answering detailed RFP questions, and proving tangible return on investment (ROI).
   - They need to know: *What business headache does this solve? Why is this superior to manual spreadsheets or generic legacy ERPs? How does this protect against revenue leakage, theft, or regulatory fines? What is the exact customer journey and live demo script?*

---

## 2. Style and Tone Guidelines

- **Zero Technical Jargon**: Do not reference TypeScript types, SQL queries, Drizzle schemas, React hooks, Server Action signatures, or internal file paths. Translate all technical realities into business concepts (e.g. refer to "immutable general ledger postings" rather than "`gl_entries` table inserts").
- **Commercial & Operational Reality**: Ground all descriptions in the everyday realities of modern commerce and distribution in Kenya and East Africa: Kenyan Shillings (KES), M-Pesa Paybill / Till settlement, KRA eTIMS digital signature compliance, county/sub-county/town logistics, multi-drop rider dispatch, door cash collection, and 3-way accounts payable matching.
- **Granular Completeness**: Never summarize or gloss over fields with "etc." or "and other settings". Every single field, checkbox, toggle, dropdown option, button, modal, warning banner, and validation constraint must be explicitly documented.
- **Hierarchical Discipline**: Structure content rigorously:
  `Module` $\rightarrow$ `Sub-module` $\rightarrow$ `Section / Screen` $\rightarrow$ `Field & Setting Details` $\rightarrow$ `Actions down to the last user interaction` $\rightarrow$ `Conditions & Business Rules` $\rightarrow$ `Commercial Value Proposition & Sales Pitch`.

---

## 3. The Mandatory 8-Part Guide Anatomy

Every module manual in [`docs/implementor-guide/`](implementor-guide/README.md) must adhere to the following 8-part structure:

### Part 1: Executive Overview & Commercial Value Proposition
- **Operational Problems Solved**: Pain points eliminated (e.g. phantom stockouts, untracked cash on delivery, unauthorized sales discounts, delayed eTIMS filing penalties).
- **Target Client Profiles**: Industry verticals and operating models (e.g., retail chains, FMCG distributors, agro-dealers, solar PV contractors, hardware merchants).
- **Sales Pitch & Value Proposition**: High-impact talking points for client demos, executive positioning against legacy systems, and answers to common prospect objections.
- **Measurable ROI & Safeguards**: Concrete business gains (e.g., 99.8% inventory accuracy, 100% KRA tax audit compliance, 15% reduction in last-mile courier spend).

### Part 2: Prerequisites & Configuration Sequence
- **Pre-Flight Checklist**: Exactly what setup must be completed *prior* to configuring or transacting in this module (e.g., Base Units of Measure must be defined before creating Products; Chart of Accounts must be defined before Posting Setup).
- **Security & User Permissions**: Required staff roles and explicit functional permissions needed to view, create, edit, approve, or reverse actions in this area.

### Part 3: Module & Sub-Module Architecture
- **Operational Workflow Map**: End-to-end operational lifecycle diagrams showing how records are created, transitioned, fulfilled, and archived.
- **Cross-Module Integrations**: Visual and textual explanations of how changes in this module impact upstream/downstream areas (e.g. Sales Order $\rightarrow$ Approval Trigger $\rightarrow$ Stock Reservation $\rightarrow$ Delivery Run $\rightarrow$ Door Payment Handover $\rightarrow$ General Ledger Posting).

### Part 4: Interface-by-Interface Walkthrough
- **Screen Inventory**: Complete listing of every screen, sub-route, tab, slide-over drawer, and modal in the module.
- **Visual Anatomy**: High-level orientation of top summary cards, filter bars, search controls, status badges, action toolbars, and tabular list views.

### Part 5: Granular Field-by-Field Reference
- For every form, section, and input control:
  - **Field Label**: Exact text visible on screen.
  - **Purpose**: Operational meaning and why the business captures it.
  - **Input Type & Format**: Text, number, currency, date, dropdown lookup, toggle switch, or file upload, including exact formatting rules (e.g., KRA PIN: 11 characters starting with A or P, 9 digits, ending with a letter).
  - **Requirement & Defaults**: Required, optional, or conditionally required; default value on new record creation.
  - **Validation & Hints**: Character limits, numeric bounds, error messages displayed upon invalid entry.

### Part 6: Step-by-Step User Actions (Down to the Last Click)
- **Primary Operational Actions**: Create, save, submit, post, release, approve, reject, cancel, void, or reverse.
- **Secondary Actions**: Keyset paging navigation, live debounced search, column filtering, bulk selection, CSV/PDF export, print slip generation.
- **Dialogs & Confirmations**: Every inline confirmation (`InlineConfirm`), warning prompt, and mandatory reason dialog (e.g., why a delivery was marked failed, or why an approval was rejected).
- **Outcome States**: Immediate feedback messages, toast notices, status badge transitions, and system activity logging.

### Part 7: Conditions, Business Rules & Edge Cases
- **Blocking Conditions**: What exact conditions prevent an action from executing (e.g. cannot issue goods without confirmed stock in the designated location; cannot post an invoice into a closed fiscal period; cannot exceed a customer's credit limit without manager approval).
- **Automated Event Triggers**: System background tasks executed upon status change (e.g., order stage timestamp recording, stock ledger reservation, webhook dispatch, SMS alert delivery).
- **Concurrency & Reversals**: Behavior when two staff members edit simultaneously; safe reversal protocols (e.g. debit notes, credit memos, reversal registers).

### Part 8: Implementor Checklist & Go-Live Verification
- **Rollout Step-by-Step Protocol**: Ordered checklist for deploying this module during customer onboarding.
- **Common Client Setup Pitfalls**: Typical mistakes made by client teams and how to rectify them.
- **Go-Live Smoke Tests**: Concrete end-to-end verification scenarios that implementors must execute and pass before handing over to end users.

---

## 4. Maintenance & Continuous Verification

1. **Navigation Alignment**: Any addition or modification in `src/config/admin-nav/nav.config.ts` must immediately be accompanied by an update to the corresponding guide in `docs/implementor-guide/`.
2. **SEO & Terminology Parity**: The plain-language terms used in `src/config/seo/platform-modules.ts` must match the terminology in the manuals.
3. **Automated Enforcement**: Continuous integration checks verify that all module links in `docs/implementor-guide/README.md` remain valid and that no broken links or orphaned screens exist.
