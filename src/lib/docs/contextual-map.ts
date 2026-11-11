/**
 * Pure mapping utility connecting live application routes to their corresponding
 * implementor manual chapter.
 *
 * This enables the AdminShell contextual help button to deep-link straight to the exact
 * chapter relevant to what the operator or sales implementor is currently viewing.
 */

interface RouteDocRule {
  readonly prefix: string;
  readonly slug: string;
  readonly chapterTitle: string;
  /** When true, only the exact route matches (no sub-paths). */
  readonly exact?: boolean;
}

const ROUTE_RULES: readonly RouteDocRule[] = [
  {
    prefix: '/admin/company',
    slug: '02-company-setup-and-storefront',
    chapterTitle: 'Company Setup & Storefront',
  },
  {
    prefix: '/admin/pricing',
    slug: '04-pricing-engine-promotions-and-margins',
    chapterTitle: 'Pricing Engine, Promotions & Margins',
  },
  {
    prefix: '/admin/catalog',
    slug: '05-products-catalog-and-inventory-control',
    chapterTitle: 'Products Catalog & Inventory Control',
  },
  {
    prefix: '/admin/inventory',
    slug: '05-products-catalog-and-inventory-control',
    chapterTitle: 'Products Catalog & Inventory Control',
  },
  {
    prefix: '/admin/products',
    slug: '05-products-catalog-and-inventory-control',
    chapterTitle: 'Products Catalog & Inventory Control',
  },
  {
    prefix: '/admin/categories',
    slug: '05-products-catalog-and-inventory-control',
    chapterTitle: 'Products Catalog & Inventory Control',
  },
  {
    prefix: '/admin/item-types',
    slug: '05-products-catalog-and-inventory-control',
    chapterTitle: 'Products Catalog & Inventory Control',
  },
  {
    prefix: '/admin/delivery',
    slug: '06-delivery-logistics-and-field-dispatch',
    chapterTitle: 'Delivery Logistics & Field Dispatch',
  },
  {
    prefix: '/admin/users',
    slug: '07-users-roles-and-access-governance',
    chapterTitle: 'Users, Roles & Access Governance',
  },
  {
    prefix: '/admin/projects',
    slug: '08-projects-and-job-costing',
    chapterTitle: 'Projects & Job Costing',
  },
  {
    prefix: '/admin/vendors',
    slug: '09-vendor-management-procurement-and-payables',
    chapterTitle: 'Vendor Management, Procurement & Payables',
  },
  {
    prefix: '/admin/finance',
    slug: '10-finance-general-ledger-and-accounts-receivable',
    chapterTitle: 'Finance, General Ledger & Accounts Receivable',
  },
  {
    prefix: '/admin/reconciliation',
    slug: '10-finance-general-ledger-and-accounts-receivable',
    chapterTitle: 'Finance, General Ledger & Accounts Receivable',
  },
  {
    prefix: '/admin/transactions',
    slug: '10-finance-general-ledger-and-accounts-receivable',
    chapterTitle: 'Finance, General Ledger & Accounts Receivable',
  },
  {
    prefix: '/admin/payments',
    slug: '11-banking-cash-and-payment-gateways',
    chapterTitle: 'Banking, Cash & Payment Gateways',
  },
  {
    prefix: '/admin/gateways',
    slug: '11-banking-cash-and-payment-gateways',
    chapterTitle: 'Banking, Cash & Payment Gateways',
  },
  {
    prefix: '/admin/approvals',
    slug: '12-approvals-and-internal-controls',
    chapterTitle: 'Approvals & Internal Controls',
  },
  {
    prefix: '/admin/settings',
    slug: '13-settings-branches-numbering-and-kra-etims',
    chapterTitle: 'Settings, Branches, Numbering & KRA eTIMS',
  },
  {
    prefix: '/admin/currencies',
    slug: '13-settings-branches-numbering-and-kra-etims',
    chapterTitle: 'Settings, Branches, Numbering & KRA eTIMS',
  },
  {
    prefix: '/admin/taxes',
    slug: '13-settings-branches-numbering-and-kra-etims',
    chapterTitle: 'Settings, Branches, Numbering & KRA eTIMS',
  },
  {
    prefix: '/admin/integration-audit',
    slug: '13-settings-branches-numbering-and-kra-etims',
    chapterTitle: 'Settings, Branches, Numbering & KRA eTIMS',
  },
  {
    prefix: '/admin/application-errors',
    slug: '13-settings-branches-numbering-and-kra-etims',
    chapterTitle: 'Settings, Branches, Numbering & KRA eTIMS',
  },
  {
    prefix: '/admin/sales',
    slug: '03-sales-quotes-and-customer-orders',
    chapterTitle: 'Sales Quotes & Customer Orders',
  },
  {
    prefix: '/admin/orders',
    slug: '03-sales-quotes-and-customer-orders',
    chapterTitle: 'Sales Quotes & Customer Orders',
  },
  {
    prefix: '/admin/quotes',
    slug: '03-sales-quotes-and-customer-orders',
    chapterTitle: 'Sales Quotes & Customer Orders',
  },
  {
    prefix: '/admin/customers',
    slug: '03-sales-quotes-and-customer-orders',
    chapterTitle: 'Sales Quotes & Customer Orders',
  },
  {
    prefix: '/admin/customer-profiles',
    slug: '03-sales-quotes-and-customer-orders',
    chapterTitle: 'Sales Quotes & Customer Orders',
  },
  {
    prefix: '/admin/analytics',
    slug: '01-business-overview-and-dashboard',
    chapterTitle: 'Business Overview & Executive Dashboard',
  },
  {
    prefix: '/admin/docs',
    slug: 'index',
    chapterTitle: 'Master Manual & 7-Stage Roadmap',
  },
  {
    prefix: '/admin',
    slug: '01-business-overview-and-dashboard',
    chapterTitle: 'Business Overview & Executive Dashboard',
    exact: true,
  },
  {
    prefix: '/rider',
    slug: '14-external-portals-customer-rider-vendor',
    chapterTitle: 'External Portals: Customer, Rider & Vendor',
  },
  {
    prefix: '/vendor',
    slug: '14-external-portals-customer-rider-vendor',
    chapterTitle: 'External Portals: Customer, Rider & Vendor',
  },
];

export interface ContextualDocMatch {
  readonly slug: string;
  readonly chapterTitle: string;
  readonly href: string;
}

/**
 * Resolves an active browser pathname to its contextual manual chapter.
 * Falls back to the master roadmap/index if no specific module match is found.
 */
export function resolveContextualDoc(pathname: string): ContextualDocMatch {
  const normalized =
    pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;

  for (const rule of ROUTE_RULES) {
    const matches =
      rule.exact === true
        ? normalized === rule.prefix
        : normalized === rule.prefix || normalized.startsWith(`${rule.prefix}/`);
    if (matches) {
      return {
        slug: rule.slug,
        chapterTitle: rule.chapterTitle,
        href: `/admin/docs/${rule.slug}`,
      };
    }
  }

  return {
    slug: 'index',
    chapterTitle: 'Master Manual & 7-Stage Roadmap',
    href: '/admin/docs',
  };
}
