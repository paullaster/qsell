# Guide 15: Reports & Analytics (`/admin/reports`, `/admin`)

The **Reports** module is where QSell shows owners and managers what the business is doing and whether they can trust the numbers. It has one front door (the Reports page), one design (the same charts, tables, period bar and download buttons on every report), and one rule: every figure is defined once, says which period and which branches it covers, and says when it was made. This guide covers the first release (the "foundation"): the Reports page, the Business Overview, the generic report page with downloads, the activity trail and the style guide. Budgets, targets, the tax suite and HR reports are planned in later releases and are not yet in the product.

---

## 1. Executive Overview & Commercial Value Proposition

### Operational Problems Solved
- **"Which report do I open?"** Reports are scattered across Finance, Vendors, Delivery and Customers. The Reports page lists every report the signed-in person may open, grouped by what it tells them, and searches by the question they have ("who owes us money?") and not only by report name.
- **Numbers that do not agree between screens.** A figure such as "sales" or "owed by customers" has one definition used by every report. Receivable and payable reports are defined against their ledger control accounts.
- **Reports nobody can audit.** Every download is recorded with who took it, when, in what format and a fingerprint of the file, so a file that was changed afterwards can be spotted.
- **Staff seeing figures they should not.** Each report checks the person's permissions on the server before any figure is read. A person with no permission is told the report does not exist.
- **Spreadsheet trouble.** Downloads open in Excel with correct characters, and any cell that could run a formula is neutralised.

### Target Client Profiles
- Owners and general managers who want a daily picture without learning each module.
- Finance controllers who need downloadable, auditable ageing and ledger reports.
- Multi-branch retailers and distributors who compare branches and periods.

### Commercial Sales Pitch & Talk Track
> *"Open one page and every report you are allowed to see is there, in plain words: who owes you money, what you owe, how sales are moving. Every number says which dates and which branches it covers and when it was made. Download it to Excel or PDF and the system keeps a record of who took it. No more arguing over whose spreadsheet is right."*

### Measurable ROI & Safeguards
- Faster month-end: ageing reports download in one click instead of being rebuilt in spreadsheets.
- Fewer disputes: one definition per figure, with the period and branch always stated.
- Control: downloads are permissioned and audited; the audit trail cannot be edited or deleted.

---

## 2. Prerequisites & Configuration Sequence

1. **Roles and permissions** (Guide 07). Grant the report permissions below to the right people. Nothing is open by default except to the administrator role.
2. **Source data.** A report is only as useful as the module behind it: sales and payments (Guides 03, 11), customer ledgers and vendor ledgers (Guides 09, 10), branches (Guide 13).
3. **Branches.** The branch picker lists the company's branches; someone without the all-branches permission sees only their own branches.
4. **Business time zone and currency** (Guide 13). Periods such as "Today" follow the business's own days, not the server's.

| Permission | What it allows |
|---|---|
| `reports:read` | Open the Reports page and the style guide. |
| `reports:export` | Download a report as CSV, Excel or PDF. |
| `reports:view_audit` | Open Report activity (who ran and downloaded what). |
| `reports:all_branches` | Choose any branch in the branch picker, or see all branches together. |
| Each report's own permission (for example `receivables_ageing:read`) | Open that report. A person needs it as well as `reports:read`. |
| `dashboard:read` | Open the Business Overview at `/admin`. |

---

## 3. Module & Sub-Module Architecture

**Mental model.** A *measure* is one defined number (for example "Owed by customers"). A *report* is a set of measures broken down by dimensions (customer, branch, product…). Reports sit in families (Finance, Sales, Delivery and logistics…) so the Reports page can group them.

| Part | Where | Purpose |
|---|---|---|
| Reports page | `/admin/reports` | Find and open any report; star favourites. |
| Generic report page | `/admin/reports/<report>` | Shows a report with the period bar, a table and download buttons. |
| Existing screens | their own addresses | Reports built earlier (for example vendor reports) keep their own screens; the Reports page links to them. |
| Business Overview | `/admin` | The owner's daily summary. |
| Report activity | `/admin/reports/activity` | The audit trail of runs and downloads. |
| Style guide | `/admin/reports/style-guide` | Every chart and table in light and dark, for implementors and designers. |

