/** Allowed product-grid density at the ~1140px desktop band. */
export type ProductGridDesktopColumns = 2 | 3 | 4;

export const SUPPORT_CHANNEL_KINDS = [
  'phone',
  'whatsapp',
  'sms',
  'email',
  'location',
  'website',
  'telegram',
  'other',
] as const;
export type SupportChannelKind = (typeof SUPPORT_CHANNEL_KINDS)[number];

/** One way customers can reach the company. Entirely admin-defined. */
export type SupportChannel = {
  id: string;
  kind: SupportChannelKind;
  /** Heading shown to customers, e.g. "Phone & WhatsApp", "Nairobi hub". */
  label: string;
  /** Phone number, email address, street address, handle or URL depending on kind. */
  value: string;
  /** Optional secondary line, e.g. opening hours. */
  detail: string;
  /** Optional http(s) link (e.g. a map pin) for location/website/other channels. */
  url: string;
};

export type SupportGuarantee = { id: string; text: string };
export type SupportFaq = { id: string; question: string; answer: string };

/** Storefront help & support content. Every list starts empty — nothing is pre-filled. */
export type CompanySupportConfig = {
  /** Display name of the whole section (modal title, footer heading, menu entries). */
  name: string;
  subtitle: string;
  channels: SupportChannel[];
  guaranteesTitle: string;
  guarantees: SupportGuarantee[];
  faqsTitle: string;
  faqs: SupportFaq[];
};

export const SUPPORT_LIMITS = {
  name: 60,
  subtitle: 140,
  title: 60,
  channels: 12,
  guarantees: 12,
  faqs: 50,
  label: 60,
  value: 200,
  detail: 100,
  url: 500,
  guarantee: 200,
  question: 200,
  answer: 2000,
} as const;

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
  /** Storefront help & support content; see {@link CompanySupportConfig}. */
  support?: Partial<CompanySupportConfig>;
};

/** Fully resolved UI config — safe to consume anywhere without null checks. */
export type CompanyUiConfig = {
  productGrid: {
    desktopColumns: ProductGridDesktopColumns;
  };
  moduleLabels: Record<string, string>;
  support: CompanySupportConfig;
};

export const PRODUCT_GRID_DESKTOP_COLUMNS = [
  2, 3, 4,
] as const satisfies readonly ProductGridDesktopColumns[];
