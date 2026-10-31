/**
 * What each module of the platform is called in everyday words, what it does, and the words people type into a
 * search box to find it. Every module in the admin navigation MUST have an entry (a test enforces it): a module is
 * not finished until it is described here, because this is what the public platform page and its structured data
 * are made from. Write for a shop owner in Kenya, not for engineers: "point of sale", "stock control", "invoicing",
 * "M-Pesa", "KRA PIN", "eTIMS".
 */

export const PLATFORM_NAME = 'qsell';

export interface PlatformModuleSeo {
  /** The id of the module in the admin navigation (`src/config/admin-nav/nav.config.ts`). */
  navId: string;
  /** Plain-language name people know it by. */
  name: string;
  /** One sentence: what the business gets. */
  summary: string;
  /** What it does, as short plain statements (each becomes a visible line and a feature in the page data). */
  features: string[];
  /** Words people search for. Real phrases, no repeats, no places the platform does not serve. */
  keywords: string[];
  /** The sub-modules by their navigation titles, so none is left out. */
  subModules: string[];
}

export const PLATFORM_MODULES: readonly PlatformModuleSeo[] = [
  {
    navId: 'dashboard',
    name: 'Business overview and reports',
    summary: 'See sales, stock, money owed and profit for the whole business on one screen.',
    features: ['Daily, weekly and monthly sales reports', 'Best-selling products and busiest branches', 'Profit and margin reports for owners', 'Reports by branch, customer and product'],
    keywords: ['business reports software Kenya', 'sales report software', 'business dashboard', 'profit and loss report', 'business analytics for small business'],
    subModules: [],
  },
  {
    navId: 'company',
    name: 'Online shop and company setup',
    summary: 'Run your own branded online shop with your name, logo, colours, banners, policies and contacts.',
    features: ['Your own online shop on your own web address', 'Company profile, logo and brand colours', 'Promotional banners and shop policies', 'Customer help, FAQs, guarantees and contact details'],
    keywords: ['online shop software Kenya', 'ecommerce website for small business Kenya', 'create an online store Kenya', 'ecommerce platform Kenya', 'sell online in Kenya'],
    subModules: ['Profile', 'Appearance', 'Modules', 'Support', 'Banners', 'Policies'],
  },
  {
    navId: 'sales',
    name: 'Sales, orders and customers',
    summary: 'Take orders online and in the shop, send quotes, manage customers and set prices.',
    features: ['Point of sale and online orders in one system', 'Sales quotes that become orders', 'Customer records, order history and newsletter', 'Product reviews with moderation', 'Price lists, discounts and promotions'],
    keywords: ['point of sale software Kenya', 'POS system Kenya', 'sales management software', 'order management system', 'quotation software', 'customer management software', 'retail POS Nairobi'],
    subModules: ['Sales Quotes', 'Customer Orders', 'Newsletter', 'Product Reviews', 'Customers', 'Pricing'],
  },
  {
    navId: 'products-inventory',
    name: 'Inventory and stock control',
    summary: 'Know what you have, where it is and when to reorder, in the units you actually sell.',
    features: ['Stock levels by branch and low-stock alerts', 'Several warehouses, shops and vans, each with its own stock', 'Products, categories, bundles and hampers', 'Kilograms, litres, pieces and packs with the right decimals', 'Stock ledger with every movement recorded'],
    keywords: ['inventory management software Kenya', 'stock control system', 'stock management software for shops', 'inventory software for small business', 'warehouse management', 'product catalogue software'],
    subModules: ['Products', 'Trash', 'Item Types', 'Units of Measure', 'Categories', 'Kits and hampers', 'Product groups', 'Stock levels', 'Stock locations'],
  },
  {
    navId: 'users-access',
    name: 'Staff accounts and permissions',
    summary: 'Give each person exactly the access their job needs, and see who did what.',
    features: ['Staff accounts and roles', 'Permissions down to single actions', 'Access policies and sign-in rules', 'An audit trail of changes'],
    keywords: ['staff access control software', 'user roles and permissions', 'secure business software', 'audit trail software'],
    subModules: ['Users', 'Roles & Permissions', 'Access Policies'],
  },
  {
    navId: 'projects',
    name: 'Project and job tracking',
    summary: 'Quote, run and close jobs with their costs and billing in one place.',
    features: ['Projects from quote to completion', 'Costs and billing per project', 'Hold, complete and close with approvals'],
    keywords: ['project management software for small business', 'job costing software', 'project billing software'],
    subModules: [],
  },
  {
    navId: 'vendor-management',
    name: 'Suppliers and purchasing',
    summary: 'Buy from suppliers with purchase orders, receive goods, pay invoices and know what you owe.',
    features: ['Purchase orders, requisitions and requests for quotation', 'Goods received and supplier invoices', 'Payments to suppliers by bank or M-Pesa', 'What you owe, supplier scorecards and contracts', 'Petty cash with receipts', 'Withholding tax certificates'],
    keywords: ['supplier management software', 'purchase order software Kenya', 'accounts payable software', 'procurement software', 'vendor management system', 'petty cash software'],
    subModules: ['Vendors', 'Requests for quotation', 'Purchase orders', 'Received goods', 'Supplier invoices', 'Credit memos', 'Payments to vendors', 'What we owe', 'Vendor reports', 'Vendor scorecard', 'Landed costs', 'Vendor contracts', 'Purchase requisitions', 'Goods sent back', 'Refunds from vendors', 'Petty cash', 'Payment rules', 'Withholding certificates', 'Ordering rules', 'Prequalification', 'Categories', 'Review queue', 'Bank changes', 'Expiring documents', 'Document types'],
  },
  {
    navId: 'finance',
    name: 'Accounting, invoicing and payments',
    summary: 'Invoices, receipts, payments, bank and cash, and the books, with M-Pesa and cards.',
    features: ['Invoicing and receipts', 'M-Pesa, card and bank payments', 'General ledger, accounts receivable and bank reconciliation', 'Multiple currencies', 'KRA eTIMS and tax compliance'],
    keywords: ['accounting software Kenya', 'invoicing software Kenya', 'M-Pesa payments for business', 'KRA eTIMS invoicing', 'bookkeeping software small business', 'accounts receivable software', 'bank reconciliation software'],
    subModules: ['General Ledger', 'Accounts Receivable', 'Bank & Cash', 'Currencies & FX', 'Transactions', 'Payments', 'Customer Analytics'],
  },
  {
    navId: 'approvals',
    name: 'Approvals and controls',
    summary: 'Large payments, discounts and orders wait for the right person to approve them.',
    features: ['Approval requests with limits', 'A queue of what waits for you', 'A record of who approved what'],
    keywords: ['approval workflow software', 'expense approval system', 'business controls and approvals'],
    subModules: ['Waiting on me', 'My requests'],
  },
  {
    navId: 'settings',
    name: 'Branches, taxes and numbering',
    summary: 'Set up branches, tax rules, payment methods and document numbering once and use them everywhere.',
    features: ['Multiple branches and business units', 'VAT and tax compliance', 'Payment methods and gateways', 'Automatic invoice and order numbering', 'Time limits for each order stage, with late-order alerts'],
    keywords: ['multi-branch retail software', 'VAT software Kenya', 'tax compliance software', 'business setup software'],
    subModules: ['Dimensions', 'Branches', 'Payments', 'Number Series', 'Document Numbering', 'Approvals', 'Tax Compliance', 'Order Targets'],
  },
];

/** Words that describe the platform as a whole, ahead of any single module. */
export const PLATFORM_KEYWORDS: readonly string[] = [
  'business management software Kenya',
  'ecommerce platform Kenya',
  'point of sale software Kenya',
  'sales management software',
  'inventory management software',
  'POS and inventory system',
  'accounting and invoicing software',
  'M-Pesa POS',
];

export function platformKeywords(): string[] {
  return [...new Set([...PLATFORM_KEYWORDS, ...PLATFORM_MODULES.flatMap((module) => module.keywords)])];
}