**Upstream:** sales, payments, customer and vendor ledgers, the general ledger. **Downstream:** none yet; budgets and targets will feed reports in later releases.

**Freshness.** Every report reads the live records. Each one shows when it was last updated: in the period bar, or under the title for reports about stock as it is now. Faster summaries and closed-period snapshots are planned and will say so on the report.

**Where reports are.** Every report opens under `/admin/reports/<name>`, and the Reports menu groups them by module: Sales, Point of sale and cash, Products and inventory, Finance, Customers, Vendors and purchasing, Delivery and logistics. A module's own link opens the Reports page narrowed to that module. The menu is built from the report list, so a new report appears in it, in the right module, as soon as it is registered. Reports that used to sit in other modules now live here only: Trial balance, Receivables ageing, Vendor reports, Vendor scorecards, Delivery report, Delivery performance, Late deliveries, Pricing insights and Customer analytics. The old addresses still work and send the person to the new one. Working screens that are not reports (journals, ledger entries, refunds, bank accounts and statements, till shifts, the price book) stay in their own modules.

---

## 4. Interface-by-Interface Walkthrough

### 4.1 Reports page (`/admin/reports`)
- **Find a report… button (Ctrl K / Cmd K).** Opens a search box. Type a word such as "debtors"; use the arrow keys and Enter to open a result; Escape closes it.
- **Filter this list.** Narrows the cards on the page as you type; matches the title, the question the report answers, keywords and the family.
- **Starred group.** Reports you have starred appear first. Stars are kept in this browser only.
- **Family groups.** Reports grouped under headings such as Finance or Delivery and logistics.
- **Report card.** Shows the title, the question it answers, a star button and a link. The Business Overview is the home screen and is not listed here. A report that can be downloaded also has an "Open with downloads" link.
- **States.** While loading, a placeholder is shown. If the person may open no report, a sentence says so and to ask an administrator. If the list fails to load, a message says so without technical detail.

### 4.2 Generic report page (`/admin/reports/<report>`)
- A **Back** button at the top. It returns to the page the person came from (the Business Overview, the list, another report); a report opened directly goes back to the Reports list.
- The report title, with the download buttons beside it.
- The **period and scope bar** (see 4.4), where the report uses a period.
- A **table** (cards on a phone; a sortable table from tablet width).
- **Download buttons** (CSV, Excel, PDF) for the formats the report offers.
- Reports that have their own screen and offer no downloads send the person straight to that screen.

### 4.3 Business Overview (`/admin`)
Headline figures with change against the comparison period, a sales trend chart, money collected, gross profit, owed by customers, stock health and an attention list. Each panel loads on its own, so a slow panel never holds up the others; a panel that fails says so and the rest still show.

### 4.4 Period and scope bar
- **Period buttons** (for example Today, This month) and a **From / To** date pair for a custom range.
- **Compare** choice: Previous period or Same period last year.
- **Branch picker** (only for people who may choose a branch): a searchable list, never a drop-down menu.
- **Statement line:** the dates covered, the comparison dates, the scope ("All branches" or the branch name) and "Updated" with the time the figures were made.

### 4.5 Report activity (`/admin/reports/activity`)
A list of runs and downloads: who, which report, when, format and the file fingerprint. Newest first; more rows load on request.

### 4.6 Style guide (`/admin/reports/style-guide`)
Examples of every chart (line, bars, stacked bars, ranked list, donut, target bar) and the table, each with a data table behind it. For implementors checking the look in light and dark mode and on a phone.

---

## 5. Granular Field-by-Field Reference

| Field | Where | Type and format | Default | Required |
|---|---|---|---|---|
| Period | Period bar | One of the preset buttons or Custom | The report's default (usually this month) | Yes |
| From | Period bar | Date, `YYYY-MM-DD` | Start of the period | Only for Custom |
| To | Period bar | Date, `YYYY-MM-DD` | End of the period | Only for Custom |
| Compare | Period bar | Previous period / Same period last year | Previous period | No |
| Branch | Period bar | Search and pick a branch | All branches the person may see | No |
| Filter this list | Reports page | Free text | Empty | No |
| Format | Download buttons | CSV, Excel (.xlsx) or PDF | n/a | Yes (by choosing a button) |

