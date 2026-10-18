/**
 * The single source of truth for application permissions.
 *
 * This module is dependency-free so both server (engine, seeds, guards) and
 * admin client components can import it. Keys follow `<resource>:<action>`.
 * Adding a permission here is enough to make it available for role bindings,
 * direct grants, and ABAC policy conditions.
 */

export const PERMISSION_CATEGORIES = [
  'General',
  'Orders & Sales',
  'Projects',
  'Customers',
  'Products & Inventory',
  'Finance & Payments',
  'Reports & Insights',
  'Company & Settings',
  'Users & Access',
] as const;

export interface PermissionMeta {
  readonly resource: string;
  readonly action: string;
  readonly category: (typeof PERMISSION_CATEGORIES)[number];
  readonly description: string;
}

export const PERMISSIONS = {
  'dashboard:read': {
    resource: 'dashboard',
    action: 'read',
    category: 'General',
    description: 'View the business overview dashboard',
  },
  'analytics:read': {
    resource: 'analytics',
    action: 'read',
    category: 'General',
    description: 'View customer and sales analytics',
  },
  'analytics:export': {
    resource: 'analytics',
    action: 'export',
    category: 'General',
    description: 'Export analytics reports',
  },

  'report_sales:read': {
    resource: 'report_sales',
    action: 'read',
    category: 'Reports & Insights',
    description: 'See sales value, order counts, trends and best-selling products',
  },
  'report_collections:read': {
    resource: 'report_collections',
    action: 'read',
    category: 'Reports & Insights',
    description: 'See money collected, broken down by configured payment method',
  },
  'report_profit:read': {
    resource: 'report_profit',
    action: 'read',
    category: 'Reports & Insights',
    description: 'See gross profit and margin (reveals product costs)',
  },
  'report_receivables:read': {
    resource: 'report_receivables',
    action: 'read',
    category: 'Reports & Insights',
    description: 'See what customers owe and what is overdue',
  },
  'report_inventory:read': {
    resource: 'report_inventory',
    action: 'read',
    category: 'Reports & Insights',
    description: 'See stock health: out of stock, low stock and stock value',
  },
  'reports:all_branches': {
    resource: 'reports',
    action: 'all_branches',
    category: 'Reports & Insights',
    description: 'Run reports across every branch instead of only your own branch',
  },

  'orders:read': {
    resource: 'orders',
    action: 'read',
    category: 'Orders & Sales',
    description: 'View customer orders',
  },
  'orders:create': {
    resource: 'orders',
    action: 'create',
    category: 'Orders & Sales',
    description: 'Create orders on behalf of customers',
  },
  'orders:update': {
    resource: 'orders',
    action: 'update',
    category: 'Orders & Sales',
    description: 'Edit order details, status, and notes',
  },
  'orders:cancel': {
    resource: 'orders',
    action: 'cancel',
    category: 'Orders & Sales',
    description: 'Cancel orders and restock inventory',
  },
  'orders:delete': {
    resource: 'orders',
    action: 'delete',
    category: 'Orders & Sales',
    description: 'Delete orders',
  },
  'orders:approve': {
    resource: 'orders',
    action: 'approve',
    category: 'Orders & Sales',
    description: 'Approve credit orders',
  },
  'orders:export': {
    resource: 'orders',
    action: 'export',
    category: 'Orders & Sales',
    description: 'Export orders',
  },

  'quotes:read': {
    resource: 'quotes',
    action: 'read',
    category: 'Orders & Sales',
    description: 'View sales quotes',
  },
  'quotes:create': {
    resource: 'quotes',
    action: 'create',
    category: 'Orders & Sales',
    description: 'Create sales quotes',
  },
  'quotes:update': {
    resource: 'quotes',
    action: 'update',
    category: 'Orders & Sales',
    description: 'Edit sales quotes',
  },
  'quotes:approve': {
    resource: 'quotes',
    action: 'approve',
    category: 'Orders & Sales',
    description: 'Approve sales quotes for conversion to orders',
  },
  'quotes:delete': {
    resource: 'quotes',
    action: 'delete',
    category: 'Orders & Sales',
    description: 'Delete sales quotes',
  },

  'projects:read': {
    resource: 'projects',
    action: 'read',
    category: 'Projects',
    description: 'View projects and their tasks',
  },
  'projects:create': {
    resource: 'projects',
    action: 'create',
    category: 'Projects',
    description: 'Create projects',
  },
  'projects:update': {
    resource: 'projects',
    action: 'update',
    category: 'Projects',
    description: 'Edit a project and its tasks',
  },
  'projects:open': {
    resource: 'projects',
    action: 'open',
    category: 'Projects',
    description: 'Open a draft project, resume one on hold, or reopen a completed one',
  },
  'projects:hold': {
    resource: 'projects',
    action: 'hold',
    category: 'Projects',
    description: 'Put an open project on hold',
  },
  'projects:complete': {
    resource: 'projects',
    action: 'complete',
    category: 'Projects',
    description: 'Mark a project completed',
  },
  'projects:close': {
    resource: 'projects',
    action: 'close',
    category: 'Projects',
    description: 'Close a completed project so it can no longer change',
  },
  'projects:cancel': {
    resource: 'projects',
    action: 'cancel',
    category: 'Projects',
    description: 'Cancel a project',
  },

  'customers:read': {
    resource: 'customers',
    action: 'read',
    category: 'Customers',
    description: 'View customer accounts and profiles',
  },
  'customers:create': {
    resource: 'customers',
    action: 'create',
    category: 'Customers',
    description: 'Create customer accounts',
  },
  'customers:update': {
    resource: 'customers',
    action: 'update',
    category: 'Customers',
    description: 'Edit customer accounts',
  },
  'customers:delete': {
    resource: 'customers',
    action: 'delete',
    category: 'Customers',
    description: 'Delete customer accounts',
  },
  'customers:import': {
    resource: 'customers',
    action: 'import',
    category: 'Customers',
    description: 'Bulk import customers',
  },
  'customers:export': {
    resource: 'customers',
    action: 'export',
    category: 'Customers',
    description: 'Export customers',
  },

  'products:read': {
    resource: 'products',
    action: 'read',
    category: 'Products & Inventory',
    description: 'View products and categories',
  },
  'products:create': {
    resource: 'products',
    action: 'create',
    category: 'Products & Inventory',
    description: 'Create products',
  },
  'products:update': {
    resource: 'products',
    action: 'update',
    category: 'Products & Inventory',
    description: 'Edit products',
  },
  'products:delete': {
    resource: 'products',
    action: 'delete',
    category: 'Products & Inventory',
    description: 'Delete products',
  },
  'products:delete_permanently': {
    resource: 'products',
    action: 'delete_permanently',
    category: 'Products & Inventory',
    description: 'Permanently erase products (cannot be undone)',
  },
  'products:adjust_stock': {
    resource: 'products',
    action: 'adjust_stock',
    category: 'Products & Inventory',
    description: 'Adjust product stock levels',
  },
  'media:read': {
    resource: 'media',
    action: 'read',
    category: 'Products & Inventory',
    description: 'Browse the media library',
  },
  'media:upload': {
    resource: 'media',
    action: 'upload',
    category: 'Products & Inventory',
    description: 'Upload images and add image links to the media library',
  },
  'media:delete': {
    resource: 'media',
    action: 'delete',
    category: 'Products & Inventory',
    description: 'Delete media from the library',
  },
  'inventory:read': {
    resource: 'inventory',
    action: 'read',
    category: 'Products & Inventory',
    description: 'View inventory ledger and stock levels',
  },
  'inventory:adjust': {
    resource: 'inventory',
    action: 'adjust',
    category: 'Products & Inventory',
    description: 'Receive, write off, and audit stock',
  },

  'taxes:manage': {
    resource: 'taxes',
    action: 'manage',
    category: 'Finance & Payments',
    description: 'Manage tax categories and compliance schedules',
  },
  'credit_notes:create': {
    resource: 'credit_notes',
    action: 'create',
    category: 'Finance & Payments',
    description: 'Issue credit notes against tax invoices and retry their KRA signing',
  },
  'approvals:act': {
    resource: 'approvals',
    action: 'act',
    category: 'Orders & Sales',
    description:
      'Approve or reject documents that other people sent to you (the "Waiting on me" inbox)',
  },
  'approvals:request': {
    resource: 'approvals',
    action: 'request',
    category: 'Orders & Sales',
    description:
      'Follow the documents you sent for approval, and withdraw or reopen them ("My requests")',
  },
  'approvals:manage': {
    resource: 'approvals',
    action: 'manage',
    category: 'Company & Settings',
    description:
      'Design approval workflows, set approvers and limits, and switch approvals on or off',
  },
  'pricing:read': {
    resource: 'pricing',
    action: 'read',
    category: 'Orders & Sales',
    description: 'See price lists, customer groups and check how a price is worked out',
  },
  'pricing:manage': {
    resource: 'pricing',
    action: 'manage',
    category: 'Orders & Sales',
    description:
      'Create and change price lists and prices, discounts, rebates, loyalty, gift cards, customer groups and pricing rules',
  },
  'numbering:manage': {
    resource: 'numbering',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Manage number series and which series numbers each document',
  },
  'gl_accounts:read': {
    resource: 'gl_accounts',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View the chart of accounts',
  },
  'gl_accounts:create': {
    resource: 'gl_accounts',
    action: 'create',
    category: 'Finance & Payments',
    description: 'Create general ledger accounts',
  },
  'gl_accounts:edit': {
    resource: 'gl_accounts',
    action: 'edit',
    category: 'Finance & Payments',
    description: 'Edit general ledger accounts',
  },
  'gl_accounts:block': {
    resource: 'gl_accounts',
    action: 'block',
    category: 'Finance & Payments',
    description: 'Block or unblock general ledger accounts',
  },
  'gl_accounts:delete': {
    resource: 'gl_accounts',
    action: 'delete',
    category: 'Finance & Payments',
    description: 'Delete general ledger accounts that have never been posted to',
  },
  'gl_templates:apply': {
    resource: 'gl_templates',
    action: 'apply',
    category: 'Finance & Payments',
    description: 'Apply a chart of accounts template to this company',
  },
  'finance_settings:edit': {
    resource: 'finance_settings',
    action: 'edit',
    category: 'Finance & Payments',
    description: 'Change finance settings such as the company-wide posting window',
  },
  'posting_setup:read': {
    resource: 'posting_setup',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View posting groups and posting setup',
  },
  'posting_setup:edit': {
    resource: 'posting_setup',
    action: 'edit',
    category: 'Finance & Payments',
    description: 'Create and change posting groups and posting setup',
  },
  'fiscal_calendar:edit': {
    resource: 'fiscal_calendar',
    action: 'edit',
    category: 'Finance & Payments',
    description: 'Create fiscal years and accounting periods',
  },
  'period:soft_close': {
    resource: 'period',
    action: 'soft_close',
    category: 'Finance & Payments',
    description: 'Soft-close an accounting period',
  },
  'period:close': {
    resource: 'period',
    action: 'close',
    category: 'Finance & Payments',
    description: 'Close an accounting period',
  },
  'period:reopen': {
    resource: 'period',
    action: 'reopen',
    category: 'Finance & Payments',
    description: 'Reopen a closed accounting period',
  },
  'period:lock': {
    resource: 'period',
    action: 'lock',
    category: 'Finance & Payments',
    description: 'Lock an accounting period permanently (year-end)',
  },
  'period:post_to_soft_closed': {
    resource: 'period',
    action: 'post_to_soft_closed',
    category: 'Finance & Payments',
    description: 'Post into a soft-closed accounting period',
  },
  'journal_batches:create': {
    resource: 'journal_batches',
    action: 'create',
    category: 'Finance & Payments',
    description: 'Create journal batches',
  },
  'journals:edit_draft': {
    resource: 'journals',
    action: 'edit_draft',
    category: 'Finance & Payments',
    description: 'Add, change and delete draft journal lines',
  },
  'journals:preview': {
    resource: 'journals',
    action: 'preview',
    category: 'Finance & Payments',
    description: 'Preview the entries a journal would post',
  },
  'journals:post': {
    resource: 'journals',
    action: 'post',
    category: 'Finance & Payments',
    description: 'Post journals to the general ledger',
  },
  'journals:post_to_control_account': {
    resource: 'journals',
    action: 'post_to_control_account',
    category: 'Finance & Payments',
    description: 'Post manual journals to control accounts (normally nobody)',
  },
  'ledger_entries:reverse': {
    resource: 'ledger_entries',
    action: 'reverse',
    category: 'Finance & Payments',
    description: 'Reverse a posted register with a reason',
  },
  'gl_entries:read': {
    resource: 'gl_entries',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View general ledger entries',
  },
  'ledger_registers:read': {
    resource: 'ledger_registers',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View ledger registers and verify the hash chain',
  },
  'trial_balance:read': {
    resource: 'trial_balance',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View the trial balance',
  },
  'finance_audit:read': {
    resource: 'finance_audit',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View the finance audit trail',
  },
  'fiscal_calendar:read': {
    resource: 'fiscal_calendar',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View fiscal years and accounting periods',
  },
  'journals:read': {
    resource: 'journals',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View journal batches and their draft lines',
  },
  'currencies:manage': {
    resource: 'currencies',
    action: 'manage',
    category: 'Finance & Payments',
    description: 'Manage currencies and exchange rates',
  },
  'bank_accounts:read': {
    resource: 'bank_accounts',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View bank, cash and mobile-money accounts',
  },
  'bank_accounts:create': {
    resource: 'bank_accounts',
    action: 'create',
    category: 'Finance & Payments',
    description: 'Add bank, cash and mobile-money accounts',
  },
  'bank_accounts:edit': {
    resource: 'bank_accounts',
    action: 'edit',
    category: 'Finance & Payments',
    description: 'Change a bank account',
  },
  'bank_accounts:block': {
    resource: 'bank_accounts',
    action: 'block',
    category: 'Finance & Payments',
    description: 'Block or unblock a bank account',
  },
  'bank_accounts:delete': {
    resource: 'bank_accounts',
    action: 'delete',
    category: 'Finance & Payments',
    description: 'Delete an unused bank account',
  },
  'bank_ledger:read': {
    resource: 'bank_ledger',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View the movements on a bank account',
  },
  'payment_methods:read': {
    resource: 'payment_methods',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View payment methods',
  },
  'payment_methods:create': {
    resource: 'payment_methods',
    action: 'create',
    category: 'Finance & Payments',
    description: 'Add payment methods',
  },
  'payment_methods:edit': {
    resource: 'payment_methods',
    action: 'edit',
    category: 'Finance & Payments',
    description: 'Change a payment method',
  },
  'payment_methods:disable': {
    resource: 'payment_methods',
    action: 'disable',
    category: 'Finance & Payments',
    description: 'Switch a payment method on or off',
  },
  'payment_methods:delete': {
    resource: 'payment_methods',
    action: 'delete',
    category: 'Finance & Payments',
    description: 'Delete an unused payment method',
  },
  'payment_setup:seed': {
    resource: 'payment_setup',
    action: 'seed',
    category: 'Finance & Payments',
    description: 'Create the standard bank accounts and payment methods for the chart in use',
  },
  'payment_setup:link_orders': {
    resource: 'payment_setup',
    action: 'link_orders',
    category: 'Finance & Payments',
    description: 'Link past orders to payment methods',
  },
  'payment_providers:read': {
    resource: 'payment_providers',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View payment provider connections (secrets stay hidden)',
  },
  'payment_activity:read': {
    resource: 'payment_activity',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View what happened on the payment platforms: requests, callbacks, confirmations and failures',
  },
  'payment_activity:resolve': {
    resource: 'payment_activity',
    action: 'resolve',
    category: 'Finance & Payments',
    description: 'Place or set aside a confirmed payment that nobody could place',
  },
  'payment_operations:run': {
    resource: 'payment_operations',
    action: 'run',
    category: 'Finance & Payments',
    description: 'Run a payment-platform operation (register addresses, check a transaction, QR code...)',
  },
  'payment_operations:request_payout': {
    resource: 'payment_operations',
    action: 'request_payout',
    category: 'Finance & Payments',
    description: 'Ask for money to be paid out through a payment provider (still needs approval)',
  },
  'refunds:pay_automatic': {
    resource: 'refunds',
    action: 'pay_automatic',
    category: 'Finance & Payments',
    description: 'Send an approved refund to the customer through M-Pesa',
  },
  'refunds:resolve_payout': {
    resource: 'refunds',
    action: 'resolve_payout',
    category: 'Finance & Payments',
    description: 'Check again, or close, an M-Pesa refund payout that could not be confirmed',
  },
  'refunds:record_return': {
    resource: 'refunds',
    action: 'record_return',
    category: 'Finance & Payments',
    description: 'Record that money from a paid refund came back, and start a replacement refund for it',
  },
  'refund_files:read': {
    resource: 'refund_files',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View bank payment files for refunds',
  },
  'refund_files:generate': {
    resource: 'refund_files',
    action: 'generate',
    category: 'Finance & Payments',
    description: 'Put approved bank-transfer refunds into a payment file for the bank',
  },
  'refund_files:download': {
    resource: 'refund_files',
    action: 'download',
    category: 'Finance & Payments',
    description: 'Download a bank payment file to upload to the bank',
  },
  'refund_files:confirm': {
    resource: 'refund_files',
    action: 'confirm',
    category: 'Finance & Payments',
    description: 'Record that the bank paid a payment file (never the person who made it)',
  },
  'refund_files:cancel': {
    resource: 'refund_files',
    action: 'cancel',
    category: 'Finance & Payments',
    description: 'Cancel a payment file the bank has not paid',
  },
  'refund_files:upload_evidence': {
    resource: 'refund_files',
    action: 'upload_evidence',
    category: 'Finance & Payments',
    description: 'Attach the bank\'s confirmation to a payment file',
  },
  'bank_match_rules:edit': {
    resource: 'bank_match_rules',
    action: 'edit',
    category: 'Finance & Payments',
    description: 'Change how bank statement lines are matched to our records (amounts, dates, references, phone numbers, names)',
  },
  'bank_feeds:read': {
    resource: 'bank_feeds',
    action: 'read',
    category: 'Finance & Payments',
    description: 'See whether a bank account has a feed, and when it last received lines',
  },
  'bank_feeds:manage': {
    resource: 'bank_feeds',
    action: 'manage',
    category: 'Finance & Payments',
    description: 'Make, replace the secret of, or switch off a bank feed (the address a bank pushes statement lines to)',
  },
  'inventory_posting:read': {
    resource: 'inventory_posting',
    action: 'read',
    category: 'Finance & Payments',
    description: 'See whether stock is in the books, what is waiting to post, and whether the books agree with the shelves',
  },
  'inventory_posting:go_live': {
    resource: 'inventory_posting',
    action: 'go_live',
    category: 'Finance & Payments',
    description: 'Switch stock on for the general ledger, bringing in the stock on hand as an opening balance',
  },
  'inventory_posting:retry': {
    resource: 'inventory_posting',
    action: 'retry',
    category: 'Finance & Payments',
    description: 'Try again to post a stock change that could not be posted',
  },
  'exchange_rates:read': {
    resource: 'exchange_rates',
    action: 'read',
    category: 'Finance & Payments',
    description: 'See the exchange rates and the foreign-currency revaluations',
  },
  'exchange_rates:manage': {
    resource: 'exchange_rates',
    action: 'manage',
    category: 'Finance & Payments',
    description: 'Set exchange rates for today or the days ahead, and remove ones that have not started',
  },
  'exchange_rates:revalue': {
    resource: 'exchange_rates',
    action: 'revalue',
    category: 'Finance & Payments',
    description: 'Revalue what customers owe in a foreign currency at today\'s rate (it is undone the next day)',
  },
  'credit_adjustments:read': {
    resource: 'credit_adjustments',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View requests to give up, add or take off customer credit',
  },
  'credit_adjustments:request': {
    resource: 'credit_adjustments',
    action: 'request',
    category: 'Finance & Payments',
    description: 'Ask to give up an excess a customer is owed, or to add to or take from a wallet',
  },
  'credit_adjustments:decide': {
    resource: 'credit_adjustments',
    action: 'decide',
    category: 'Finance & Payments',
    description: 'Approve or turn down a credit adjustment when no approval workflow covers it (never your own)',
  },
  'credit_adjustments:cancel': {
    resource: 'credit_adjustments',
    action: 'cancel',
    category: 'Finance & Payments',
    description: 'Cancel a credit adjustment that has not taken effect',
  },
  'payments:confirm_unverified': {
    resource: 'payments',
    action: 'confirm_unverified',
    category: 'Finance & Payments',
    description: 'Confirm or close a payment the platform could not confirm, with a reason',
  },
  'payment_providers:create': {
    resource: 'payment_providers',
    action: 'create',
    category: 'Finance & Payments',
    description: 'Add a payment provider (a connection to a payment service)',
  },
  'payment_providers:delete': {
    resource: 'payment_providers',
    action: 'delete',
    category: 'Finance & Payments',
    description: 'Delete a payment provider that nothing uses',
  },
  'payment_providers:edit': {
    resource: 'payment_providers',
    action: 'edit',
    category: 'Finance & Payments',
    description: 'Change a payment provider connection (URLs, environment, settings)',
  },
  'payment_providers:set_credentials': {
    resource: 'payment_providers',
    action: 'set_credentials',
    category: 'Finance & Payments',
    description: 'Enter or replace payment provider credentials',
  },
  'payment_providers:enable': {
    resource: 'payment_providers',
    action: 'enable',
    category: 'Finance & Payments',
    description: 'Switch a payment provider on or off',
  },
  'payment_providers:test': {
    resource: 'payment_providers',
    action: 'test',
    category: 'Finance & Payments',
    description: 'Run "Test connection" on a payment provider',
  },
  'receipts:read': {
    resource: 'receipts',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View customer receipts',
  },
  'receipts:create': {
    resource: 'receipts',
    action: 'create',
    category: 'Finance & Payments',
    description: 'Record a customer receipt as a draft',
  },
  'receipts:cancel_draft': {
    resource: 'receipts',
    action: 'cancel_draft',
    category: 'Finance & Payments',
    description: 'Cancel a draft receipt',
  },
  'receipts:post': {
    resource: 'receipts',
    action: 'post',
    category: 'Finance & Payments',
    description: 'Post a customer receipt',
  },
  'receipts:apply': {
    resource: 'receipts',
    action: 'apply',
    category: 'Finance & Payments',
    description: 'Apply a receipt to invoices',
  },
  'receipts:unapply': {
    resource: 'receipts',
    action: 'unapply',
    category: 'Finance & Payments',
    description: 'Undo the application of a receipt to invoices',
  },
  'receipts:reverse': {
    resource: 'receipts',
    action: 'reverse',
    category: 'Finance & Payments',
    description: 'Reverse a posted receipt',
  },
  'receipts:attach_evidence': {
    resource: 'receipts',
    action: 'attach_evidence',
    category: 'Finance & Payments',
    description: 'Attach evidence (deposit slip, screenshot, cheque image) to a receipt',
  },
  'bank_statements:read': {
    resource: 'bank_statements',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View bank statements, their lines and the matching work',
  },
  'bank_statements:import': {
    resource: 'bank_statements',
    action: 'import',
    category: 'Finance & Payments',
    description: 'Import a bank statement file',
  },
  'bank_statements:match': {
    resource: 'bank_statements',
    action: 'match',
    category: 'Finance & Payments',
    description: 'Match statement lines to the bank ledger',
  },
  'bank_statements:unmatch': {
    resource: 'bank_statements',
    action: 'unmatch',
    category: 'Finance & Payments',
    description: 'Undo a statement line match',
  },
  'bank_statements:ignore': {
    resource: 'bank_statements',
    action: 'ignore',
    category: 'Finance & Payments',
    description: 'Set a statement line aside, or bring it back',
  },
  'bank_statements:create_receipt': {
    resource: 'bank_statements',
    action: 'create_receipt',
    category: 'Finance & Payments',
    description: 'Turn an unrecorded deposit on a statement into a customer receipt',
  },
  'bank_statements:record_charge': {
    resource: 'bank_statements',
    action: 'record_charge',
    category: 'Finance & Payments',
    description: 'Record a bank charge from a statement line',
  },
  'bank_reconciliation:post': {
    resource: 'bank_reconciliation',
    action: 'post',
    category: 'Finance & Payments',
    description: 'Post a bank reconciliation',
  },
  'bank_reconciliation:reverse': {
    resource: 'bank_reconciliation',
    action: 'reverse',
    category: 'Finance & Payments',
    description: 'Reverse the latest bank reconciliation of an account',
  },
  'cheques:deposit': {
    resource: 'cheques',
    action: 'deposit',
    category: 'Finance & Payments',
    description: 'Record that a received cheque was deposited',
  },
  'cheques:clear': {
    resource: 'cheques',
    action: 'clear',
    category: 'Finance & Payments',
    description: 'Record that a deposited cheque cleared',
  },
  'cheques:bounce': {
    resource: 'cheques',
    action: 'bounce',
    category: 'Finance & Payments',
    description: 'Record that a cheque bounced',
  },
  'customer_ledger:read': {
    resource: 'customer_ledger',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View a customer ledger and statement',
  },
  'receivables_ageing:read': {
    resource: 'receivables_ageing',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View the receivables ageing report',
  },
  'sales_gl_go_live:set': {
    resource: 'sales_gl_go_live',
    action: 'set',
    category: 'Finance & Payments',
    description: 'Set the date from which sales documents post to the general ledger',
  },
  'sales_posting:read': {
    resource: 'sales_posting',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View sales waiting to be posted to the general ledger and the receivables reconciliation',
  },
  'sales_posting:retry': {
    resource: 'sales_posting',
    action: 'retry',
    category: 'Finance & Payments',
    description: 'Retry sales that could not be posted to the general ledger',
  },
  'wallet:read': {
    resource: 'wallet',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View customer wallets, their entries and the wallet liability report',
  },
  'wallet:deposit': {
    resource: 'wallet',
    action: 'deposit',
    category: 'Finance & Payments',
    description: 'Record an advance deposit into a customer wallet',
  },
  'wallet:move_receipt': {
    resource: 'wallet',
    action: 'move_receipt',
    category: 'Finance & Payments',
    description: 'Move the unapplied part of a receipt into the customer wallet',
  },
  'wallet:utilise': {
    resource: 'wallet',
    action: 'utilise',
    category: 'Finance & Payments',
    description: 'Pay invoices from the customer wallet',
  },
  'wallet:reverse_use': {
    resource: 'wallet',
    action: 'reverse_use',
    category: 'Finance & Payments',
    description: 'Undo a use of the wallet',
  },
  'wallet:freeze': {
    resource: 'wallet',
    action: 'freeze',
    category: 'Finance & Payments',
    description: 'Freeze or unfreeze a customer wallet',
  },
  'customer_credit_policy:edit': {
    resource: 'customer_credit_policy',
    action: 'edit',
    category: 'Finance & Payments',
    description: 'Change the refund-or-wallet policy',
  },
  'credit_note_excess:read': {
    resource: 'credit_note_excess',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View credit notes whose excess still needs a decision',
  },
  'credit_notes:resolve_excess': {
    resource: 'credit_notes',
    action: 'resolve_excess',
    category: 'Finance & Payments',
    description: 'Settle a credit note excess: put it in the wallet or use it on other invoices',
  },
  'return_receipts:read': {
    resource: 'return_receipts',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View returns expected back because of credit notes',
  },
  'restock:confirm': {
    resource: 'restock',
    action: 'confirm',
    category: 'Finance & Payments',
    description: 'Confirm goods that came back, and put good ones into stock',
  },
  'restock:reject': {
    resource: 'restock',
    action: 'reject',
    category: 'Finance & Payments',
    description: 'Close a return whose goods are not coming back',
  },
  'refunds:read': {
    resource: 'refunds',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View refunds, their history and the refund report',
  },
  'refunds:create': {
    resource: 'refunds',
    action: 'create',
    category: 'Finance & Payments',
    description: 'Ask for a refund to be paid to a customer',
  },
  'refunds:submit': {
    resource: 'refunds',
    action: 'submit',
    category: 'Finance & Payments',
    description: 'Send a refund on for approval and payment',
  },
  'refunds:cancel': {
    resource: 'refunds',
    action: 'cancel',
    category: 'Finance & Payments',
    description: 'Cancel a refund that has not been paid',
  },
  'refunds:record_manual_payout': {
    resource: 'refunds',
    action: 'record_manual_payout',
    category: 'Finance & Payments',
    description: 'Record that a refund was paid out by hand',
  },
  'refunds:upload_evidence': {
    resource: 'refunds',
    action: 'upload_evidence',
    category: 'Finance & Payments',
    description: 'Attach evidence of payment to a refund',
  },
  'refunds:change_destination': {
    resource: 'refunds',
    action: 'change_destination',
    category: 'Finance & Payments',
    description: 'Refund to a phone number other than the customers own',
  },
  'payments:read': {
    resource: 'payments',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View payments and attempts',
  },
  'payments:refund': {
    resource: 'payments',
    action: 'refund',
    category: 'Finance & Payments',
    description: 'Issue refunds',
  },
  'payments:manage_gateways': {
    resource: 'payments',
    action: 'manage_gateways',
    category: 'Finance & Payments',
    description: 'Configure payment gateways and providers',
  },
  'transactions:read': {
    resource: 'transactions',
    action: 'read',
    category: 'Finance & Payments',
    description: 'View the transactions ledger',
  },
  'transactions:post': {
    resource: 'transactions',
    action: 'post',
    category: 'Finance & Payments',
    description: 'Post ledger entries',
  },
  'transactions:reconcile': {
    resource: 'transactions',
    action: 'reconcile',
    category: 'Finance & Payments',
    description: 'Reconcile payments and ledger lines',
  },
  'transactions:export': {
    resource: 'transactions',
    action: 'export',
    category: 'Finance & Payments',
    description: 'Export ledger transactions',
  },

  'branches:read': {
    resource: 'branches',
    action: 'read',
    category: 'Company & Settings',
    description: 'View branches',
  },
  'branches:manage': {
    resource: 'branches',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Create and update branches',
  },
  'dimensions:manage': {
    resource: 'dimensions',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Manage dimensions and their values',
  },
  'company:read': {
    resource: 'company',
    action: 'read',
    category: 'Company & Settings',
    description: 'View company setup',
  },
  'company:manage': {
    resource: 'company',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Edit company profile, appearance, and modules',
  },
  'settings:read': {
    resource: 'settings',
    action: 'read',
    category: 'Company & Settings',
    description: 'View settings',
  },
  'settings:manage': {
    resource: 'settings',
    action: 'manage',
    category: 'Company & Settings',
    description: 'Change application settings',
  },

  'users:read': {
    resource: 'users',
    action: 'read',
    category: 'Users & Access',
    description: 'View user accounts',
  },
  'users:create': {
    resource: 'users',
    action: 'create',
    category: 'Users & Access',
    description: 'Create user accounts',
  },
  'users:update': {
    resource: 'users',
    action: 'update',
    category: 'Users & Access',
    description: 'Edit user profiles and status',
  },
  'users:delete': {
    resource: 'users',
    action: 'delete',
    category: 'Users & Access',
    description: 'Delete user accounts',
  },
  'users:manage_roles': {
    resource: 'users',
    action: 'manage_roles',
    category: 'Users & Access',
    description: 'Assign roles and direct permission grants',
  },
  'users:reset_password': {
    resource: 'users',
    action: 'reset_password',
    category: 'Users & Access',
    description: 'Reset user passwords',
  },
  'roles:read': {
    resource: 'roles',
    action: 'read',
    category: 'Users & Access',
    description: 'View roles and their permissions',
  },
  'roles:manage': {
    resource: 'roles',
    action: 'manage',
    category: 'Users & Access',
    description: 'Create roles and edit role permission bindings',
  },
  'policies:read': {
    resource: 'policies',
    action: 'read',
    category: 'Users & Access',
    description: 'View access policies',
  },
  'policies:manage': {
    resource: 'policies',
    action: 'manage',
    category: 'Users & Access',
    description: 'Create and edit ABAC access policies',
  },
  'audits:read': {
    resource: 'audits',
    action: 'read',
    category: 'Users & Access',
    description: 'View the security audit trail',
  },
  'audits:export': {
    resource: 'audits',
    action: 'export',
    category: 'Users & Access',
    description: 'Export the audit trail',
  },
} as const satisfies Record<string, PermissionMeta>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/** Group permission keys by category for matrix rendering. */
export function groupPermissionsByCategory(
  keys: readonly PermissionKey[],
): { category: string; permissions: { key: PermissionKey; meta: PermissionMeta }[] }[] {
  const grouped = new Map<string, { key: PermissionKey; meta: PermissionMeta }[]>();
  for (const key of keys) {
    const meta = PERMISSIONS[key];
    const bucket = grouped.get(meta.category) ?? [];
    bucket.push({ key, meta });
    grouped.set(meta.category, bucket);
  }
  const order = PERMISSION_CATEGORIES;
  return order.flatMap((category) => {
    const items = grouped.get(category);
    return items
      ? [
          {
            category,
            permissions: items.sort((a, b) => a.meta.resource.localeCompare(b.meta.resource)),
          },
        ]
      : [];
  });
}
