import { DEFAULT_COMPANY_UI_CONFIG } from './defaults';
import {
  PRODUCT_GRID_DESKTOP_COLUMNS,
  type CompanyUiConfig,
  type CompanyUiConfigRaw,
  type ProductGridDesktopColumns,
} from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDesktopColumns(value: unknown): ProductGridDesktopColumns {
  const n = typeof value === 'number' ? value : Number(value);
  if ((PRODUCT_GRID_DESKTOP_COLUMNS as readonly number[]).includes(n)) {
    return n as ProductGridDesktopColumns;
  }
  return DEFAULT_COMPANY_UI_CONFIG.productGrid.desktopColumns;
}

/**
 * Normalize module label map: only keep non-empty string values.
 * Fault-tolerant — drops bad entries instead of failing.
 */
export function sanitizeModuleLabels(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    // Cap length so a bad paste cannot blow up the sidebar.
    out[key.trim()] = trimmed.slice(0, 80);
  }
  return out;
}

/**
 * Resolve raw DB JSON into a complete, validated CompanyUiConfig.
 * Never throws — corrupt or partial payloads fall back to defaults per-field.
 */
export function resolveCompanyUiConfig(raw: unknown): CompanyUiConfig {
  const source: CompanyUiConfigRaw = isPlainObject(raw) ? (raw as CompanyUiConfigRaw) : {};

  const productGridRaw = isPlainObject(source.productGrid) ? source.productGrid : {};

  return {
    productGrid: {
      desktopColumns: parseDesktopColumns(productGridRaw.desktopColumns),
    },
    moduleLabels: sanitizeModuleLabels(source.moduleLabels),
  };
}

/** Serialize a resolved config for persistence (stable shape). */
export function toCompanyUiConfigRaw(config: CompanyUiConfig): CompanyUiConfigRaw {
  return {
    productGrid: {
      desktopColumns: config.productGrid.desktopColumns,
    },
    moduleLabels: { ...config.moduleLabels },
  };
}