Money is shown with the currency and thousands separators (for example KES 12,500). Percentages and changes are written in words as well as colour ("up 12.5% on the previous period").

---

## 6. Step-by-Step User Actions

**Open a report.** Reports → click the card, or press Ctrl K, type, Enter.

**Star a report.** Press the star on its card; it moves to the Starred group. Press it again to remove it. Stars stay in this browser only; a different browser or device starts with none.

**Change the period.** Click a period button; the page reloads the figures for that period and the address records the choice, so the link can be shared. For dates of your own, type From and To. If From is after To, the page says "The start date must be on or before the end date." and changes nothing.

**Compare.** Choose Previous period or Same period last year; the comparison dates are stated beside the period.

**Pick a branch.** Open the branch picker, type part of the name, choose. Choose "All branches" to clear it.

**Download.** Open the report's page and press CSV, Excel or PDF. The file is made on the spot and a record is added to Report activity. If the report is too long to download in full, the buttons are replaced by "Narrow the report to download it."; narrow the period or branch and try again.

**See who downloaded what.** Reports → Report activity (needs `reports:view_audit`).

---

## 7. Conditions, Business Rules & Edge Cases

- **Permission first.** A report's permission is checked on the server before any figure is read. A report the person may not open is reported as not found, not as forbidden.
- **Branch limits.** Without `reports:all_branches` a person only ever sees their own branches; a branch id typed into the address that they may not use is ignored.
- **Downloads.** Need `reports:export` and the report's own permission. Only the formats a report offers are available. A long list that was cut short cannot be downloaded, so a file never silently lacks rows.
- **Spreadsheet safety.** A cell that starts with `=`, `+`, `-` or `@` is made harmless so Excel cannot run it. CSV files carry a marker so Excel reads accents and symbols correctly.
- **Audit.** Every run of an audited report and every download is recorded before the file is returned. Records cannot be changed or deleted, even by an administrator.
- **File fingerprint.** The fingerprint (SHA-256) is shown in the download's response and recorded with the entry, so a file's origin can be checked later.
- **Signed-in only.** A download address opened without signing in answers "Please sign in again."
- **Tie-out.** Receivable and payable ageing reports are designed to agree with their control accounts in the ledger (the report records which account). Automatic on-screen reconciliation of the two is planned for a later release.
- **Period notice.** If a period was adjusted (for example a future end date was cut to today), a notice on the overview says so.
- **Fresh data.** Every report says when it was updated; a figure is never shown without that.
- **No stored files.** Downloaded files are not kept on the server.
- **Language.** English only in this release; wording is held in one message catalogue so other languages can be added later without changing the reports.

---

## 8. Implementor Checklist & Go-Live Verification

**Checklist**
1. Grant `reports:read` to the people who should see the Reports page, and `dashboard:read` for the Business Overview.
2. Grant `reports:export` only to people who may take data out of the system.
3. Grant `reports:view_audit` to the owner or finance controller only.
4. Grant `reports:all_branches` to head-office staff; leave branch managers without it.
5. Confirm the business time zone and base currency (Guide 13).
6. Confirm each report's own permission is given to the right role (for example `receivables_ageing:read`).

**Test transactions**
1. Sign in as a branch manager. Open Reports: only permitted reports appear. The branch picker is absent or limited to their branches.
2. Sign in as the owner. Open the Business Overview; switch to Today, then to Same period last year. The statement line changes dates and the address updates.
3. Type From later than To; confirm the sentence refusing it and that nothing changes.
4. Open Receivables ageing, download CSV, Excel and PDF. Open the CSV in Excel: accents are right and no cell starts with a formula.
5. Open Report activity: three entries with your name, format and fingerprint.
6. Sign in as someone without `reports:export`: the download is refused.
7. On a phone (390 px wide): no sideways scrolling; tables appear as cards.

**Common pitfalls**
- Giving `reports:read` without the report's own permission: the card is hidden or the report reports as missing.
- Expecting stars to follow the person to another device: they are per browser.
- Expecting a closed-period snapshot or a budget comparison: not in this release.
- Giving `reports:export` widely: every download is audited, but the data has left the system.

