/** Allowed product-grid density at the ~1140px desktop band. */
export type ProductGridDesktopColumns = 2 | 3 | 4;

/**
 * Raw / partial UI config as stored in DB (JSONB).
 * All fields optional — missing or invalid values resolve to defaults.
 */
export type CompanyUiConfigRaw = {
  productGrid?: {
    /** Columns at ~1140px. Smaller viewports scale down from this. Default: 4 */
    desktopColumns?: number;
  };
  /**
   * Optional display-name overrides keyed by admin nav item `id`.
   * Unknown keys are ignored; empty/whitespace values fall back to the built-in title.
   */
  moduleLabels?: Record<string, string>;
};

/** Fully resolved UI config — safe to consume anywhere without null checks. */
export type CompanyUiConfig = {
  productGrid: {
    desktopColumns: ProductGridDesktopColumns;
  };
  moduleLabels: Record<string, string>;
};

export const PRODUCT_GRID_DESKTOP_COLUMNS = [2, 3, 4] as const satisfies readonly ProductGridDesktopColumns[];
