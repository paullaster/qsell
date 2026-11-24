/**
 * Every word the reports module shows, in English, keyed by id. A sentence is a whole template with named
 * slots written `{like_this}`: nothing is built from English grammar in code, so another language can reorder
 * the words. Add a language by adding a file with the same ids (a test compares the ids and the slots).
 *
 * Ids: `measure.<code>.label`, `measure.<code>.meaning`, `dimension.<code>.label`, `family.<code>.label`.
 */
export const EN = {
  // ---- measures: sales ----
  'measure.sales.total.label': 'Sales',
  'measure.sales.total.meaning':
    'The total of every order that counts as a sale, including tax and delivery charges, in the business currency.',
  'measure.sales.orders.label': 'Orders',
  'measure.sales.orders.meaning': 'How many orders count as a sale.',
  'measure.sales.average_order.label': 'Average order',
  'measure.sales.average_order.meaning':
    'Sales divided by the number of orders that count as a sale.',
  'measure.sales.tax.label': 'Tax charged',
  'measure.sales.tax.meaning': 'The tax on the orders that count as a sale.',

  // ---- measures: collections ----
  'measure.collections.collected.label': 'Collected',
  'measure.collections.collected.meaning':
    'Money actually settled in the period through the payment providers, by the day the payment was confirmed.',
  'measure.collections.rate.label': 'Collection rate',
  'measure.collections.rate.meaning':
    'Money collected in the period as a share of sales in the same period.',
  'measure.collections.tenders.label': 'Store credit used',
  'measure.collections.tenders.meaning':
    'Gift cards and loyalty points redeemed against orders in the period. They are not payments through a provider.',

  // ---- measures: profit ----
  'measure.profit.gross.label': 'Gross profit',
  'measure.profit.gross.meaning':
    'Revenue of the lines whose product cost is known, less that cost. Lines with no recorded cost are left out.',
  'measure.profit.margin.label': 'Margin',
  'measure.profit.margin.meaning':
    'Gross profit as a share of the revenue of the lines whose cost is known.',
  'measure.profit.cost_coverage.label': 'Cost coverage',
  'measure.profit.cost_coverage.meaning':
    'The share of sales value whose product cost is known. Margin only speaks for this share.',

  'measure.profit.known_revenue.label': 'Revenue with known cost',
  'measure.profit.known_revenue.meaning':
    'The revenue of the sale lines whose product cost was recorded. This is the base margin is worked out on.',
  'measure.profit.all_revenue.label': 'Revenue of all lines',
  'measure.profit.all_revenue.meaning':
    'The revenue of every sale line, whether or not its product cost was recorded.',

  // ---- measures: receivables ----
  'measure.receivables.outstanding.label': 'Owed to us',
  'measure.receivables.outstanding.meaning':
    'What customers still owe on their account: the unpaid part of every open customer ledger entry.',
  'measure.receivables.overdue.label': 'Overdue',
  'measure.receivables.overdue.meaning':
    'The part of what customers owe that is past its due date.',

  // ---- measures: payables ----
  'measure.payables.outstanding.label': 'We owe',
  'measure.payables.outstanding.meaning':
    'What we still owe suppliers: the unpaid part of every open supplier invoice in the vendor ledger.',
  'measure.payables.overdue.label': 'Overdue to suppliers',
  'measure.payables.overdue.meaning':
    'The part of what we owe suppliers that is past its due date, or past its invoice date when no due date was given.',

  // ---- measures: inventory ----
  'measure.inventory.stock_value.label': 'Stock value',
  'measure.inventory.stock_value.meaning':
    'Units on hand times the product cost, for active products, with negative stock counted as zero.',
  'measure.inventory.out_of_stock.label': 'Out of stock',
  'measure.inventory.out_of_stock.meaning':
    'Stocked products with nothing available to sell (on hand less reserved is zero or less).',
  'measure.inventory.low_stock.label': 'Low stock',
  'measure.inventory.low_stock.meaning':
    'Active products with something available, but no more than the low-stock level set on the product.',

  // ---- dimensions ----
  'dimension.date.label': 'Date',
  'dimension.branch.label': 'Branch',
  'dimension.channel.label': 'Sales channel',
  'dimension.sales_type.label': 'Sales type',
  'dimension.customer.label': 'Customer',
  'dimension.customer_group.label': 'Customer group',
  'dimension.product.label': 'Product',
  'dimension.category.label': 'Category',
  'dimension.brand.label': 'Brand',
  'dimension.vendor.label': 'Vendor',
  'dimension.salesperson.label': 'Salesperson',
  'dimension.payment_method.label': 'Payment method',
  'dimension.delivery_zone.label': 'Delivery zone',
  'dimension.rider.label': 'Rider',

  // ---- report families ----
  'family.executive.label': 'Executive',
  'family.sales.label': 'Sales',
  'family.pos.label': 'Point of sale and cash',
  'family.inventory.label': 'Products and inventory',
  'family.finance.label': 'Finance',
  'family.tax.label': 'Tax',
  'family.customers.label': 'Customers',
  'family.vendors.label': 'Vendors and purchasing',
  'family.delivery.label': 'Delivery and logistics',
  'family.projects.label': 'Projects',
  'family.people.label': 'People',
  'family.operations.label': 'Operations and system health',

  // ---- reports: the title and the question each one answers ----
  'report.business_overview.title': 'Business overview',
  'report.business_overview.question':
    'How are we doing: what we sold, what we collected, what we earned, what customers owe and what needs attention?',

  // ---- reports that already have a screen ----
  'report.trial_balance.title': 'Trial balance',
  'report.trial_balance.question':
    'Do the books balance, and what is the balance of every account for the period?',
  'report.receivables_ageing.title': 'Receivables ageing',
  'report.receivables_ageing.question': 'Who owes us money, how much, and how late is it?',
  'report.payables_ageing.title': 'What we owe (payables ageing)',
  'report.payables_ageing.question': 'Which suppliers do we owe, how much, and how late is it?',
  'report.vendor_reports.title': 'Vendor reports',
  'report.vendor_reports.question':
    'What have we committed to buy, how do suppliers perform, what have we bought and which suppliers need watching?',
  'report.vendor_scorecards.title': 'Vendor scorecards',
  'report.vendor_scorecards.question':
    'Which suppliers deliver on time, with good quality and stable prices?',
  'report.delivery_report.title': 'Delivery report',
  'report.delivery_report.question':
    'How many deliveries did we make, what did they cost and earn, and how did they go?',
  'report.delivery_performance.title': 'Delivery performance',
  'report.delivery_performance.question':
    'Are deliveries on time, and which riders and zones are slow?',
  'report.late_deliveries.title': 'Late deliveries',
  'report.late_deliveries.question': 'Which deliveries are late right now, and what must be done?',
  'report.pricing_insights.title': 'Pricing insights',
  'report.pricing_insights.question':
    'Are we selling below cost or floor, what do promotions cost, and what looks wrong in our prices?',
  'report.customer_analytics.title': 'Customer analytics',
  'report.customer_analytics.question': 'Who are our customers and how do they buy?',

  // ---- measures added with the first full set of reports ----
  'measure.sales.units.label': 'Units sold',
  'measure.sales.units.meaning':
    'How many units were sold on orders that count as a sale. Free gifts are not counted.',
  'measure.sales.returns.label': 'Sales returns',
  'measure.sales.returns.meaning':
    'The value of credit notes issued in the period, by the date the credit note was issued.',
  'measure.customers.buyers.label': 'Customers who bought',
  'measure.customers.buyers.meaning':
    'How many different customers placed a sale in the period. An order that names no customer is a walk-in and is not counted as a person.',
  'measure.customers.returning_buyers.label': 'Returning customers',
  'measure.customers.returning_buyers.meaning':
    'Customers who bought in the period and had also bought before it.',
  'measure.customers.returning_share.label': 'Returning share',
  'measure.customers.returning_share.meaning':
    'The share of customers who bought in the period who had bought before it.',

  'measure.ledger.net_profit.label': 'Net profit',
  'measure.ledger.net_profit.meaning':
    'What the business earned after every cost, from the general ledger, by the date entries were posted.',
  'measure.ledger.gross_profit.label': 'Gross profit',
  'measure.ledger.gross_profit.meaning':
    'Net sales minus the cost of the goods sold, from the general ledger.',
  'measure.ledger.total_assets.label': 'Total assets',
  'measure.ledger.total_assets.meaning':
    'Everything the business owns, from the general ledger, as at a date.',
  'measure.ledger.total_equity.label': 'Total equity',
  'measure.ledger.total_equity.meaning':
    'What the owners hold in the business: assets minus liabilities, as at a date.',
  'measure.ledger.cash_from_operations.label': 'Cash from operations',
  'measure.ledger.cash_from_operations.meaning':
    'Cash the everyday business produced or used, before buying assets or financing.',

  'measure.inventory.net_movement.label': 'Net stock movement',
  'measure.inventory.net_movement.meaning':
    'How many units stock grew or shrank by in the period: received, sold, returned and adjusted. Transfers between locations are left out.',

  // ---- sales reports ----
  'report.sales_summary.title': 'Sales summary',
  'report.sales_summary.question': 'How much did we sell each day, and is it growing?',
  'report.sales_by_product.title': 'Sales by product',
  'report.sales_by_product.question': 'Which products sell best, and which are slipping?',
  'report.sales_by_category.title': 'Sales by category',
  'report.sales_by_category.question': 'Which parts of the range earn the most?',
  'report.sales_by_vendor.title': 'Sales by supplier',
  'report.sales_by_vendor.question': 'Which suppliers goods sell the most?',
  'report.sales_by_branch.title': 'Sales by branch',
  'report.sales_by_branch.question': 'Which branches sell the most, and which are growing?',
  'report.sales_by_customer.title': 'Sales by customer',
  'report.sales_by_customer.question': 'Who are our biggest customers, and when did they last buy?',
  'report.sales_by_weekday.title': 'Sales by weekday',
  'report.sales_by_weekday.question': 'Which days of the week are busiest?',
  'report.sales_by_hour.title': 'Sales by hour',
  'report.sales_by_hour.question':
    'Which hours of the day are busiest, so staff are there when customers are?',
  'report.returning_customers.title': 'Returning customers',
  'report.returning_customers.question': 'Are customers coming back, and how many are new?',
  'report.sales_returns.title': 'Sales returns',
  'report.sales_returns.question': 'What comes back, why, and how much does it cost us?',
  'report.gross_margin.title': 'Gross margin by product',
  'report.gross_margin.question': 'Which products earn the most, and which sell for too little?',
  'report.money_collected.title': 'Money collected',
  'report.money_collected.question': 'How did customers pay, and how much did we collect?',

  // ---- financial statements ----
  'report.income_statement.title': 'Income statement (profit and loss)',
  'report.income_statement.question': 'Did we make a profit, and where did the money go?',
  'report.balance_sheet.title': 'Balance sheet',
  'report.balance_sheet.question':
    'What do we own, what do we owe, and what is the business worth?',
  'report.changes_in_equity.title': 'Statement of changes in equity',
  'report.changes_in_equity.question':
    'How did the owners stake change this year, including retained earnings?',
  'report.cash_flow.title': 'Cash flow statement',
  'report.cash_flow.question': 'Where did our cash come from, and where did it go?',

  // ---- inventory reports ----
  'report.stock_valuation.title': 'Stock valuation',
  'report.stock_valuation.question': 'What is our stock worth, and where is it?',
  'report.low_stock.title': 'Low and out of stock',
  'report.low_stock.question': 'What must we reorder now, and how long will what is left last?',
  'report.slow_stock.title': 'Slow and dead stock',
  'report.slow_stock.question': 'What is not selling, and how much cash is tied up in it?',
  'report.stock_movement.title': 'Stock movement',
  'report.stock_movement.question': 'What came in, what went out, and what was adjusted?',

  // ---- shared words and sentences ----
  'common.updated': 'Updated {time}',
  'common.compared_with': 'compared with {basis}',
  'common.up_by': 'up {percent}% on {basis}',
  'common.down_by': 'down {percent}% on {basis}',
  'common.level_with': 'level with {basis}',
  'common.nothing_to_compare': 'nothing to compare with',
  'common.no_data_in_period': 'No data in this period.',
  'common.updating': 'Updating…',
  'common.try_again': 'Try again',
} as const;

export type MessageId = keyof typeof EN;