---

## 9. Report-by-Report Reference

Every report below opens from **Reports** (`/admin/reports`) and from the Business Overview's **See the full report** links, shows the period bar (period, comparison, branch), headline figures, one or two charts, a table, and notes saying what is counted. Each can be downloaded as CSV, Excel or PDF by someone who holds the download permission. A person pinned to one branch sees only that branch.

### Sales reports

**Who opens them.** Anyone with the *sales reports* permission (`report_sales:read`). Cost, margin and margin percent columns appear only for people who also hold the *profit reports* permission (`report_profit:read`); everyone else sees the same report without them. The **Gross margin by product** report needs both permissions to open at all.

**What counts as a sale.** The same rule as the Business Overview: an order that was not cancelled, failed or refunded, was not refused or left as a draft at approval, and was paid, or was placed by a trade customer on credit terms. An unpaid shop checkout is an abandoned cart and is not a sale. Because every report uses this rule, no figure disagrees with the overview.

**Item reports against order reports.** *Sales by product, category and supplier* add up the lines sold, so they show **item sales before tax and delivery**. *Sales by branch, by customer, by weekday, by hour and the Sales summary* add up whole orders, so their totals equal the overview's sales exactly. Each item report prints a small table, **How this adds up to the Business Overview**, that takes the items listed, adds order-level discounts and rounding, tax and delivery, and arrives at the overview's sales figure.

| Report | Question it answers | Rows | Columns and figures | Row click |
|---|---|---|---|---|
| **Sales summary** | How much did we sell each day, and is it growing? | One per day | Orders, sales, average order, share of the period, change against the same position in the comparison period. Headline: sales, orders, average order, tax, units. Chart: sales per day against the comparison | none |
| **Sales by product** (item sales, top selling) | Which products sell best, and which are slipping? | One per product, biggest first | Units, orders, sales, share, change, average price; with cost rights: cost, margin, margin %. Chart: top ten products | Opens the product |
| **Sales by category** | Which parts of the range earn the most? | One per category (a product with no category is one row, "Not in a category") | As above. Charts: top categories and share of sales | none |
| **Sales by supplier** | Which suppliers' goods sell the most? | One per supplier (a product with no purchase on record is one row, "No supplier on record") | As above. A product's supplier is the vendor of its latest approved purchase order | Opens the vendor |
| **Sales by branch** | Which branches sell the most, and which are growing? | One per branch | Orders, units, sales, share, change, cost and margin with cost rights | none |
| **Sales by customer** | Who are our biggest customers, and when did they last buy? | One per customer, biggest first; customers who gave no name are one row, "Walk-in customer" | Orders, sales, share, change, first order, last order | Opens the customer (trade customers) |
| **Sales by weekday** | Which days of the week are busiest? | Monday to Sunday | Orders, sales, average order, share. Headline names the busiest weekday | none |
| **Sales by hour** | Which hours are busiest, so staff are there when customers are? | 00:00 to 23:00 in the business time zone | Orders, sales, average order, share | none |
| **Returning customers** | Are customers coming back, and how many are new? | Returning, New, Walk-in | Customers, sales, share, change, average per customer. Headline: customers who bought, returning customers, returning share, new customers, who bought more than once, typical days between orders | none |
| **Sales returns** | What comes back, why, and how much does it cost us? | One per product returned | Units, credit notes, value, share. Chart: reasons. Headline: value returned, credit notes, returns as a share of sales | Opens the product |
| **Gross margin by product** | Which products earn the most, and which sell for too little? | One per product, highest margin first | Sales, cost, margin, margin %. Margin counts only lines whose cost was known when sold | Opens the product |

