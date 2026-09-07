import type { CompanyUiConfig } from './types';

/**
 * Safe defaults — used when DB is empty, JSON is corrupt, or keys are missing.
 * Changing a default here updates every tenant that has not overridden that key.
 */
export const DEFAULT_COMPANY_UI_CONFIG: CompanyUiConfig = {
  productGrid: {
    desktopColumns: 4,
  },
  moduleLabels: {},
};
