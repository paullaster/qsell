# Reports R-1: the working catalogue

R-0 built the foundation (registry, runner, exports, audit, chart kit, hub). R-1 puts the reports on it. This page lists what is built, who it is for, and which permission opens it. Every report states its period, its scope (all branches or one), when it was made, and offers a comparison and a download.

## Questions answered, by person

| Person | Their question | Reports |
|---|---|---|
| Owner, general manager | Are we making money, and is it getting better? | Income statement, Sales summary, Gross margin, Cash flow, Balance sheet |
| Finance controller | Do the books say what the shops say? Where is the cash? | Income statement, Balance sheet, Statement of changes in equity, Cash flow, Trial balance (existing), Receivables ageing, Payables ageing |
| Sales manager | What sells, to whom, where and when? | Sales by product, by category, by branch, by vendor, by customer, by day and hour, Returning customers, Sales returns |
| Branch manager | How is my shop doing against last month? | The same reports, pinned to their branch |
| Stock controller | What do I have, what is running out, what is not moving? | Stock valuation, Low and out of stock, Slow and dead stock, Stock movement |
| Cashier, junior staff | What did I sell today, and what is in my drawer? | Sales by day and hour (their branch), Cash counts (existing) |
| Buyer | Which suppliers move our stock, and what do we owe them? | Sales by vendor, Payables ageing, Vendor reports (existing) |

## Money containers are not statements

**Bank and cash accounts** (Finance → Bank and cash) are the places money sits: balances, statements, reconciliation, drawer counts. A **cash flow statement** is a different thing: it explains *why* cash moved in a period (profit, stock and debtors, assets bought, loans, owner's money). Both exist now: the accounts stay where they are, and the cash flow statement is a report that ends on those accounts' balances and proves it.

## Financial statements (from the ledger)

Read from the general ledger balances by period, never from sales documents, so they agree with the trial balance. Permission: `report_financials:read` (new).

| Report | What it shows | Proof built in |
|---|---|---|
| Income statement | Income, sales returns and discounts, cost of sales, **gross profit**, expenses, **operating profit**, other income and cost, **net profit**; each line against the comparison and as a share of net sales | Net profit equals income minus cost of sales minus expenses of the trial balance for the same dates |
| Balance sheet | Assets, liabilities, equity at a date, with the year's profit shown inside equity until the year is closed | Assets equal liabilities plus equity; a difference is shown in red, never hidden |
| Statement of changes in equity (retained earnings) | Opening retained earnings, plus net profit, less owner drawings and dividends, plus share capital introduced, equals closing | Closing equals the balance sheet's equity |
| Cash flow statement (indirect) | Net profit, adjusted for depreciation and for changes in debtors, stock, prepayments, creditors and taxes, gives cash from operations; then investing (equipment) and financing (loans, capital, drawings) | Opening cash plus net movement equals closing cash on the bank and cash accounts |

## Sales and product reports (from orders)

Use the same definition of a sale as the Business Overview (not cancelled, failed or refunded; paid or on credit terms), so no figure disagrees with the overview. Permission: `report_sales:read`; cost and margin columns also need `report_profit:read`.

| Report | Rows are | Key figures |
|---|---|---|
| Sales summary | Days | Sales, orders, average order, tax, trend against the comparison |
| Sales by product (item sales) | Products | Units, sales, orders, average price, cost, margin, share, rank, change |
| Sales by category | Categories | Same, plus products sold |
| Sales by branch | Branches | Same, plus share and change |
| Sales by vendor | Suppliers | Sales of the items each supplier supplies (supplier of record from purchase orders) |
| Sales by customer | Customers | Orders, sales, average order, last order, share |
| Returning customers | Customer types | New against returning customers, repeat rate, orders per customer, days between orders |
| Sales by day and hour | Weekdays, hours | When the shop is busy, for staffing |
| Sales returns | Products, reasons | Credit notes by product and reason, return rate |
| Gross margin | Products | Sales, cost, margin, margin percent, share of sales with known cost |
| Money collected | Payment methods | Amount, count, share (the overview's "money collected", in full) |

## Inventory reports

Permission: `report_inventory:read`; value columns also need `report_profit:read`.

| Report | What it shows |
|---|---|
| Stock valuation | Quantity and value at cost by category and product |
| Low and out of stock | Products at or below their reorder level, with days of cover from recent sales |
| Slow and dead stock | Products with stock that has not sold in 30, 60, 90 days, and the cash tied up |
| Stock movement | Received, sold, adjusted and transferred by product in the period |

## From the Business Overview to the report

Every panel on the overview has a **See the full report** link that opens the matching report here with the same period, comparison and branch, so the numbers carry over:

| Overview panel | Opens |
|---|---|
| Sales | Sales summary |
| Best sellers | Sales by product |
| By branch | Sales by branch |
| Money collected | Money collected |
| Gross profit | Gross margin |
| Owed by customers | Receivables ageing |
| Stock health | Low and out of stock |

## Build order

1. Shared report view and renderer (headline figures, chart, table, notes, drill links).
2. Sales and product reports, with the overview links.
3. Financial statements.
4. Inventory reports.
5. Tests at every level, implementor guide, hub and navigation entries.

## Not in this release

Budget against actual and targets, the tax return suite (VAT, withholding), HR and payroll, scheduled email delivery, the report builder, and closed-period snapshots. They are in `reports-module.md` as later slices.