**Business rules and edge cases.**
- **Comparison.** Every row shows its change against the comparison period (previous period or same period last year). A row with nothing to compare with shows a blank change, never a made-up number.
- **Customers.** A customer is whoever the order names: a trade customer, a signed-in shopper, a phone number or an email. An order that names none is a walk-in and is counted apart. The same person under two phone numbers counts as two, so ask for the customer's phone at the till.
- **New against returning.** New means the first sale ever falls in the period; returning means they bought before it.
- **Cost.** Cost comes from the cost recorded on each line when it was sold. A line with no cost is left out of margin and the report says how much is known; it is never treated as free.
- **Long lists.** A report shows its 500 biggest rows. If there were more, a notice says so and downloads are refused until the period or branch is narrowed, so a file never silently lacks rows.
- **Currencies.** Reports add up the business's base currency only; orders in another currency are not converted into it.
- **Returns** are credit notes by the date they were issued, not the date of the original sale.
- **No branch.** A person with no branch and no company-wide right sees empty reports, never every branch.

**Implementor checklist.** Give the sales reports permission to sales managers and branch managers; give the profit reports permission only to people who may see cost. Confirm every product has a category and that purchase orders exist for the products each supplier supplies, or the category and supplier reports will be dominated by the "not in a category" and "no supplier on record" rows. Test: place a cash sale and a credit sale, then confirm **Sales by branch** equals the overview's sales and **Sales by product** plus tax and delivery arrives at the same figure.

### Financial statements

**Who opens them.** People with the *financial statements* permission (`report_financials:read`). The income statement can be narrowed to one branch. The balance sheet, statement of changes in equity and cash flow statement describe the whole company, so they also need the all-branches permission, and the branch choice is not offered on them: a single branch does not have a balance sheet.

**Where the figures come from.** The general ledger, by the date each entry was posted, in the business's base currency. They are therefore the same figures as the trial balance for the same dates. Groups and their order follow your own chart of accounts: a heading in the chart becomes a group on the statement, so changing the chart changes the statements without any other setup. Accounts with no activity are left out. A negative amount is written in brackets.

**Bank and cash accounts are not a cash flow statement.** *Finance → Bank and cash* holds the places money sits: balances, statements, reconciliation and drawer counts. The **Cash flow statement** is a report that explains *why* the money moved in a period, and it ends on those accounts' balances and proves it.

**Every statement carries a proof, drawn above it.** A green line says the statement agrees with the books. A red line says it does not and shows both sides; do not rely on a statement with a red line until the difference is explained.

| Statement | Question | Layout | Proof |
|---|---|---|---|
| **Income statement (profit and loss)** | Did we make a profit, and where did the money go? | Revenue (sales, returns, discounts) to **net sales**; cost of sales; **gross profit**; operating expenses; **operating profit**; other income; **net profit**. Each line against the comparison period, with its change and its share of net sales. Headline: net sales, gross profit, gross margin, net profit, net margin | Net profit equals what the profit and loss accounts of the trial balance add up to |
| **Balance sheet** | What do we own, what do we owe, and what is the business worth? | Assets, liabilities and equity as at the end of the period and as at the end of the comparison period, grouped as your chart groups them. Profit not yet closed into retained earnings appears inside equity, split between earlier years and the year to date | Assets equal liabilities plus equity |
| **Statement of changes in equity** (retained earnings) | How did the owners' stake change, including retained earnings? | Opening balance, profit for the period, capital introduced or withdrawn, owner drawings and dividends, any adjustment or year-end closing entry, closing balance, in columns: capital and other equity, retained earnings, total | Opening plus movements equals closing, and the closing equals the equity on the balance sheet |
| **Cash flow statement** (indirect method) | Where did our cash come from, and where did it go? | Net profit, add back depreciation, changes in working capital (receivables, stock, prepayments, creditors, taxes, customer balances); investing (equipment and other fixed assets); financing (loans, share capital, drawings); net change; opening and closing cash | The change in cash equals the movement on the cash and bank accounts |

