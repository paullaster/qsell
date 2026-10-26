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

/** A page of the shop's policies (privacy, delivery, returns...), written by the company in plain text. */
export interface PolicyPage {
  id: string;
  /** The page's address: /policies/<slug>. */
  slug: string;
  title: string;
  /** Plain text: blank lines separate paragraphs, "# " starts a heading, "- " starts a list item. */
  body: string;
}

export const POLICY_LIMITS = { pages: 12, title: 80, slug: 60, body: 20000 } as const;

/** A notice shown across the top of the shop's front page for a stretch of days (a sale, a holiday closing...). */
export interface PromoBanner {
  id: string;
  title: string;
  text: string;
  /** Where the button goes: a page of the shop ("/?category=…") or an http(s) address. Empty for no button. */
  href: string;
  /** The button's words. */
  cta: string;
  /** First day shown, `YYYY-MM-DD`; empty for from now. */
  startsOn: string;
  /** Last day shown, `YYYY-MM-DD`; empty for until removed. */
  endsOn: string;
  active: boolean;
}

export const BANNER_LIMITS = { banners: 5, title: 80, text: 240, cta: 30, href: 500 } as const;

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
  /** Policy pages shown under /policies and linked from the footer. */
  policies?: Partial<PolicyPage>[];
  /** Front-page notices; see {@link PromoBanner}. */
  banners?: Partial<PromoBanner>[];
};

/** Fully resolved UI config — safe to consume anywhere without null checks. */
export type CompanyUiConfig = {
  productGrid: {
    desktopColumns: ProductGridDesktopColumns;
  };
  moduleLabels: Record<string, string>;
  support: CompanySupportConfig;
  policies: PolicyPage[];
  banners: PromoBanner[];
};

export const PRODUCT_GRID_DESKTOP_COLUMNS = [
  2, 3, 4,
] as const satisfies readonly ProductGridDesktopColumns[];
