export type {
  CompanyUiConfig,
  CompanyUiConfigRaw,
  ProductGridDesktopColumns,
} from './types';
export { PRODUCT_GRID_DESKTOP_COLUMNS } from './types';
export { DEFAULT_COMPANY_UI_CONFIG } from './defaults';
export {
  resolveCompanyUiConfig,
  sanitizeModuleLabels,
  toCompanyUiConfigRaw,
} from './resolve';
export { productGridClassName } from './product-grid';
export {
  buildCompanyThemeCssVars,
  companyThemeStyleAttribute,
  lightenHex,
  normalizeHexColor,
  type CompanyThemeColors,
  type CompanyThemeCssVars,
} from './theme';
export {
  applyModuleLabels,
  flattenModuleLabelOptions,
  type ModuleLabelOption,
} from './module-labels';
