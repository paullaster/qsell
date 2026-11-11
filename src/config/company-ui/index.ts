export type { CompanyUiConfig, CompanyUiConfigRaw, PolicyPage, PromoBanner, ProductGridDesktopColumns } from './types';
export {
  BANNER_LIMITS,
  BANNER_MOTIONS,
  BANNER_SIZES,
  BANNER_SPEEDS,
  type BannerMotion,
  type BannerSize,
  type BannerSpeed,
  POLICY_LIMITS,
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
export { activeBanners, resolveBanners, safeBannerImage } from './banners';
export { bannerColor, contrastRatio, isReadable, MIN_BANNER_CONTRAST, readableTextOn, textColorFor } from './banner-colors';
export { parsePolicyBody, policyAddress, policySlug, resolvePolicies, type PolicyBlock } from './policies';
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