**Business rules and edge cases.**
- **Revenue.** Revenue is the accounts the general posting setup uses for sales, sales returns and sales discounts. If none is set, every income account is treated as revenue. Any other income account shows under **Other income**.
- **Cost of sales** is what the ledger holds. It follows the stock posting; until stock posting is live, cost of sales and gross profit are understated, and the statement says so.
- **Year-end.** Profit that no year-end closing has moved into retained earnings is shown in equity, so the balance sheet always balances. When a closing entry is posted in the period it appears on the equity statement as **Adjustments and year-end closing entries**, and the cash flow statement shows it as its own line, so nothing is hidden.
- **Cash and bank** means the accounts your payment methods post to, plus the cash and bank group of the chart.
- **Cash flow sections.** Assets are sorted into investing when their name or group mentions property, plant, equipment, fixtures, vehicles, land, buildings, intangibles or investments; liabilities into financing when they mention loans, borrowings, debentures, overdrafts, leases or mortgages; equity accounts are financing. Everything else is operating. Name accounts in the chart plainly so they land where you expect.
- **Single branch.** The income statement for one branch includes only entries posted to that branch.
- **Comparison.** The comparison period is the period before, or the same period last year; the balance sheet compares the closing date of each.
- **Downloads** carry the statement line by line with the same columns.

**Implementor checklist.** Give the financial statements permission only to finance staff and owners. Confirm the posting setup names sales, returns and discount accounts, that the chart's headings group accounts sensibly, that a fiscal year exists for the dates reported, and that stock posting is live before relying on gross profit. Test: post a sale, a receipt and an expense; confirm the income statement's net profit matches the trial balance, the balance sheet balances, and the cash flow statement's closing cash equals the sum of your bank and cash accounts.

### Inventory reports

**Who opens them.** People with the *inventory reports* permission (`report_inventory:read`). **Stock valuation** and **Slow and dead stock** show what stock cost, so they also need the *profit reports* permission (`report_profit:read`). Stock is held for the whole company, so these reports have no branch choice, and all but Stock movement have no period: they describe stock as it is right now, and say so.

**What counts as stock.** An active product that is not deleted and is of the "inventory" kind. A service or a non-stock item is never in stock, so it is never reported as out of stock. The Business Overview's *Stock health* panel uses the same rule, so the counts agree.

| Report | Question it answers | Rows | Columns and figures |
|---|---|---|---|
| **Stock valuation** | What is our stock worth, and where is it? | One per product, the most valuable first | Category, on hand, cost each, stock value, share of value. Headline: stock value at cost, units, products stocked, products in stock with no cost recorded. Charts: value by category and by location. A small table proves the list adds up to the stock value on the Business Overview |
| **Low and out of stock** | What must we reorder now, and how long will what is left last? | Products whose available stock is at or below their reorder level; out-of-stock first, then the soonest to run out | On hand, reserved, available, reorder level, sold in the last 30 days, days of cover. Headline: out of stock, low stock, and how many of them are still selling. Chart: what is selling and running out soonest |
| **Slow and dead stock** | What is not selling, and how much cash is tied up in it? | Products with stock that has not sold in 30 days | How long since the last sale (30 to 60, 60 to 90, over 90 days or never), on hand, cost, cash tied up, last sold date, units sold in the last 90 days. Headline: cash tied up, dead stock, share of all stock value |
| **Stock movement** | What came in, what went out, and what was adjusted? | Products with any movement in the period, the biggest change first | Received, sold, returned by customers, returned to suppliers, adjusted and written off, net change, on hand now |

**Business rules and edge cases.**
- **Available** is on hand minus what is reserved for open orders. **Low** means available is at or below the product's reorder level (a reorder level of zero means only out-of-stock products are listed for that product). **Out** means nothing is available.
- **Days of cover** is available stock divided by the average daily sales of the last 30 days. A product that has not sold in that time has no figure, because there is nothing to run out of; a product that is out of stock shows zero.
- **No cost recorded.** A product with no cost has an unknown value. It is counted and named in the valuation, and it is never valued at nothing. Record a cost for every stocked product or the valuation understates the business.
- **Free gifts** are not sales. A product that is only ever given away shows as not selling.
- **Transfers** between locations are left out of Stock movement: they move stock, they do not change how much the company holds.
- **Long lists.** Each report shows its 500 biggest rows and says when more exist.

**Implementor checklist.** Give the inventory reports permission to stock controllers and buyers; give the profit reports permission only to those who may see cost. Set a reorder level on every product that must not run out, record a cost on every stocked product, and mark services and non-stock items with the correct product kind. Test: receive stock, sell some, adjust some, then confirm Stock movement shows each, Low stock lists a product once it falls to its reorder level, and Stock valuation proves out against the overview.
