import type { CompanySupportConfig, CompanyUiConfig } from './types';

/** Section names are the only defaults; channels, guarantees and FAQs are always admin-defined. */
export const DEFAULT_COMPANY_SUPPORT_CONFIG: CompanySupportConfig = {
  name: 'Help & Support',
  subtitle: '',
  channels: [],
  guaranteesTitle: 'Our Customer Guarantees',
  guarantees: [],
  faqsTitle: 'Frequently Asked Questions',
  faqs: [],
};

/**
 * Safe defaults — used when DB is empty, JSON is corrupt, or keys are missing.
 * Changing a default here updates every tenant that has not overridden that key.
 */
export const DEFAULT_COMPANY_UI_CONFIG: CompanyUiConfig = {
  productGrid: {
    desktopColumns: 4,
  },
  moduleLabels: {},
  support: DEFAULT_COMPANY_SUPPORT_CONFIG,
  policies: [],
  banners: [],
};
