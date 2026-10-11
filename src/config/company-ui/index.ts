export type { CompanyUiConfig, CompanyUiConfigRaw, ProductGridDesktopColumns } from './types';
export {
  PRODUCT_GRID_DESKTOP_COLUMNS,
  SUPPORT_CHANNEL_KINDS,
  SUPPORT_LIMITS,
  type CompanySupportConfig,
  type SupportChannel,
  type SupportChannelKind,
  type SupportFaq,
  type SupportGuarantee,
} from './types';
export { DEFAULT_COMPANY_SUPPORT_CONFIG } from './defaults';
export { hasSupportContent, resolveSupportConfig, supportChannelHref } from './support';
export { DEFAULT_COMPANY_UI_CONFIG } from './defaults';
export { resolveCompanyUiConfig, sanitizeModuleLabels, toCompanyUiConfigRaw } from './resolve';
export { productGridClassName } from './product-grid';
export {
  buildCompanyThemeCssVars,
  companyThemeStyleAttribute,
  darkenHex,
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
