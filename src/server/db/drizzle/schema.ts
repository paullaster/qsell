import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  jsonb,
  bigint,
  numeric,
  date,
  smallint,
  uniqueIndex,
  index,
  check,
  primaryKey,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { CompanyUiConfigRaw } from '@/config/company-ui';
import type { MediaVisibility, StoredMediaProvider } from '@/server/ports/media';
import type {
  PaymentProviderCode,
  StoredProviderCode,
  PaymentProviderEnvironment,
  PaymentAttemptStatus,
  EncryptedCredentialsBlob,
} from '@/server/domains/payments/types';
import type {
  KraDocumentStatus,
  ModuleSigning,
  LoggedDocumentType,
  SigningModule,
  SigningOutcome,
  SigningReason,
} from '@/server/domains/kra/signing/types';
import type {
  FloorEnforcement,
  FloorScopeType,
  PriceListKind,
  PriceListStatus,
  PriceTrace,
  QuantityMode,
  Scopes,
  Tier,
} from '@/server/domains/pricing/domain/types';
import type { MixConfig } from '@/server/domains/pricing/domain/mix';
import type { KitAllocation } from '@/server/domains/pricing/domain/kits';
import type {
  DiscountConditions,
  DiscountKind,
  DiscountLimits,
  DiscountReward,
  DiscountSchedule,
  DiscountStatus,
  DiscountTarget,
  Stacking,
} from '@/server/domains/pricing/domain/discounts';
import type { RebateTier } from '@/server/domains/pricing/domain/rebate';
import type { LoyaltyTier } from '@/server/domains/pricing/domain/loyalty';
import type { EtimsItemStatus } from '@/server/domains/kra/etims/item-types';
import type {
  KraConfigSource,
  KraEnvironment,
  KraMode,
  KraTransmissionStatus,
} from '@/server/domains/kra/types';

/**
 * A quantity of goods: up to three decimals (a unit of measure allows 0 to 3), read back as a JS number.
 * Sums and differences are done by the database in exact decimals; code that adds in JS rounds with `roundQty`.
 */
const quantity = (name: string) => numeric(name, { precision: 14, scale: 3, mode: 'number' });

/** Top-level tenant. */
/** Raw bytes (files kept in the database). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const organizations = pgTable('organizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Company profile used on invoices / receipts / emails.
 * Linked to an organization; branches hang off the company.
 */
export const companySettings = pgTable('company_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'set null',
  }),
  legalName: text('legal_name').notNull(),
  tradingName: text('trading_name').notNull(),
  email: text('email').notNull(),
  phone: text('phone').notNull(),
  tel: text('tel'),
  website: text('website'),
  streetAddress: text('street_address').notNull(),
  city: text('city').notNull(),
  countyOrState: text('county_or_state').notNull(),
  postalCode: text('postal_code').notNull(),
  country: text('country').notNull().default('Kenya'),
  locationLabel: text('location_label'),
  tagline: text('tagline'),
  kraPin: text('kra_pin').notNull(),
  vatNumber: text('vat_number'),
  registrationNumber: text('registration_number'),
  bankName: text('bank_name'),
  bankAccountName: text('bank_account_name'),
  bankAccountNumber: text('bank_account_number'),
  bankBranch: text('bank_branch'),
  invoiceFooterNote: text('invoice_footer_note'),
  invoicePrefix: text('invoice_prefix').notNull().default('INV'),
  logoUrl: text('logo_url'),
  primaryColor: text('primary_color').notNull().default('#111827'),
  accentColor: text('accent_color').notNull().default('#4F46E5'),
  /** Absolute public base URL used to build payment callback URLs (no trailing slash). */
  publicBaseUrl: text('public_base_url'),
  /**
   * Extensible storefront/admin UI behaviour (grid density, module labels, …).
   * Validated at read-time via resolveCompanyUiConfig — never trust raw JSON.
   */
  uiConfig: jsonb('ui_config').$type<CompanyUiConfigRaw>().notNull().default({}),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Operating unit under a company. May act independently for tax / banking / paybills.
 */
export const branches = pgTable(
  'branches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    streetAddress: text('street_address'),
    city: text('city'),
    countyOrState: text('county_or_state'),
    postalCode: text('postal_code'),
    country: text('country').default('Kenya'),
    kraPin: text('kra_pin'),
    vatNumber: text('vat_number'),
    registrationNumber: text('registration_number'),
    bankName: text('bank_name'),
    bankAccountName: text('bank_account_name'),
    bankAccountNumber: text('bank_account_number'),
    bankBranch: text('bank_branch'),
    /** When true, branch uses its own KRA / paybill / bank configs for payments & invoices. */
    actsIndependently: boolean('acts_independently').notNull().default(false),
    publicBaseUrl: text('public_base_url'),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('branches_company_code_uidx').on(t.companyId, t.code),
    index('branches_company_idx').on(t.companyId),
  ],
);

/**
 * Per-branch payment provider configuration. Credentials are encrypted JSON blobs —
 * never read provider secrets from process.env.
 */
export const paymentProviderConfigs = pgTable(
  'payment_provider_configs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /**
     * Only for the older way of working: before payment methods are set up for a branch, the
     * storefront still finds the provider that was configured for it. A provider belongs to the
     * company; the branch is chosen on each payment method.
     */
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    providerCode: text('provider_code').$type<StoredProviderCode>().notNull(),
    /** The built-in "Manual" provider: no outside service, cannot be deleted. */
    isSystem: boolean('is_system').notNull().default(false),
    displayName: text('display_name').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(false),
    environment: text('environment')
      .$type<PaymentProviderEnvironment>()
      .notNull()
      .default('staging'),
    /** Provider API base URL for this environment (stored in DB, not env). */
    apiBaseUrl: text('api_base_url').notNull(),
    credentialsEncrypted: jsonb('credentials_encrypted').$type<EncryptedCredentialsBlob | null>(),
    /** Non-secret provider settings (timeouts, till type flags, etc.). */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    /** The last "Test connection" and what it said. */
    lastTestAt: timestamp('last_test_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastTestMessage: text('last_test_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_provider_configs_company_name_uidx').on(t.companyId, sql`lower(${t.displayName})`),
    index('payment_provider_configs_company_idx').on(t.companyId),
    index('payment_provider_configs_branch_idx').on(t.branchId),
  ],
);

/**
 * KRA tax-invoicing mode for the whole company. Used for every branch that does NOT
 * act independently. Kept in its own table so branch lookups can never touch it.
 */
export const companyKraConfigs = pgTable(
  'company_kra_configs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<KraMode>().notNull(),
    isEnabled: boolean('is_enabled').notNull().default(false),
    environment: text('environment').$type<KraEnvironment>().notNull().default('sandbox'),
    /** eTIMS gateway base URL (stored in DB, not env). Unused for TIMS. */
    apiBaseUrl: text('api_base_url'),
    credentialsEncrypted: jsonb('credentials_encrypted').$type<EncryptedCredentialsBlob | null>(),
    /** Non-secret mode settings (TIMS: ZFPLabServer URL, connection, CU serial). */
    /** Explicit permission to sign invoices when this scope's mode is eTIMS. Off until chosen. */
    allowEtimsSigning: boolean('allow_etims_signing').notNull().default(false),
    /** Explicit permission to sign invoices when this scope's mode is TIMS. Off until chosen. */
    allowTimsSigning: boolean('allow_tims_signing').notNull().default(false),
    /**
     * Per-module signing switches. Company: a missing module is off. Branch: a missing module
     * is not set here and inherits the company's value.
     */
    moduleSigning: jsonb('module_signing').$type<ModuleSigning>().notNull().default({}),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('company_kra_configs_company_uidx').on(t.companyId)],
);

/**
 * KRA tax-invoicing mode for one branch. Read ONLY when branches.acts_independently
 * is true; it never falls back to the company row.
 */
export const branchKraConfigs = pgTable(
  'branch_kra_configs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<KraMode>().notNull(),
    isEnabled: boolean('is_enabled').notNull().default(false),
    environment: text('environment').$type<KraEnvironment>().notNull().default('sandbox'),
    apiBaseUrl: text('api_base_url'),
    credentialsEncrypted: jsonb('credentials_encrypted').$type<EncryptedCredentialsBlob | null>(),
    /** Explicit permission to sign invoices when this scope's mode is eTIMS. Off until chosen. */
    allowEtimsSigning: boolean('allow_etims_signing').notNull().default(false),
    /** Explicit permission to sign invoices when this scope's mode is TIMS. Off until chosen. */
    allowTimsSigning: boolean('allow_tims_signing').notNull().default(false),
    /**
     * Per-module signing switches. Company: a missing module is off. Branch: a missing module
     * is not set here and inherits the company's value.
     */
    moduleSigning: jsonb('module_signing').$type<ModuleSigning>().notNull().default({}),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('branch_kra_configs_branch_uidx').on(t.branchId)],
);

/** One row per invoice sent (or attempted) to KRA. trader_invoice_no makes retries idempotent. */
export const kraTransmissions = pgTable(
  'kra_transmissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: text('order_id'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    /** Which config row was used — recorded for audit. */
    configSource: text('config_source').$type<KraConfigSource>().notNull(),
    mode: text('mode').$type<KraMode>().notNull(),
    traderInvoiceNo: text('trader_invoice_no').notNull(),
    status: text('status').$type<KraTransmissionStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    response: jsonb('response').$type<Record<string, unknown> | null>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    scuReceiptNo: text('scu_receipt_no'),
    verificationUrl: text('verification_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('kra_transmissions_trader_invoice_uidx').on(t.traderInvoiceNo),
    index('kra_transmissions_status_idx').on(t.status),
  ],
);

/**
 * A product registered with KRA eTIMS, in exactly one scope — the same split as the KRA
 * mode configuration:
 *  - scope 'company': branch_id is null. Used by every branch that does NOT act independently.
 *  - scope 'branch':  branch_id is set. Used only by that independently-acting branch.
 * The two never mix: an invoice reads the scope its branch resolves to, nothing else.
 */
export const etimsItems = pgTable(
  'etims_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'restrict' }),
    /** Which configuration source owns this item. Column keeps its original name. */
    scope: text('config_source').$type<KraConfigSource>().notNull(),
    /** Null for company-scope items. */
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    /** KRA-issued code. Null until KRA confirms it (pending, failed, unconfirmed). */
    kraItemCode: text('kra_item_code'),
    status: text('status').$type<EtimsItemStatus>().notNull().default('pending'),
    name: text('name').notNull(),
    orgCountryCode: text('org_country_code').notNull().default('KE'),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull().default('0'),
    itemTypeCode: text('item_type_code').notNull(),
    taxCode: text('tax_code').notNull(),
    qtyUnitCode: text('qty_unit_code').notNull(),
    pkgUnitCode: text('pkg_unit_code').notNull(),
    itemClassCode: text('item_class_code').notNull(),
    /** Last quantity we told KRA about. */
    stockQuantity: quantity('stock_quantity').notNull().default(0),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'etims_items_scope_branch_chk',
      sql`(${t.scope} = 'company' and ${t.branchId} is null) or (${t.scope} = 'branch' and ${t.branchId} is not null)`,
    ),
    // A deleted registration frees the product to be registered again in that scope.
    uniqueIndex('etims_items_company_product_uidx')
      .on(t.companyId, t.productId)
      .where(sql`${t.scope} = 'company' and ${t.status} <> 'deleted'`),
    uniqueIndex('etims_items_branch_product_uidx')
      .on(t.branchId, t.productId)
      .where(sql`${t.scope} = 'branch' and ${t.status} <> 'deleted'`),
    uniqueIndex('etims_items_company_code_uidx')
      .on(t.companyId, t.kraItemCode)
      .where(
        sql`${t.scope} = 'company' and ${t.kraItemCode} is not null and ${t.status} <> 'deleted'`,
      ),
    uniqueIndex('etims_items_branch_code_uidx')
      .on(t.branchId, t.kraItemCode)
      .where(
        sql`${t.scope} = 'branch' and ${t.kraItemCode} is not null and ${t.status} <> 'deleted'`,
      ),
    index('etims_items_branch_idx').on(t.branchId),
  ],
);

/**
 * Append-only log of what happened to a document on its way to KRA: the signing decision
 * (every gate, the value it read and where that value came from) and, when a signing was
 * attempted, its result. Reading a document's rows in order gives its whole flow, and
 * `payload` keeps the settings that were in force at the time even if they change later.
 */
export const kraSigningEvents = pgTable(
  'kra_signing_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    /** Identifies the document across events, e.g. "order:ord_123:tax_invoice". */
    documentKey: text('document_key').notNull(),
    documentType: text('document_type').$type<LoggedDocumentType>().notNull(),
    /** The source record (e.g. the order id) and a human reference (e.g. the order number). */
    documentId: text('document_id').notNull(),
    documentRef: text('document_ref'),
    module: text('module').$type<SigningModule>().notNull(),
    eventType: text('event_type').$type<'decision' | 'transmission'>().notNull(),
    outcome: text('outcome').$type<SigningOutcome>().notNull(),
    reason: text('reason').$type<SigningReason>().notNull(),
    scope: text('scope').$type<KraConfigSource>(),
    mode: text('mode').$type<KraMode>(),
    /** Gate-by-gate trace for decisions; request/response summary for transmissions. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    transmissionId: uuid('transmission_id').references(() => kraTransmissions.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kra_signing_events_document_idx').on(t.documentKey, t.createdAt),
    index('kra_signing_events_created_idx').on(t.createdAt),
    index('kra_signing_events_outcome_idx').on(t.outcome),
  ],
);

/**
 * A credit note against one tax invoice, from any module. The signing columns mirror what the
 * signing service decided; nothing else writes `kra_status`.
 */
export const creditNotes = pgTable(
  'credit_notes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** The branch the original invoice was issued from. */
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    module: text('module').$type<SigningModule>().notNull(),
    /** The record the credit note belongs to (e.g. the order) and a human reference for it. */
    sourceKind: text('source_kind').notNull(),
    sourceId: text('source_id').notNull(),
    sourceRef: text('source_ref').notNull(),
    creditNoteNo: text('credit_note_no').notNull(),
    /** Signing-log key of the tax invoice being credited, e.g. "order:ord_1:tax_invoice". */
    originalDocumentKey: text('original_document_key').notNull(),
    reasonCode: text('reason_code').notNull(),
    reasonNote: text('reason_note'),
    currency: text('currency').notNull(),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    kraStatus: text('kra_status')
      .$type<KraDocumentStatus | 'pending'>()
      .notNull()
      .default('pending'),
    issuedBy: text('issued_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_notes_no_uidx').on(t.creditNoteNo),
    index('credit_notes_original_idx').on(t.originalDocumentKey),
    index('credit_notes_source_idx').on(t.sourceKind, t.sourceId),
  ],
);

export const creditNoteLines = pgTable(
  'credit_note_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    creditNoteId: uuid('credit_note_id')
      .notNull()
      .references(() => creditNotes.id, { onDelete: 'cascade' }),
    productId: text('product_id').notNull(),
    description: text('description').notNull(),
    quantity: quantity('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /**
     * The unit the goods were sold in (null when sold in the base unit, or in a mix of units): `quantity`
     * is always base units, as on the order line this came from.
     */
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id, { onDelete: 'restrict' }),
    unitCode: text('unit_code'),
    /** Base units in one of that unit, as on the order when it was sold. */
    qtyPerUnit: numeric('qty_per_unit', { precision: 24, scale: 10 }),
    /** The quantity in that unit (2 crates), where `quantity` is what it comes to in base units. */
    enteredQuantity: quantity('entered_quantity'),
  },
  (t) => [
    index('credit_note_lines_cn_idx').on(t.creditNoteId),
    index('credit_note_lines_unit_idx').on(t.unitId),
  ],
);

/**
 * KERNEL — decision log. Append-only record of every decision and state change: who, what,
 * when, why (reason code + text), which policy version, and a snapshot of the inputs.
 * The migration adds a trigger that rejects UPDATE and DELETE.
 */
export const decisionLog = pgTable(
  'decision_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Ties together everything done for one user request, job or integration call. */
    correlationId: text('correlation_id').notNull(),
    /** The event or decision that directly caused this one, if any. */
    causationId: text('causation_id'),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    action: text('action').notNull(),
    actorType: text('actor_type').$type<'user' | 'system' | 'job' | 'integration'>().notNull(),
    actorId: text('actor_id'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text'),
    policyId: text('policy_id'),
    policyVersion: text('policy_version'),
    fromState: text('from_state'),
    toState: text('to_state'),
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull().default({}),
    outcome: jsonb('outcome').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('decision_log_subject_idx').on(t.subjectType, t.subjectId, t.occurredAt),
    index('decision_log_correlation_idx').on(t.correlationId),
    index('decision_log_company_time_idx').on(t.companyId, t.occurredAt),
  ],
);

/** KERNEL — controlled catalogue of reasons (Business Central "Reason Code"). */
export const reasonCodes = pgTable(
  'reason_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    description: text('description').notNull(),
    /** Actions or document kinds it may be used for; empty means anywhere. */
    appliesTo: jsonb('applies_to').$type<string[]>().notNull().default([]),
    requiresComment: boolean('requires_comment').notNull().default(false),
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reason_codes_company_code_uidx').on(t.companyId, t.code)],
);

/** KERNEL — number series (Business Central "No. Series"), see the blueprint §4.4. */
export const numberSeries = pgTable(
  'number_series',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    description: text('description').notNull(),
    /** gap_free: counter locked inside the document's transaction. allow_gaps: blocks of numbers. */
    mode: text('mode').$type<'gap_free' | 'allow_gaps'>().notNull().default('gap_free'),
    /** Numbers may be typed in by hand (and are checked for uniqueness). */
    manualAllowed: boolean('manual_allowed').notNull().default(false),
    /** Documents are numbered automatically. When false, a number must be typed in. */
    defaultNumbers: boolean('default_numbers').notNull().default(true),
    /** Reject a document dated before the last one numbered (gap-free only). */
    dateOrder: boolean('date_order').notNull().default(false),
    /** allow_gaps: how many numbers an app instance takes per trip to the database. */
    blockSize: integer('block_size').notNull().default(50),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('number_series_company_code_uidx').on(t.companyId, t.code)],
);

export const numberSeriesLines = pgTable(
  'number_series_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => numberSeries.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    /** Null: applies to every branch. A branch-scoped line wins over a general one. */
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    startsOn: text('starts_on').notNull(),
    endsOn: text('ends_on'),
    /** Tokens: {YYYY} {YY} {MM} {BRANCH}. */
    prefix: text('prefix').notNull().default(''),
    suffix: text('suffix').notNull().default(''),
    digits: integer('digits').notNull().default(6),
    startNo: bigint('start_no', { mode: 'number' }).notNull().default(1),
    endNo: bigint('end_no', { mode: 'number' }),
    increment: integer('increment').notNull().default(1),
    warnAt: bigint('warn_at', { mode: 'number' }),
    /** never | yearly | monthly: when the counter restarts at start_no. */
    reset: text('reset').$type<'never' | 'yearly' | 'monthly'>().notNull().default('never'),
    isOpen: boolean('is_open').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('number_series_lines_series_no_uidx').on(t.seriesId, t.lineNo),
    index('number_series_lines_series_idx').on(t.seriesId),
  ],
);

/** One counter per (line, period): the row that is locked (gap-free) or reserved in blocks. */
export const numberSeriesCounters = pgTable(
  'number_series_counters',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    lineId: uuid('line_id')
      .notNull()
      .references(() => numberSeriesLines.id, { onDelete: 'cascade' }),
    /** '' for reset=never, 'YYYY' for yearly, 'YYYY-MM' for monthly. */
    periodKey: text('period_key').notNull().default(''),
    /** Last sequence number issued (or, for allow_gaps, the end of the last block reserved). */
    lastNo: bigint('last_no', { mode: 'number' }),
    lastDate: text('last_date'),
    warned: boolean('warned').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('number_series_counters_line_period_uidx').on(t.lineId, t.periodKey)],
);

/**
 * Every number ever issued. The unique (series, number) constraint is what makes a duplicate
 * number impossible, whatever else goes wrong. Append-only (trigger in the migration).
 */
export const numberSeriesAllocations = pgTable(
  'number_series_allocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => numberSeries.id, { onDelete: 'restrict' }),
    lineId: uuid('line_id').references(() => numberSeriesLines.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    sequence: bigint('sequence', { mode: 'number' }),
    periodKey: text('period_key').notNull().default(''),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    documentKind: text('document_kind'),
    documentId: text('document_id'),
    source: text('source').$type<'auto' | 'manual'>().notNull().default('auto'),
    documentDate: text('document_date').notNull(),
    allocatedBy: text('allocated_by'),
    allocatedAt: timestamp('allocated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('number_series_alloc_number_uidx').on(t.seriesId, t.number),
    // One document gets one number: asking again returns the same one.
    uniqueIndex('number_series_alloc_document_uidx')
      .on(t.companyId, t.documentKind, t.documentId)
      .where(sql`${t.documentKind} is not null and ${t.documentId} is not null`),
    index('number_series_alloc_time_idx').on(t.seriesId, t.allocatedAt),
  ],
);

/** Which series numbers which document kind, with an optional per-branch override. */
export const numberSeriesBindings = pgTable(
  'number_series_bindings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    documentKind: text('document_kind').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => numberSeries.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('number_series_bind_default_uidx')
      .on(t.companyId, t.documentKind)
      .where(sql`${t.branchId} is null`),
    uniqueIndex('number_series_bind_branch_uidx')
      .on(t.companyId, t.documentKind, t.branchId)
      .where(sql`${t.branchId} is not null`),
  ],
);

/** Alternatives a document may offer in place of its default series (BC "No. Series Relationship"). */
export const numberSeriesRelationships = pgTable(
  'number_series_relationships',
  {
    seriesId: uuid('series_id')
      .notNull()
      .references(() => numberSeries.id, { onDelete: 'cascade' }),
    relatedSeriesId: uuid('related_series_id')
      .notNull()
      .references(() => numberSeries.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.relatedSeriesId] })],
);

/** KERNEL — approvals. Switches: a module or trigger (optionally per branch) turned on or off. */
export const approvalSwitches = pgTable(
  'approval_switches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    module: text('module').notNull(),
    /** Null = the whole module. */
    trigger: text('trigger'),
    /** Null = every branch. */
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull(),
    changedBy: text('changed_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('approval_switches_scope_uidx').on(
      t.companyId,
      t.module,
      sql`coalesce(${t.trigger}, '')`,
      sql`coalesce(${t.branchId}::text, '')`,
    ),
  ],
);

/** One configurable approval rule for a trigger. Its steps and conditions live in versions. */
export const approvalWorkflows = pgTable(
  'approval_workflows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    module: text('module').notNull(),
    trigger: text('trigger').notNull(),
    /** Null = every branch. */
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'cascade' }),
    /** Lower runs first; only affects the order requests are created in. */
    priority: integer('priority').notNull().default(100),
    status: text('status')
      .$type<'draft' | 'enabled' | 'disabled' | 'retired'>()
      .notNull()
      .default('draft'),
    /** The work in progress, validated and frozen into a version when published. */
    draft: jsonb('draft').$type<Record<string, unknown>>().notNull().default({}),
    currentVersionId: uuid('current_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('approval_workflows_company_code_uidx').on(t.companyId, t.code),
    index('approval_workflows_trigger_idx').on(t.companyId, t.trigger, t.status),
  ],
);

/** Immutable once written: requests in flight keep the version they started under. */
export const approvalWorkflowVersions = pgTable(
  'approval_workflow_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => approvalWorkflows.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    publishedBy: text('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
  },
  (t) => [uniqueIndex('approval_workflow_versions_uidx').on(t.workflowId, t.version)],
);

/** An approver: who is above them, who covers for them, and whether they can approve at all. */
export const approverProfiles = pgTable(
  'approver_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The next link up the approval chain. */
    approverUserId: uuid('approver_user_id').references(() => users.id, { onDelete: 'set null' }),
    substituteUserId: uuid('substitute_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    substituteFrom: text('substitute_from'),
    substituteTo: text('substitute_to'),
    isActive: boolean('is_active').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('approver_profiles_user_uidx').on(t.companyId, t.userId)],
);

/** What an approver may approve, per kind of document, in the company's base currency. */
export const approverLimits = pgTable(
  'approver_limits',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => approverProfiles.id, { onDelete: 'cascade' }),
    documentKind: text('document_kind').notNull(),
    maxAmount: numeric('max_amount', { precision: 18, scale: 2 }),
    unlimited: boolean('unlimited').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.documentKind] })],
);

export const approverGroups = pgTable(
  'approver_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('approver_groups_company_code_uidx').on(t.companyId, t.code)],
);

export const approverGroupMembers = pgTable(
  'approver_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => approverGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('approver_group_members_seq_idx').on(t.groupId, t.sequence),
  ],
);

/** One approval requirement for one document, under one workflow version. */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Requests created by one submit; the document is released when all are approved. */
    submissionId: uuid('submission_id').notNull(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => approvalWorkflows.id, { onDelete: 'restrict' }),
    workflowVersionId: uuid('workflow_version_id')
      .notNull()
      .references(() => approvalWorkflowVersions.id, { onDelete: 'restrict' }),
    trigger: text('trigger').notNull(),
    documentKind: text('document_kind').notNull(),
    documentId: text('document_id').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** In the company's base currency; what approver limits are compared with. */
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull().default('0'),
    /** The document as it was submitted; also what the conditions were evaluated on. */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    documentHash: text('document_hash').notNull(),
    status: text('status')
      .$type<'pending' | 'approved' | 'rejected' | 'canceled' | 'superseded' | 'reopened'>()
      .notNull()
      .default('pending'),
    currentStep: integer('current_step').notNull(),
    previousRequestId: uuid('previous_request_id'),
    attempt: integer('attempt').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    // One live request per document and workflow: the database, not the code, forbids duplicates.
    uniqueIndex('approval_requests_one_pending_uidx')
      .on(t.companyId, t.documentKind, t.documentId, t.workflowId)
      .where(sql`${t.status} = 'pending'`),
    index('approval_requests_document_idx').on(t.documentKind, t.documentId, t.createdAt),
    index('approval_requests_submission_idx').on(t.submissionId),
    // "My requests": one person's requests, newest first, a page at a time.
    index('approval_requests_requester_idx').on(t.companyId, t.requestedBy, t.createdAt),
  ],
);

/** One approver's turn at one step. Created only when the previous approver has approved. */
export const approvalEntries = pgTable(
  'approval_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    stepSequence: integer('step_sequence').notNull(),
    /** Position inside the step: group member order, or hops up an approver chain. */
    position: integer('position').notNull().default(0),
    approverUserId: uuid('approver_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Set when a substitute covers for this person. */
    onBehalfOfUserId: uuid('on_behalf_of_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: text('status')
      .$type<'open' | 'approved' | 'rejected' | 'canceled'>()
      .notNull()
      .default('open'),
    comment: text('comment'),
    reasonCode: text('reason_code'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    /** The entry this one took over from, when it was escalated or rerouted. */
    replacesEntryId: uuid('replaces_entry_id'),
    /** Set once the overdue sweep has dealt with this entry (escalated it, or found nobody above). */
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    actedAt: timestamp('acted_at', { withTimezone: true }),
  },
  (t) => [
    // The approver's inbox.
    index('approval_entries_inbox_idx')
      .on(t.approverUserId, t.createdAt)
      .where(sql`${t.status} = 'open'`),
    index('approval_entries_request_idx').on(t.requestId, t.stepSequence, t.position),
    index('approval_entries_overdue_idx')
      .on(t.dueAt)
      .where(sql`${t.status} = 'open' and ${t.escalatedAt} is null`),
  ],
);

/**
 * An action (issue a credit note, change stock) waiting for approval. The action's inputs are kept
 * here so it can be carried out, in the approver's transaction, the moment the last approval is given.
 */
export const approvalParkedActions = pgTable(
  'approval_parked_actions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** The approval document kind this is parked under, e.g. credit_note. */
    documentKind: text('document_kind').notNull(),
    /** Which action, within that kind, e.g. order_credit_note or stock_write_off. */
    action: text('action').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** One plain sentence for the approver: what will happen if they approve. */
    summary: text('summary').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status')
      .$type<'parked' | 'applied' | 'rejected' | 'canceled'>()
      .notNull()
      .default('parked'),
    /** What carrying it out produced (a credit note id, a stock reference ...). */
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [index('approval_parked_actions_kind_idx').on(t.documentKind, t.status, t.createdAt)],
);

export const paymentAttempts = pgTable(
  'payment_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'restrict' }),
    providerConfigId: uuid('provider_config_id')
      .notNull()
      .references(() => paymentProviderConfigs.id, { onDelete: 'restrict' }),
    providerCode: text('provider_code').$type<PaymentProviderCode>().notNull(),
    orderId: text('order_id').notNull(),
    orderNumber: text('order_number').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('KES'),
    status: text('status').$type<PaymentAttemptStatus>().notNull().default('initiated'),
    /** Unique last path segment for provider callbacks (UUIDv7). */
    callbackToken: text('callback_token').notNull().unique(),
    callbackUrl: text('callback_url').notNull(),
    customerPhone: text('customer_phone'),
    customerEmail: text('customer_email'),
    providerReference: text('provider_reference'),
    externalReference: text('external_reference'),
    redirectUrl: text('redirect_url'),
    requestPayload: jsonb('request_payload').$type<Record<string, unknown>>().default({}),
    responsePayload: jsonb('response_payload').$type<Record<string, unknown>>().default({}),
    errorMessage: text('error_message'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_attempts_order_idx').on(t.orderId),
    index('payment_attempts_callback_token_idx').on(t.callbackToken),
    index('payment_attempts_branch_idx').on(t.branchId),
    index('payment_attempts_settled_idx')
      .on(t.paidAt)
      .where(sql`${t.status} = 'successful'`),
  ],
);

export const paymentCallbackEvents = pgTable(
  'payment_callback_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    paymentAttemptId: uuid('payment_attempt_id').references(() => paymentAttempts.id, {
      onDelete: 'set null',
    }),
    callbackToken: text('callback_token').notNull(),
    providerCode: text('provider_code').$type<PaymentProviderCode>().notNull(),
    httpMethod: text('http_method').notNull().default('POST'),
    headers: jsonb('headers').$type<Record<string, string>>().default({}),
    /** Raw provider payload dump — never mutated after insert. */
    rawBody: jsonb('raw_body').$type<unknown>(),
    /**
     * Exact status the provider sent in the callback payload.
     * M-Pesa / KCB: stkCallback.ResultCode ("0" is the only success).
     * Pesapal / Jenga: their status text.
     * Fallbacks that are not provider statuses: received | unmatched_token | error.
     */
    processingStatus: text('processing_status').notNull().default('received'),
    /**
     * Derived from processing_status by the callback rulebook.
     * M-Pesa: ResultCode 0 = successful, any other value = failed.
     * successful | failed | pending | unclassified
     */
    outcome: text('outcome').notNull().default('unclassified'),
    processingError: text('processing_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_callback_events_token_idx').on(t.callbackToken),
    index('payment_callback_events_attempt_idx').on(t.paymentAttemptId),
    index('payment_callback_events_outcome_idx').on(t.outcome),
  ],
);

export const invoiceDocuments = pgTable('invoice_documents', {
  id: uuid('id').defaultRandom().primaryKey(),
  orderId: text('order_id').notNull(),
  orderNumber: text('order_number').notNull(),
  invoiceNumber: text('invoice_number').notNull().unique(),
  documentType: text('document_type').notNull().default('tax_invoice'),
  customerEmail: text('customer_email').notNull(),
  customerName: text('customer_name').notNull(),
  currency: text('currency').notNull().default('KES'),
  subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull(),
  tax: numeric('tax', { precision: 14, scale: 2 }).notNull(),
  shippingFee: numeric('shipping_fee', { precision: 14, scale: 2 }).notNull(),
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
  pdfStorageKey: text('pdf_storage_key'),
  emailStatus: text('email_status').notNull().default('pending'),
  emailError: text('email_error'),
  emailedAt: timestamp('emailed_at', { withTimezone: true }),
  meta: jsonb('meta').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const communicationOutbox = pgTable('communication_outbox', {
  id: uuid('id').defaultRandom().primaryKey(),
  channel: text('channel').notNull(), // email | sms
  templateKey: text('template_key').notNull(),
  recipient: text('recipient').notNull(),
  subject: text('subject'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Auth.js / application users (credentials). */
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    title: text('title'),
    phone: text('phone'),
    avatarUrl: text('avatar_url'),
    role: text('role').notNull().default('customer'), // primary role: super_admin | admin | manager | customer
    status: text('status').notNull().default('active'), // active | suspended
    /** Per-account colour scheme: light | dark | system. Null = use the app default. */
    themeMode: text('theme_mode'),
    customerStoreId: text('customer_store_id'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    /** Bumped on every grant change so the access-control cache can invalidate eagerly. */
    permissionsVersion: integer('permissions_version').notNull().default(0),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** Null until the owner proves control of `email`; sign-in is refused while null. */
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    /** Only the provisioned super-admin has this — gates visibility of super-admin accounts to others. */
    canViewSuperAdmin: boolean('can_view_super_admin').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_uidx').on(t.email),
    index('users_role_idx').on(t.role),
    index('users_status_idx').on(t.status),
    index('users_branch_idx').on(t.branchId),
  ],
);

export type AuthTokenPurpose = 'email_verification' | 'password_reset';

/**
 * Single-use, expiring tokens mailed to users (email verification, password reset).
 * Only a SHA-256 hash is stored, so a database leak cannot be replayed.
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').$type<AuthTokenPurpose>().notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_tokens_token_hash_uidx').on(t.tokenHash),
    index('auth_tokens_user_purpose_created_idx').on(t.userId, t.purpose, t.createdAt),
    index('auth_tokens_expires_idx').on(t.expiresAt),
  ],
);

/**
 * RBAC role catalog. `key` is the stable identity referenced by users.role and user_roles;
 * admin/maintenance UIs edit descriptions and permission bindings, never the key.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Lower number = higher precedence; used to break ties between roles. */
    priority: integer('priority').notNull().default(100),
    /**
     * Back-office role: holders may sign in to /admin (their permissions still decide what they
     * can do). Off by default for custom roles; locked for super_admin (always) and customer (never).
     */
    isStaff: boolean('is_staff').notNull().default(false),
    /** When true the role cannot be deleted (rank of the permission set only). */
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('roles_key_idx').on(t.key)],
);

/** Static permission catalog mirror — seeded from the registry, edited only by code. */
export const permissions = pgTable(
  'permissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: text('key').notNull().unique(), // e.g. "orders:update"
    resource: text('resource').notNull(), // e.g. "orders"
    action: text('action').notNull(), // e.g. "update"
    category: text('category').notNull().default('General'), // UI grouping
    description: text('description').notNull().default(''),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('permissions_resource_idx').on(t.resource),
    index('permissions_category_idx').on(t.category),
  ],
);

/** Permission bindings for roles. */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    effect: text('effect').notNull().default('allow').$type<'allow' | 'deny'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('role_permissions_role_perm_uidx').on(t.roleId, t.permissionId),
    index('role_permissions_perm_idx').on(t.permissionId),
  ],
);

/** Extra role assignments per user (beyond the primary users.role), optionally branch-scoped. */
export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_roles_user_role_branch_uidx').on(t.userId, t.roleId, t.branchId),
    index('user_roles_user_idx').on(t.userId),
    index('user_roles_role_idx').on(t.roleId),
  ],
);

/** Explicit per-user permission grants/denials that override role-derived permissions. */
export const userPermissions = pgTable(
  'user_permissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    effect: text('effect').notNull().$type<'allow' | 'deny'>(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    assignedBy: uuid('assigned_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_permissions_user_perm_eff_branch_uidx').on(
      t.userId,
      t.permissionId,
      t.effect,
      t.branchId,
    ),
    index('user_permissions_user_idx').on(t.userId),
    index('user_permissions_perm_idx').on(t.permissionId),
  ],
);

/**
 * ABAC policy rules. `permissionKey` is the permission dimension, `condition` is a
 * structured expression evaluated against `user` attributes + request `ctx`.
 */
export const accessPolicies = pgTable(
  'access_policies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    permissionKey: text('permission_key').notNull(),
    description: text('description').notNull().default(''),
    resource: text('resource'),
    /** Raw JSON condition AST — validated/normalized at write time. */
    condition: jsonb('condition').$type<Record<string, unknown>>().notNull().default({}),
    effect: text('effect').notNull().default('allow').$type<'allow' | 'deny'>(),
    /** Lower number evaluates first; the first enabled matching policy wins. */
    priority: integer('priority').notNull().default(100),
    isEnabled: boolean('is_enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('access_policies_perm_idx').on(t.permissionKey)],
);

/** Immutable security audit trail for sensitive operations. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(), // users:create, role_permissions:update ...
    resource: text('resource').notNull(),
    resourceId: text('resource_id'),
    /** before/after snapshots and other contextual detail. */
    detail: jsonb('detail').$type<Record<string, unknown> | null>(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorUserId),
    index('audit_logs_resource_idx').on(t.resource, t.resourceId),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    orderNumber: text('order_number').notNull(),
    userId: text('user_id'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    customerName: text('customer_name').notNull(),
    customerEmail: text('customer_email').notNull(),
    customerPhone: text('customer_phone').notNull(),
    shippingAddress: jsonb('shipping_address')
      .$type<{
        street: string;
        city: string;
        countyOrState: string;
        postalCode?: string;
        country: string;
      }>()
      .notNull(),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull(),
    tax: numeric('tax', { precision: 14, scale: 2 }).notNull(),
    shippingFee: numeric('shipping_fee', { precision: 14, scale: 2 }).notNull(),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('KES'),
    status: text('status').notNull().default('pending'),
    paymentStatus: text('payment_status').notNull().default('unpaid'),
    /** What the customer chose, as the provider/legacy code (kept; reports and rules read it). */
    paymentMethod: text('payment_method').notNull(),
    /** The finance payment method this stands for (filled by a backfill and on new orders). */
    paymentMethodId: uuid('payment_method_id'),
    shippingCourier: text('shipping_courier'),
    trackingNumber: text('tracking_number'),
    internalNotes: text('internal_notes'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    transactionReference: text('transaction_reference'),
    mpesaReceiptNumber: text('mpesa_receipt_number'),
    pesapalTrackingId: text('pesapal_tracking_id'),
    dimensionSetId: uuid('dimension_set_id').references((): AnyPgColumn => dimensionSets.id, {
      onDelete: 'set null',
    }),
    dimensionCodes: jsonb('dimension_codes')
      .$type<{ global: Record<string, string>; shortcut: Record<string, string> }>()
      .notNull()
      .default({ global: {}, shortcut: {} }),
    tradeCustomerId: uuid('trade_customer_id').references((): AnyPgColumn => customers.id, {
      onDelete: 'set null',
    }),
    customerAccountType: text('customer_account_type'),
    /** Which invoicing module the sale belongs to; decides which signing switch applies. */
    salesModule: text('sales_module').$type<SigningModule>().notNull().default('ecommerce'),
    /** 'none' until approvals apply; 'pending'/'rejected'/'draft' block the order from moving on. */
    approvalStatus: text('approval_status')
      .$type<'none' | 'pending' | 'approved' | 'rejected' | 'draft'>()
      .notNull()
      .default('none'),
    /** The discounts applied to this order (rules, coupons, amounts), as recorded when it was priced. */
    discounts: jsonb('discounts').$type<Record<string, unknown>>(),
    /** Paid with gift cards or loyalty points rather than through a payment gateway. */
    tenderedAmount: numeric('tendered_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    transmitInvoicesToKra: boolean('transmit_invoices_to_kra').notNull().default(true),
    kraTransmissionStatus: text('kra_transmission_status').notNull().default('not_applicable'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_order_number_uidx').on(t.orderNumber),
    index('orders_customer_email_idx').on(t.customerEmail),
    index('orders_status_idx').on(t.status),
    index('orders_created_at_idx').on(t.createdAt),
    index('orders_branch_created_idx').on(t.branchId, t.createdAt),
    index('orders_payment_attention_idx')
      .on(t.branchId)
      .where(sql`${t.paymentStatus} in ('pending_verification', 'discrepancy')`),
    index('orders_dimension_set_idx').on(t.dimensionSetId),
    index('orders_trade_customer_idx').on(t.tradeCustomerId),
    index('orders_user_created_idx').on(t.userId, t.createdAt),
  ],
);

/**
 * Reusable customer configuration (BC customer template).
 * Cash and credit are both first-class. KRA transmission is chosen here and can be overridden per customer.
 */
export const customerProfiles = pgTable(
  'customer_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    accountType: text('account_type').notNull(),
    creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }).notNull().default('0'),
    paymentTermDays: integer('payment_term_days').notNull().default(0),
    transmitInvoicesToKra: boolean('transmit_invoices_to_kra').notNull().default(true),
    dimensionCodes: jsonb('dimension_codes')
      .$type<{ global: Record<string, string>; shortcut: Record<string, string> }>()
      .notNull()
      .default({ global: {}, shortcut: {} }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_profiles_company_code_uidx').on(t.companyId, t.code),
    index('customer_profiles_company_idx').on(t.companyId),
  ],
);

/** Sell-to customer card. Account type is required at creation — cash or credit. */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').references(() => customerProfiles.id, {
      onDelete: 'set null',
    }),
    number: text('number').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    street: text('street'),
    city: text('city'),
    countyOrState: text('county_or_state'),
    postalCode: text('postal_code'),
    country: text('country'),
    accountType: text('account_type').notNull(),
    creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }).notNull().default('0'),
    paymentTermDays: integer('payment_term_days').notNull().default(0),
    /** none | ship | invoice | all */
    blocked: text('blocked').notNull().default('none'),
    transmitInvoicesToKra: boolean('transmit_invoices_to_kra').notNull().default(true),
    buyerKraPin: text('buyer_kra_pin'),
    dimensionSetId: uuid('dimension_set_id').references(() => dimensionSets.id, {
      onDelete: 'set null',
    }),
    dimensionCodes: jsonb('dimension_codes')
      .$type<{ global: Record<string, string>; shortcut: Record<string, string> }>()
      .notNull()
      .default({ global: {}, shortcut: {} }),
    /** Customer posting group code (which receivables / deposits accounts); null = the default. */
    postingGroupCode: text('posting_group_code'),
    /** Open receivable. Cash customers stay at 0. */
    balance: numeric('balance', { precision: 14, scale: 2 }).notNull().default('0'),
    isActive: boolean('is_active').notNull().default(true),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customers_company_number_uidx').on(t.companyId, t.number),
    index('customers_company_idx').on(t.companyId),
    index('customers_company_email_idx').on(t.companyId, t.email),
    index('customers_profile_idx').on(t.profileId),
  ],
);

/**
 * Delivery / bill-to addresses for a trade customer.
 * Exactly one row per customer may have isDefault = true (partial unique index).
 * Customer card street/city/… fields are a denormalized mirror of the default address.
 */
export const customerAddresses = pgTable(
  'customer_addresses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    recipientName: text('recipient_name').notNull(),
    recipientPhone: text('recipient_phone').notNull(),
    street: text('street').notNull(),
    city: text('city').notNull(),
    countyOrState: text('county_or_state').notNull(),
    postalCode: text('postal_code'),
    country: text('country').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('customer_addresses_customer_idx').on(t.customerId),
    uniqueIndex('customer_addresses_one_default_uidx')
      .on(t.customerId)
      .where(sql`${t.isDefault} = true`),
  ],
);

/** Posted customer ledger: invoices increase what a credit customer owes; payments apply to the oldest open invoice. */
export const customerLedgerEntries = pgTable(
  'customer_ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    orderId: text('order_id'),
    documentType: text('document_type').notNull(),
    documentNo: text('document_no').notNull(),
    description: text('description'),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    remainingAmount: numeric('remaining_amount', { precision: 14, scale: 2 }).notNull(),
    dueDate: timestamp('due_date', { withTimezone: true }),
    kraTransmissionStatus: text('kra_transmission_status').notNull().default('not_applicable'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Date the entry belongs to in the books (not when the row was written). */
    postingDate: date('posting_date', { mode: 'string' }),
    currency: text('currency'),
    /** The document behind it, when it is not an order: a receipt id. */
    documentId: uuid('document_id'),
    registerId: uuid('register_id'),
  },
  (t) => [
    index('customer_ledger_customer_idx').on(t.customerId),
    index('customer_ledger_document_idx').on(t.documentId),
    index('customer_ledger_order_idx').on(t.orderId),
    index('customer_ledger_open_due_idx')
      .on(t.dueDate)
      .where(sql`${t.remainingAmount} > 0`),
  ],
);

/**
 * Financial journal. Rows are inserted only by TransactionLedgerService.
 * Invoices post a debit; payments post a credit. Entries are not edited in place.
 */
export const transactionLedgerEntries = pgTable(
  'transaction_ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    orderId: text('order_id'),
    documentType: text('document_type').notNull(),
    documentNo: text('document_no').notNull(),
    description: text('description'),
    /** debit | credit. Exactly one side is posted; amount is always positive. */
    direction: text('direction').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** Provider payment reference. Required on payment credits. Null on invoice debits. */
    transactionReference: text('transaction_reference'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('transaction_ledger_idempotency_uidx').on(t.idempotencyKey),
    index('transaction_ledger_company_posted_idx').on(t.companyId, t.postedAt),
    index('transaction_ledger_order_idx').on(t.orderId),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: text('product_id').notNull(),
    productName: text('product_name').notNull(),
    sku: text('sku').notNull(),
    quantity: quantity('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    totalPrice: numeric('total_price', { precision: 14, scale: 2 }).notNull(),
    imageUrl: text('image_url').notNull().default(''),
    /** Why this unit price: the pricing engine's recorded explanation. Null for older orders. */
    priceTrace: jsonb('price_trace').$type<PriceTrace>(),
    /** A free gift added by a promotion, not something the customer asked for. */
    isGift: boolean('is_gift').notNull().default(false),
    /** What one unit cost when it was sold (null on orders from before this was kept). */
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }),
    /**
     * The unit this line was entered in (null on lines from before units, and on kit parts): `quantity` is
     * always in the product's base unit, so stock and prices work as ever, and these say how it was typed.
     */
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id, { onDelete: 'restrict' }),
    /** The unit's code when the line was made, so a document never changes its words later. */
    unitCode: text('unit_code'),
    /** The quantity in that unit (3 crates), where `quantity` is what it comes to in base units (60 kg). */
    enteredQuantity: quantity('entered_quantity'),
    /** Base units in one of that unit. */
    qtyPerUnit: numeric('qty_per_unit', { precision: 24, scale: 10 }),
    /** The price per one of that unit, exactly as typed or worked out: the line's amount is this times the entered quantity. */
    enteredUnitPrice: numeric('entered_unit_price', { precision: 14, scale: 4 }),
  },
  (t) => [index('order_items_order_idx').on(t.orderId), index('order_items_unit_idx').on(t.unitId)],
);

/**
 * User-defined classification axes for identifying any record.
 * option_string is a closed catalog validated in application code.
 */
export const dimensions = pgTable(
  'dimensions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    parentId: uuid('parent_id').references((): AnyPgColumn => dimensions.id, {
      onDelete: 'set null',
    }),
    dimensionNo: integer('dimension_no'),
    isGlobal: boolean('is_global').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    isShortcut: boolean('is_shortcut').notNull().default(false),
    optionString: text('option_string'),
    isActive: boolean('is_active').notNull().default(true),
    blocked: boolean('blocked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dimensions_company_code_uidx').on(t.companyId, t.code),
    uniqueIndex('dimensions_company_option_uidx').on(t.companyId, t.optionString),
    uniqueIndex('dimensions_company_no_uidx').on(t.companyId, t.dimensionNo),
    index('dimensions_company_idx').on(t.companyId),
    index('dimensions_parent_idx').on(t.parentId),
  ],
);

export const dimensionValues = pgTable(
  'dimension_values',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dimensionId: uuid('dimension_id')
      .notNull()
      .references(() => dimensions.id, { onDelete: 'cascade' }),
    dimensionCode: text('dimension_code').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    parentId: uuid('parent_id').references((): AnyPgColumn => dimensionValues.id, {
      onDelete: 'set null',
    }),
    /** When parent dimension has option_string=branch, links the operational branches row. */
    linkedBranchId: uuid('linked_branch_id').references(() => branches.id, {
      onDelete: 'set null',
    }),
    isActive: boolean('is_active').notNull().default(true),
    blocked: boolean('blocked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dimension_values_dim_code_uidx').on(t.dimensionId, t.code),
    index('dimension_values_dimension_idx').on(t.dimensionId),
    index('dimension_values_parent_idx').on(t.parentId),
    index('dimension_values_dimension_code_idx').on(t.dimensionCode),
    index('dimension_values_linked_branch_idx').on(t.linkedBranchId),
  ],
);

/**
 * Unique combination of dimension values (BC-style set).
 * Records reference dimension_set_id; dimension_codes jsonb is a rebuildable projection.
 */
export const dimensionSets = pgTable(
  'dimension_sets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Sorted dimension_value ids joined — lookup key for get-or-create. */
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dimension_sets_company_hash_uidx').on(t.companyId, t.contentHash),
    index('dimension_sets_company_idx').on(t.companyId),
  ],
);

export const dimensionSetEntries = pgTable(
  'dimension_set_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dimensionSetId: uuid('dimension_set_id')
      .notNull()
      .references(() => dimensionSets.id, { onDelete: 'cascade' }),
    dimensionId: uuid('dimension_id')
      .notNull()
      .references(() => dimensions.id, { onDelete: 'restrict' }),
    dimensionValueId: uuid('dimension_value_id')
      .notNull()
      .references(() => dimensionValues.id, { onDelete: 'restrict' }),
    dimensionCode: text('dimension_code').notNull(),
    dimensionValueCode: text('dimension_value_code').notNull(),
    dimensionNo: integer('dimension_no'),
    isGlobal: boolean('is_global').notNull().default(false),
    isShortcut: boolean('is_shortcut').notNull().default(false),
  },
  (t) => [
    uniqueIndex('dimension_set_entries_set_dim_uidx').on(t.dimensionSetId, t.dimensionId),
    index('dimension_set_entries_set_idx').on(t.dimensionSetId),
  ],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type CompanySettingsRow = typeof companySettings.$inferSelect;
export type CompanySettingsInsert = typeof companySettings.$inferInsert;
export type BranchRow = typeof branches.$inferSelect;
export type BranchInsert = typeof branches.$inferInsert;
export type PaymentProviderConfigRow = typeof paymentProviderConfigs.$inferSelect;
export type PaymentAttemptRow = typeof paymentAttempts.$inferSelect;
export type PaymentCallbackEventRow = typeof paymentCallbackEvents.$inferSelect;
/* ============================================================================
 * CATALOG & INVENTORY
 *
 * These six tables replace the former in-memory `PostgresStore` Maps. Column
 * names mirror the domain types in `src/types/index.ts` so the repositories can
 * map rows 1:1 without a translation layer.
 * ========================================================================== */

/** Storefront merchandising category. Products reference this by id. */
export const categories = pgTable(
  'categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    imageUrl: text('image_url'),
    isActive: boolean('is_active').notNull().default(true),
    displayOrder: integer('display_order').notNull().default(0),
    /** The category this one sits under (a sub-category). Null for a top-level category. */
    parentId: text('parent_id').references((): AnyPgColumn => categories.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('categories_slug_uidx').on(t.slug),
    index('categories_parent_idx').on(t.parentId),
    index('categories_display_order_idx').on(t.displayOrder),
  ],
);

/**
 * User-defined item classification (raw material, finished good, service…).
 * `code` is the integer code from the tax authority and is required for
 * tax compliance, so it is unique.
 */
export const itemTypes = pgTable(
  'item_types',
  {
    id: text('id').primaryKey(),
    code: integer('code').notNull(),
    name: text('name').notNull(),
    /** Non-sellable types (raw materials) must not carry a selling price. */
    isSellable: boolean('is_sellable').notNull().default(true),
    /** Exactly one default is used when a product is created without a type. */
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('item_types_code_uidx').on(t.code),
    uniqueIndex('item_types_name_uidx').on(t.name),
  ],
);

/** VAT/GST/excise rate definitions. A product may be pinned to one. */
export const taxCategories = pgTable(
  'tax_categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    code: text('code').notNull(),
    /** Percentage, e.g. 16 for 16%. */
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
    /** KRA TIMS (control unit) VAT class letter. Differs from the eTIMS letter for the same rate. */
    timsCode: text('tims_code').notNull().default(''),
    /** KRA eTIMS tax type code (A exempt, B 16%, C 0%, D non-VAT, E 8%). */
    etimsCode: text('etims_code').notNull().default(''),
    type: text('type').notNull(),
    countryCode: text('country_code').notNull().default(''),
    countryName: text('country_name').notNull().default(''),
    description: text('description').notNull().default(''),
    isInclusive: boolean('is_inclusive').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tax_categories_code_uidx').on(t.code),
    index('tax_categories_active_idx').on(t.isActive),
  ],
);

/**
 * Units of measure, managed once and shared by the whole system. Units of one family (`kind`) convert
 * through their factor to the family's base unit ("1 g = 0.001 kg"); packaging units (box, crate)
 * convert per product instead (`product_units`). Like the rest of the catalog these are not per company.
 */
export const unitsOfMeasure = pgTable(
  'units_of_measure',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    symbol: text('symbol'),
    kind: text('kind').notNull(),
    /** The base unit of this unit's family; null for a base unit and for packaging. */
    baseUnitId: uuid('base_unit_id').references((): AnyPgColumn => unitsOfMeasure.id, { onDelete: 'restrict' }),
    /** How many base units make one of this unit (1 for a base unit). */
    factorToBase: numeric('factor_to_base', { precision: 24, scale: 10 }).notNull().default('1'),
    /** Digits after the point a quantity in this unit may have, 0 to 3 (0 for pieces, 3 for kilograms): the most a stored quantity holds. */
    decimals: smallint('decimals').notNull().default(0),
    /** UN/ECE Recommendation 20 code (KGM, C62, LTR), the one e-invoicing and customs use. */
    internationalCode: text('international_code'),
    /** KRA eTIMS quantity unit code. */
    etimsCode: text('etims_code'),
    /** The unit a new product starts with. Exactly one. */
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    /** Counts saves, so two people editing the same unit cannot overwrite each other unseen. */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('units_of_measure_code_uidx').on(t.code),
    uniqueIndex('units_of_measure_name_uidx').on(sql`lower(${t.name})`),
    uniqueIndex('units_of_measure_default_uidx')
      .on(t.isDefault)
      .where(sql`${t.isDefault}`),
    index('units_of_measure_base_idx').on(t.baseUnitId),
    index('units_of_measure_kind_idx').on(t.kind, t.code),
    check('units_of_measure_code_chk', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'`),
    check('units_of_measure_name_chk', sql`char_length(btrim(${t.name})) BETWEEN 1 AND 80`),
    check('units_of_measure_kind_chk', sql`${t.kind} IN ('count','mass','volume','length','area','time','packaging')`),
    check('units_of_measure_decimals_chk', sql`${t.decimals} BETWEEN 0 AND 3`),
    check('units_of_measure_factor_chk', sql`${t.factorToBase} > 0`),
    check('units_of_measure_base_chk', sql`(${t.baseUnitId} IS NULL AND ${t.factorToBase} = 1) OR (${t.baseUnitId} IS NOT NULL AND ${t.baseUnitId} <> ${t.id} AND ${t.kind} <> 'packaging')`),
    check('units_of_measure_default_active_chk', sql`NOT ${t.isDefault} OR ${t.isActive}`),
    check('units_of_measure_version_chk', sql`${t.version} >= 1`),
  ],
);

/**
 * The other units a product is kept, bought or sold in, beside its base unit ("1 CRATE = 20 KG").
 * The base unit itself has no row: it is one of itself by definition.
 */
export const productUnits = pgTable(
  'product_units',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    unitId: uuid('unit_id')
      .notNull()
      .references(() => unitsOfMeasure.id, { onDelete: 'restrict' }),
    /** How many of the product's base unit one of this unit holds. */
    qtyPerBase: numeric('qty_per_base', { precision: 24, scale: 10 }).notNull(),
    /** Shipping weight of one of this unit, in kg. */
    weightKg: numeric('weight_kg', { precision: 12, scale: 4 }),
    /** The unit offered first when selling this product. At most one per product. */
    isSalesDefault: boolean('is_sales_default').notNull().default(false),
    /** The unit offered first when buying this product. At most one per product. */
    isPurchaseDefault: boolean('is_purchase_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('product_units_product_unit_uidx').on(t.productId, t.unitId),
    uniqueIndex('product_units_sales_default_uidx')
      .on(t.productId)
      .where(sql`${t.isSalesDefault}`),
    uniqueIndex('product_units_purchase_default_uidx')
      .on(t.productId)
      .where(sql`${t.isPurchaseDefault}`),
    index('product_units_unit_idx').on(t.unitId),
    check('product_units_qty_chk', sql`${t.qtyPerBase} > 0`),
    check('product_units_weight_chk', sql`${t.weightKg} IS NULL OR ${t.weightKg} >= 0`),
  ],
);

/** Enabled display currencies. Exactly one row has is_base_currency = true. */
export const currencies = pgTable('currencies', {
  /** ISO 4217 alpha code, e.g. "KES". Primary key. */
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  symbol: text('symbol').notNull(),
  /** Multiplier against the store base currency. */
  exchangeRate: numeric('exchange_rate', { precision: 18, scale: 8 }).notNull().default('1'),
  isBaseCurrency: boolean('is_base_currency').notNull().default(false),
  decimalDigits: integer('decimal_digits').notNull().default(2),
  symbolPosition: text('symbol_position').notNull().default('prefix'),
  isEnabled: boolean('is_enabled').notNull().default(true),
  flagEmoji: text('flag_emoji'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Sellable or stock-holding catalog item.
 *
 * `reserved_quantity` is the checkout hold and is only ever mutated by
 * InventoryReservationService inside a row-locked transaction; `stock_quantity`
 * is the physical on-hand count. Available = stock - reserved.
 */
export const products = pgTable(
  'products',
  {
    id: text('id').primaryKey(),
    sku: text('sku').notNull(),
    stockCode: text('stock_code').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    /** Kept for display when the category row is missing or renamed. */
    categoryName: text('category_name').notNull().default(''),
    brand: text('brand'),
    itemTypeId: text('item_type_id')
      .notNull()
      .references(() => itemTypes.id, { onDelete: 'restrict' }),
    /** Denormalized from the item type; drives the storefront sellable filter. */
    isSellable: boolean('is_sellable').notNull().default(true),
    price: numeric('price', { precision: 14, scale: 2 }),
    compareAtPrice: numeric('compare_at_price', { precision: 14, scale: 2 }),
    costPrice: numeric('cost_price', { precision: 14, scale: 2 }).notNull().default('0'),
    taxCategoryId: text('tax_category_id').references(() => taxCategories.id, {
      onDelete: 'set null',
    }),
    taxRate: numeric('tax_rate', { precision: 7, scale: 4 }),
    isTaxInclusive: boolean('is_tax_inclusive'),
    /** Shipping weight of one base unit, in kg. */
    weight: numeric('weight', { precision: 12, scale: 4 }),
    /**
     * The unit stock is counted in. Rows written without one take the default unit
     * (`default_unit_id()`); the application always sets it explicitly.
     */
    baseUnitId: uuid('base_unit_id')
      .notNull()
      .default(sql`default_unit_id()`)
      .references(() => unitsOfMeasure.id, { onDelete: 'restrict' }),
    specifications: jsonb('specifications')
      .$type<{ key: string; value: string }[]>()
      .notNull()
      .default([]),
    stockQuantity: quantity('stock_quantity').notNull().default(0),
    reservedQuantity: quantity('reserved_quantity').notNull().default(0),
    lowStockThreshold: quantity('low_stock_threshold').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    imageUrl: text('image_url').notNull().default(''),
    additionalImages: jsonb('additional_images').$type<string[]>().notNull().default([]),
    rating: numeric('rating', { precision: 3, scale: 2 }).notNull().default('0'),
    reviewCount: integer('review_count').notNull().default(0),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Soft delete. A deleted product keeps its row so the stock ledger and any
     * order/quote history still resolve; every catalog read filters on this.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Partial: a deleted product must not hold on to its codes and slug.
    uniqueIndex('products_sku_uidx')
      .on(t.sku)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('products_stock_code_uidx')
      .on(t.stockCode)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('products_slug_uidx')
      .on(t.slug)
      .where(sql`${t.deletedAt} is null`),
    index('products_category_idx').on(t.categoryId),
    index('products_item_type_idx').on(t.itemTypeId),
    index('products_active_idx').on(t.isActive),
    index('products_base_unit_idx').on(t.baseUnitId),
    // The shop reads only live, sellable products, in one of four orders, a page at a time.
    index('products_shop_name_idx')
      .on(t.name, t.id)
      .where(sql`${t.isActive} and ${t.isSellable} and ${t.deletedAt} is null`),
    index('products_shop_price_idx')
      .on(sql`coalesce(${t.price}, 0)`, t.id)
      .where(sql`${t.isActive} and ${t.isSellable} and ${t.deletedAt} is null`),
    index('products_shop_newest_idx')
      .on(t.createdAt, t.id)
      .where(sql`${t.isActive} and ${t.isSellable} and ${t.deletedAt} is null`),
    // Substring search (`ilike '%word%'`) in the shop's search box.
    index('products_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    index('products_sku_trgm_idx').using('gin', t.sku.op('gin_trgm_ops')),
    index('products_brand_trgm_idx').using('gin', t.brand.op('gin_trgm_ops')),
    index('products_category_name_trgm_idx').using('gin', t.categoryName.op('gin_trgm_ops')),
  ],
);

export type { MediaVisibility };
/** Where an asset lives: a storage provider, or 'external' for a pasted link. */
export type MediaProvider = StoredMediaProvider | 'external';
export type MediaStatus = 'pending' | 'ready';

/**
 * One row per stored (or externally linked) file, independent of who uses it.
 * Consumers (products today; logo, avatars, documents later) reference an asset
 * id, never a provider URL, so the storage provider can change without touching
 * them. `storage_key` is the provider's own handle; the URL is derived from it.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: text('id').primaryKey(),
    provider: text('provider').$type<MediaProvider>().notNull(),
    /** Private assets are only reachable through an authorised, signed delivery. */
    visibility: text('visibility').$type<MediaVisibility>().notNull().default('public'),
    resourceType: text('resource_type').notNull().default('image'),
    /** Namespace / folder: 'product', 'company', 'avatar', 'document'… */
    purpose: text('purpose').notNull().default('product'),
    /** Provider handle (Cloudinary public_id, local relative path). Null for external links. */
    storageKey: text('storage_key'),
    /** The linked URL, external assets only. */
    sourceUrl: text('source_url'),
    mime: text('mime').notNull().default(''),
    bytes: integer('bytes'),
    width: integer('width'),
    height: integer('height'),
    sha256: text('sha256'),
    originalName: text('original_name').notNull().default(''),
    altText: text('alt_text').notNull().default(''),
    /** 'pending' = uploaded but never attached; swept after a day. */
    status: text('status').$type<MediaStatus>().notNull().default('ready'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdByEmail: text('created_by_email').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('media_assets_storage_uidx')
      .on(t.provider, t.storageKey)
      .where(sql`${t.storageKey} is not null`),
    uniqueIndex('media_assets_external_url_uidx')
      .on(t.sourceUrl)
      .where(sql`${t.provider} = 'external' and ${t.deletedAt} is null`),
    index('media_assets_sha_idx').on(t.sha256),
    index('media_assets_library_idx').on(t.status, t.purpose, t.createdAt),
    check(
      'media_assets_location_chk',
      sql`(${t.provider} = 'external' and ${t.sourceUrl} is not null) or (${t.provider} <> 'external' and ${t.storageKey} is not null)`,
    ),
  ],
);

/** A product's gallery: ordered assets, exactly one primary. Assets are shared across products. */
export const productMedia = pgTable(
  'product_media',
  {
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    assetId: text('asset_id')
      .notNull()
      .references(() => mediaAssets.id, { onDelete: 'restrict' }),
    position: integer('position').notNull().default(0),
    isPrimary: boolean('is_primary').notNull().default(false),
    /** Per-product alt text; falls back to the asset's. */
    altText: text('alt_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.assetId] }),
    uniqueIndex('product_media_primary_uidx')
      .on(t.productId)
      .where(sql`${t.isPrimary}`),
    index('product_media_asset_idx').on(t.assetId),
  ],
);

export type ProductImportStatus = 'queued' | 'processing' | 'completed' | 'failed';
export type ProductImportRowStatus = 'pending' | 'created' | 'failed';

/**
 * One bulk CSV import. The file is fully validated before this row exists; the
 * worker then turns its staged rows into products. Counters are derived from
 * the rows, which are the source of truth.
 */
export const productImportJobs = pgTable(
  'product_import_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    status: text('status').$type<ProductImportStatus>().notNull().default('queued'),
    fileName: text('file_name').notNull(),
    /** Guards against the same file being submitted twice while one run is active. */
    fileSha256: text('file_sha256').notNull(),
    totalRows: integer('total_rows').notNull(),
    createdCount: integer('created_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Recorded on each stock-ledger entry the import writes. */
    createdByEmail: text('created_by_email').notNull().default(''),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('product_import_jobs_created_idx').on(t.createdAt),
    uniqueIndex('product_import_jobs_active_file_uidx')
      .on(t.fileSha256)
      .where(sql`${t.status} in ('queued', 'processing')`),
  ],
);

/** A validated CSV row waiting to become (or that became) a product. */
export const productImportRows = pgTable(
  'product_import_rows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => productImportJobs.id, { onDelete: 'cascade' }),
    /** Line in the uploaded file, as the user's spreadsheet numbers it. */
    rowNumber: integer('row_number').notNull(),
    status: text('status').$type<ProductImportRowStatus>().notNull().default('pending'),
    /** Normalised, format-checked values (ProductImportDraft). */
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    /** The original cells by header, for the error report. */
    raw: jsonb('raw').$type<Record<string, string>>().notNull(),
    errors: jsonb('errors').$type<string[]>().notNull().default([]),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('product_import_rows_job_row_uidx').on(t.jobId, t.rowNumber),
    index('product_import_rows_job_status_idx').on(t.jobId, t.status, t.rowNumber),
  ],
);

/**
 * Append-only stock movement journal — the durable replacement for the old
 * in-memory `inventoryLedger` array.
 *
 * It is also the idempotency guard for order reservations: a second
 * fulfill/release for the same `referenceId` is a no-op if a row already exists.
 */
export const inventoryMovements = pgTable(
  'inventory_movements',
  {
    id: text('id').primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** Denormalized so history survives a product rename. */
    productName: text('product_name').notNull().default(''),
    changeAmount: quantity('change_amount').notNull(),
    previousStock: quantity('previous_stock').notNull(),
    newStock: quantity('new_stock').notNull(),
    changeType: text('change_type').notNull(),
    /** PO number, order id, or adjustment reference. */
    referenceId: text('reference_id').notNull().default(''),
    actor: text('actor').notNull().default('admin'),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('inventory_movements_product_idx').on(t.productId),
    index('inventory_movements_reference_idx').on(t.referenceId),
    index('inventory_movements_created_idx').on(t.createdAt),
    // Reservation settlement must be idempotent. A payment gateway can deliver
    // the same webhook concurrently (or on retry), and without this constraint
    // two transactions would each pass the "already settled?" check and deduct
    // stock twice. Only settlement types are constrained; ordinary adjustments
    // to the same reference remain unrestricted.
    uniqueIndex('inventory_movements_settlement_uidx')
      .on(t.referenceId, t.productId, t.changeType)
      .where(sql`${t.changeType} in ('order_fulfillment', 'order_cancellation_release')`),
  ],
);

/**
 * Gateway transaction record for a single payment attempt.
 *
 * Distinct from `payment_attempts` (the branch-scoped, credential-aware
 * provider flow) and from `transaction_ledger_entries` (the financial journal).
 * This is the operational record the reconciliation screen and the legacy
 * M-Pesa / Pesapal callbacks read and write.
 */
export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    orderNumber: text('order_number').notNull().default(''),
    gatewayProvider: text('gateway_provider').notNull(),
    transactionReference: text('transaction_reference').notNull(),
    externalReference: text('external_reference'),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull().default('0'),
    currency: text('currency').notNull().default('KES'),
    status: text('status').notNull().default('initiated'),
    customerPhone: text('customer_phone'),
    customerEmail: text('customer_email'),
    requestPayload: jsonb('request_payload').$type<Record<string, unknown>>().notNull().default({}),
    responsePayload: jsonb('response_payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ipnStatus: text('ipn_status').notNull().default('pending'),
    reconciliationStatus: text('reconciliation_status').notNull().default('pending'),
    errorMessage: text('error_message'),
    // Callback/webhook linkage for async processing
    callbackPayload: jsonb('callback_payload').$type<Record<string, unknown>>(),
    callbackReceivedAt: timestamp('callback_received_at', { withTimezone: true }),
    callbackProcessedAt: timestamp('callback_processed_at', { withTimezone: true }),
    callbackAuditId: uuid('callback_audit_id').references(() => integrationAuditLog.id, {
      onDelete: 'set null',
    }),
    queueJobId: text('queue_job_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_transactions_order_idx').on(t.orderId),
    index('payment_transactions_ref_idx').on(t.transactionReference),
    index('payment_transactions_status_idx').on(t.status),
    index('payment_transactions_settled_idx')
      .on(t.updatedAt)
      .where(sql`${t.status} = 'successful'`),
    index('payment_transactions_callback_audit_idx').on(t.callbackAuditId),
  ],
);

/** Outcome of matching a gateway transaction against its order. */
/**
 * Server-side session records for the legacy `AuthService` login path, so
 * sessions survive a process restart. The token is a bearer secret, therefore
 * only a hash is stored and the plaintext is returned to the caller once.
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    userId: text('user_id').notNull(),
    email: text('email').notNull().default(''),
    name: text('name').notNull().default(''),
    role: text('role').notNull().default('customer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('user_sessions_user_idx').on(t.userId)],
);

/**
 * Unified audit log for ALL outbound HTTP calls and inbound webhooks.
 * Replaces ad-hoc logging in payment services, email, SMS, etc.
 * Encrypted payloads at rest; headers sanitized.
 */
export const integrationAuditLog = pgTable(
  'integration_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    correlationId: text('correlation_id').notNull(),
    direction: text('direction', { enum: ['outbound', 'inbound'] }).notNull(),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    requestPayload: jsonb('request_payload').$type<Record<string, unknown>>(),
    responsePayload: jsonb('response_payload').$type<Record<string, unknown>>(),
    requestHeaders: jsonb('request_headers').$type<Record<string, string>>(),
    responseHeaders: jsonb('response_headers').$type<Record<string, string>>(),
    httpMethod: text('http_method'),
    url: text('url'),
    statusCode: integer('status_code'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    requestSentAt: timestamp('request_sent_at', { withTimezone: true }),
    responseReceivedAt: timestamp('response_received_at', { withTimezone: true }),
    callbackReceivedAt: timestamp('callback_received_at', { withTimezone: true }),
    callbackPayload: jsonb('callback_payload').$type<Record<string, unknown>>(),
    retryCount: integer('retry_count').notNull().default(0),
    queueJobId: text('queue_job_id'),
    /** Which provider connection, and which operation, this call or callback belongs to. */
    providerId: uuid('provider_id'),
    operationId: uuid('operation_id'),
    sourceIp: text('source_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
  },
  (t) => [
    index('integration_audit_correlation_idx').on(t.correlationId),
    index('integration_audit_provider_op_idx').on(t.provider, t.operation),
    index('integration_audit_created_idx').on(t.createdAt),
    index('integration_audit_queue_job_idx').on(t.queueJobId),
    index('integration_audit_operation_idx').on(t.operationId),
    index('integration_audit_retention_idx').on(t.retentionUntil),
  ],
);

export const reconciliationLogs = pgTable(
  'reconciliation_logs',
  {
    id: text('id').primaryKey(),
    transactionId: text('transaction_id').notNull().default(''),
    orderId: text('order_id').notNull(),
    orderNumber: text('order_number').notNull().default(''),
    provider: text('provider').notNull(),
    reconciliationType: text('reconciliation_type').notNull().default('manual_override'),
    orderTotal: numeric('order_total', { precision: 14, scale: 2 }).notNull().default('0'),
    receivedAmount: numeric('received_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    discrepancyFound: boolean('discrepancy_found').notNull().default(false),
    discrepancyType: text('discrepancy_type').notNull().default('none'),
    status: text('status').notNull().default('matched'),
    details: text('details').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('reconciliation_logs_order_idx').on(t.orderId),
    index('reconciliation_logs_transaction_idx').on(t.transactionId),
    index('reconciliation_logs_created_idx').on(t.createdAt),
  ],
);

/** Per-company gross-margin approval floor for sales quotes. */
export const salesQuoteSettings = pgTable('sales_quote_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companySettings.id, { onDelete: 'cascade' }),
  minimumGrossMarginPercent: numeric('minimum_gross_margin_percent', {
    precision: 7,
    scale: 3,
  })
    .notNull()
    .default('0'),
  nextQuoteNumber: integer('next_quote_number').notNull().default(1),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Reusable quote defaults; product prices can either refresh or be fixed. */
export const salesQuoteTemplates = pgTable(
  'sales_quote_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    category: text('category'),
    description: text('description'),
    status: text('status').notNull().default('active'),
    isDefault: boolean('is_default').notNull().default(false),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    currency: text('currency').notNull().default('KES'),
    paymentMethod: text('payment_method').notNull().default('mpesa_daraja'),
    paymentTerms: text('payment_terms'),
    showBillingAddress: boolean('show_billing_address').notNull().default(false),
    paymentDetails: text('payment_details'),
    termsAndConditions: text('terms_and_conditions'),
    validityDays: integer('validity_days').notNull().default(30),
    quoteDiscountPercent: numeric('quote_discount_percent', { precision: 7, scale: 3 })
      .notNull()
      .default('0'),
    shippingFee: numeric('shipping_fee', { precision: 14, scale: 2 }).notNull().default('0'),
    billingAddress: jsonb('billing_address').$type<Record<string, string>>().notNull().default({}),
    deliveryAddress: jsonb('delivery_address')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    publicNotes: text('public_notes'),
    internalNotes: text('internal_notes'),
    usageCount: integer('usage_count').notNull().default(0),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sales_quote_templates_company_name_uidx').on(t.companyId, t.name),
    uniqueIndex('sales_quote_templates_one_default_uidx')
      .on(t.companyId)
      .where(sql`${t.isDefault} = true`),
    index('sales_quote_templates_company_status_idx').on(t.companyId, t.status),
  ],
);

export const salesQuoteTemplateSections = pgTable(
  'sales_quote_template_sections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => salesQuoteTemplates.id, { onDelete: 'cascade' }),
    sectionNumber: integer('section_number').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    /** Print the section's items under its title; otherwise only the title and its total. */
    showLines: boolean('show_lines').notNull().default(false),
  },
  (t) => [
    uniqueIndex('sales_quote_template_sections_number_uidx').on(t.templateId, t.sectionNumber),
  ],
);

export const salesQuoteTemplateLines = pgTable(
  'sales_quote_template_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => salesQuoteTemplates.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').references(() => salesQuoteTemplateSections.id, {
      onDelete: 'set null',
    }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    lineNumber: integer('line_number').notNull(),
    sku: text('sku').notNull().default(''),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull().default('1'),
    priceMode: text('price_mode').notNull().default('catalog'),
    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }),
    discountPercent: numeric('discount_percent', { precision: 7, scale: 3 }).notNull().default('0'),
  },
  (t) => [uniqueIndex('sales_quote_template_lines_number_uidx').on(t.templateId, t.lineNumber)],
);

export const salesQuoteTemplateEvents = pgTable(
  'sales_quote_template_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => salesQuoteTemplates.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorId: text('actor_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sales_quote_template_events_idx').on(t.templateId, t.createdAt)],
);

/**
 * A reusable section: a titled group of items that can be added to any quote. Adding one copies it,
 * so later edits here do not change quotes that already used it.
 */
export const salesSectionTemplates = pgTable(
  'sales_section_templates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category'),
    description: text('description'),
    status: text('status').notNull().default('active'),
    /** What the section on a quote is titled when it is made from this template. */
    sectionTitle: text('section_title').notNull(),
    sectionDescription: text('section_description'),
    showLines: boolean('show_lines').notNull().default(false),
    usageCount: integer('usage_count').notNull().default(0),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sales_section_templates_company_name_uidx').on(t.companyId, t.name),
    index('sales_section_templates_company_status_idx').on(t.companyId, t.status),
  ],
);

export const salesSectionTemplateLines = pgTable(
  'sales_section_template_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => salesSectionTemplates.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    lineNumber: integer('line_number').notNull(),
    sku: text('sku').notNull().default(''),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull().default('1'),
    priceMode: text('price_mode').notNull().default('catalog'),
    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }),
    discountPercent: numeric('discount_percent', { precision: 7, scale: 3 }).notNull().default('0'),
  },
  (t) => [uniqueIndex('sales_section_template_lines_number_uidx').on(t.templateId, t.lineNumber)],
);

export const salesSectionTemplateEvents = pgTable(
  'sales_section_template_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => salesSectionTemplates.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorId: text('actor_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sales_section_template_events_idx').on(t.templateId, t.createdAt)],
);

/** Sales quotation header; line/cost/tax values are price snapshots. */
export const salesQuotes = pgTable(
  'sales_quotes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    templateId: uuid('template_id').references(() => salesQuoteTemplates.id, {
      onDelete: 'set null',
    }),
    templateName: text('template_name'),
    quoteNumber: text('quote_number').notNull(),
    status: text('status').notNull().default('draft'),
    customerName: text('customer_name').notNull(),
    customerEmail: text('customer_email'),
    customerPhone: text('customer_phone'),
    billingAddress: jsonb('billing_address').$type<Record<string, string>>().notNull().default({}),
    deliveryAddress: jsonb('delivery_address')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    paymentTerms: text('payment_terms'),
    showBillingAddress: boolean('show_billing_address').notNull().default(false),
    paymentDetails: text('payment_details'),
    termsAndConditions: text('terms_and_conditions'),
    currency: text('currency').notNull().default('KES'),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
    taxAmount: numeric('tax_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    quoteDiscountPercent: numeric('quote_discount_percent', { precision: 7, scale: 3 })
      .notNull()
      .default('0'),
    shippingFee: numeric('shipping_fee', { precision: 14, scale: 2 }).notNull().default('0'),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    totalCost: numeric('total_cost', { precision: 14, scale: 2 }).notNull().default('0'),
    grossProfit: numeric('gross_profit', { precision: 14, scale: 2 }).notNull().default('0'),
    grossMarginPercent: numeric('gross_margin_percent', { precision: 7, scale: 3 })
      .notNull()
      .default('0'),
    minimumMarginPercent: numeric('minimum_margin_percent', { precision: 7, scale: 3 })
      .notNull()
      .default('0'),
    approvalStatus: text('approval_status').notNull().default('not_required'),
    /** Coupon codes entered on the quote. */
    couponCodes: jsonb('coupon_codes').$type<string[]>().notNull().default([]),
    /** The discounts applied to the quote (rules, coupons, amounts), as recorded when it was priced. */
    discounts: jsonb('discounts').$type<Record<string, unknown>>(),
    /** 'workflow' when the approvals engine owns this quote's approval; null for the old margin-floor check. */
    approvalManagedBy: text('approval_managed_by'),
    paymentMethod: text('payment_method').notNull().default('mpesa_daraja'),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    customerReference: text('customer_reference'),
    publicNotes: text('public_notes'),
    internalNotes: text('internal_notes'),
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    convertedOrderId: text('converted_order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    shareTokenHash: text('share_token_hash'),
    revisedFromQuoteId: uuid('revised_from_quote_id').references(
      (): AnyPgColumn => salesQuotes.id,
      {
        onDelete: 'set null',
      },
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sales_quotes_company_number_uidx').on(t.companyId, t.quoteNumber),
    index('sales_quotes_company_status_idx').on(t.companyId, t.status, t.createdAt),
    index('sales_quotes_customer_idx').on(t.customerId, t.createdAt),
  ],
);

export const salesQuoteSections = pgTable(
  'sales_quote_sections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => salesQuotes.id, { onDelete: 'cascade' }),
    sectionNumber: integer('section_number').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    /** Print the section's items under its title; otherwise only the title and its total. */
    showLines: boolean('show_lines').notNull().default(false),
    /** Came from the quote's template, so switching template replaces it; false when added by hand. */
    fromTemplate: boolean('from_template').notNull().default(false),
    /** The section template this section was made from; switching it replaces its template items. */
    sectionTemplateId: uuid('section_template_id').references(() => salesSectionTemplates.id, {
      onDelete: 'set null',
    }),
    sectionTemplateName: text('section_template_name'),
  },
  (t) => [uniqueIndex('sales_quote_sections_number_uidx').on(t.quoteId, t.sectionNumber)],
);

export const salesQuoteLines = pgTable(
  'sales_quote_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => salesQuotes.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id').references(() => salesQuoteSections.id, { onDelete: 'set null' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    lineNumber: integer('line_number').notNull(),
    sku: text('sku').notNull().default(''),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }).notNull(),
    taxRate: numeric('tax_rate', { precision: 7, scale: 3 }).notNull().default('0'),
    isTaxInclusive: boolean('is_tax_inclusive').notNull().default(true),
    discountPercent: numeric('discount_percent', { precision: 7, scale: 3 }).notNull().default('0'),
    netAmount: numeric('net_amount', { precision: 14, scale: 2 }).notNull(),
    taxAmount: numeric('tax_amount', { precision: 14, scale: 2 }).notNull(),
    lineAmount: numeric('line_amount', { precision: 14, scale: 2 }).notNull(),
    costAmount: numeric('cost_amount', { precision: 14, scale: 2 }).notNull(),
    /** Why this unit price: the pricing engine's recorded explanation. Null for typed prices. */
    priceTrace: jsonb('price_trace').$type<PriceTrace>(),
    /** A free gift added by a promotion, not something the customer asked for. */
    isGift: boolean('is_gift').notNull().default(false),
    /** What an order-level discount took off this line, as a percentage. */
    ruleDiscountPercent: numeric('rule_discount_percent', { precision: 9, scale: 6 })
      .notNull()
      .default('0'),
    /** Came from the quote's template, so switching template replaces it; false when added by hand. */
    fromTemplate: boolean('from_template').notNull().default(false),
    /** Came from the section template of the section it sits in; false when added by hand. */
    fromSectionTemplate: boolean('from_section_template').notNull().default(false),
    /**
     * The unit this line was entered in (null on lines from before units, and on kit parts): `quantity` is
     * always in the product's base unit, so stock and prices work as ever, and these say how it was typed.
     */
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id, { onDelete: 'restrict' }),
    /** The unit's code when the line was made, so a document never changes its words later. */
    unitCode: text('unit_code'),
    /** The quantity in that unit (3 crates), where `quantity` is what it comes to in base units (60 kg). */
    enteredQuantity: quantity('entered_quantity'),
    /** Base units in one of that unit. */
    qtyPerUnit: numeric('qty_per_unit', { precision: 24, scale: 10 }),
    /** The price per one of that unit, exactly as typed or worked out: the line's amount is this times the entered quantity. */
    enteredUnitPrice: numeric('entered_unit_price', { precision: 14, scale: 4 }),
  },
  (t) => [uniqueIndex('sales_quote_lines_number_uidx').on(t.quoteId, t.lineNumber), index('sales_quote_lines_unit_idx').on(t.unitId)],
);

export const salesQuoteEvents = pgTable(
  'sales_quote_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => salesQuotes.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    actorId: text('actor_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sales_quote_events_quote_idx').on(t.quoteId, t.createdAt)],
);

/**
 * Admin-facing gateway toggle and credentials, keyed by the legacy gateway id
 * (e.g. "gw_mpesa_daraja") so the M-Pesa / Pesapal services can look one up by
 * a stable key. Complements the branch-scoped `payment_provider_configs`.
 */
export const paymentGatewayConfigs = pgTable('payment_gateway_configs', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(false),
  environment: text('environment').notNull().default('sandbox'),
  /**
   * Sealed credential blob. Never store gateway secrets as plain jsonb here —
   * `encryptCredentials`/`decryptCredentials` from the payments crypto module own
   * this column, mirroring `payment_provider_configs.credentialsEncrypted`.
   */
  credentialsEncrypted: jsonb('credentials_encrypted').$type<EncryptedCredentialsBlob>(),
  supportedCurrencies: jsonb('supported_currencies').$type<string[]>().notNull().default([]),
  icon: text('icon').notNull().default(''),
  description: text('description').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type IntegrationAuditLogRow = typeof integrationAuditLog.$inferSelect;
export type IntegrationAuditLogInsert = typeof integrationAuditLog.$inferInsert;
export type UserSessionRow = typeof userSessions.$inferSelect;
export type UserSessionInsert = typeof userSessions.$inferInsert;
export type InvoiceDocumentRow = typeof invoiceDocuments.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type AuthTokenRow = typeof authTokens.$inferSelect;
export type ProductImportJobRow = typeof productImportJobs.$inferSelect;
export type ProductImportRowRow = typeof productImportRows.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type RoleInsert = typeof roles.$inferInsert;
export type PermissionRow = typeof permissions.$inferSelect;
export type PermissionInsert = typeof permissions.$inferInsert;
export type RolePermissionRow = typeof rolePermissions.$inferSelect;
export type UserRoleRow = typeof userRoles.$inferSelect;
export type UserPermissionRow = typeof userPermissions.$inferSelect;
export type AccessPolicyRow = typeof accessPolicies.$inferSelect;
export type AccessPolicyInsert = typeof accessPolicies.$inferInsert;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type AuditLogInsert = typeof auditLogs.$inferInsert;
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type SalesQuoteRow = typeof salesQuotes.$inferSelect;
export type SalesQuoteLineRow = typeof salesQuoteLines.$inferSelect;
export type SalesQuoteEventRow = typeof salesQuoteEvents.$inferSelect;
export type SalesQuoteTemplateRow = typeof salesQuoteTemplates.$inferSelect;
export type SalesQuoteTemplateLineRow = typeof salesQuoteTemplateLines.$inferSelect;
export type SalesQuoteTemplateEventRow = typeof salesQuoteTemplateEvents.$inferSelect;
export type SalesSectionTemplateRow = typeof salesSectionTemplates.$inferSelect;
export type SalesSectionTemplateLineRow = typeof salesSectionTemplateLines.$inferSelect;
export type SalesSectionTemplateEventRow = typeof salesSectionTemplateEvents.$inferSelect;
export type DimensionRow = typeof dimensions.$inferSelect;
export type DimensionInsert = typeof dimensions.$inferInsert;
export type DimensionValueRow = typeof dimensionValues.$inferSelect;
export type DimensionValueInsert = typeof dimensionValues.$inferInsert;
export type DimensionSetRow = typeof dimensionSets.$inferSelect;
export type DimensionSetEntryRow = typeof dimensionSetEntries.$inferSelect;
export interface DimensionCodesProjection {
  global: Record<string, string>;
  shortcut: Record<string, string>;
}
export type CustomerProfileRow = typeof customerProfiles.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type CustomerAddressRow = typeof customerAddresses.$inferSelect;
export type CustomerLedgerEntryRow = typeof customerLedgerEntries.$inferSelect;
export type TransactionLedgerEntryRow = typeof transactionLedgerEntries.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type CategoryInsert = typeof categories.$inferInsert;
export type ItemTypeRow = typeof itemTypes.$inferSelect;
export type ItemTypeInsert = typeof itemTypes.$inferInsert;
export type CompanyKraConfigRow = typeof companyKraConfigs.$inferSelect;
export type BranchKraConfigRow = typeof branchKraConfigs.$inferSelect;
export type DecisionLogRow = typeof decisionLog.$inferSelect;
export type ReasonCodeRow = typeof reasonCodes.$inferSelect;
export type NumberSeriesRow = typeof numberSeries.$inferSelect;
export type NumberSeriesLineRow = typeof numberSeriesLines.$inferSelect;
export type NumberSeriesCounterRow = typeof numberSeriesCounters.$inferSelect;
export type NumberSeriesAllocationRow = typeof numberSeriesAllocations.$inferSelect;
export type NumberSeriesBindingRow = typeof numberSeriesBindings.$inferSelect;
export type CreditNoteRow = typeof creditNotes.$inferSelect;
export type CreditNoteLineRow = typeof creditNoteLines.$inferSelect;
export type KraSigningEventRow = typeof kraSigningEvents.$inferSelect;
export type EtimsItemRow = typeof etimsItems.$inferSelect;
export type KraTransmissionRow = typeof kraTransmissions.$inferSelect;

export type TaxCategoryRow = typeof taxCategories.$inferSelect;
export type UnitOfMeasureRow = typeof unitsOfMeasure.$inferSelect;
export type ProductUnitRow = typeof productUnits.$inferSelect;
export type TaxCategoryInsert = typeof taxCategories.$inferInsert;
export type CurrencyRow = typeof currencies.$inferSelect;
export type CurrencyInsert = typeof currencies.$inferInsert;
export type ProductRow = typeof products.$inferSelect;
export type ProductInsert = typeof products.$inferInsert;
export type InventoryMovementRow = typeof inventoryMovements.$inferSelect;
export type InventoryMovementInsert = typeof inventoryMovements.$inferInsert;
export type PaymentTransactionRow = typeof paymentTransactions.$inferSelect;
export type PaymentTransactionInsert = typeof paymentTransactions.$inferInsert;
export type ReconciliationLogRow = typeof reconciliationLogs.$inferSelect;
export type ReconciliationLogInsert = typeof reconciliationLogs.$inferInsert;
export type PaymentGatewayConfigRow = typeof paymentGatewayConfigs.$inferSelect;
export type PaymentGatewayConfigInsert = typeof paymentGatewayConfigs.$inferInsert;
export type ApprovalParkedActionRow = typeof approvalParkedActions.$inferSelect;


// ─── Finance F-1: money containers, payment methods, receipts, receivables detail ────────

/** Where money sits: a bank account, a cash drawer, a mobile-money settlement account, a clearing account. */
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<'bank' | 'cash' | 'mobile_money' | 'clearing'>().notNull(),
    currency: text('currency').notNull(),
    /** Where fees charged on this account post (bank charges, mobile-money charges). */
    feeGlAccountId: uuid('fee_gl_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    /** The provider account that fills this one (e.g. the Daraja paybill settling here). */
    providerConfigId: uuid('provider_config_id').references(() => paymentProviderConfigs.id, {
      onDelete: 'set null',
    }),
    /** Non-secret facts: bank name, branch, account number, paybill, till number. */
    details: jsonb('details').$type<Record<string, string>>().notNull().default({}),
    statementFormat: text('statement_format'),
    blocked: boolean('blocked').notNull().default(false),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_accounts_company_code_uidx').on(t.companyId, t.code),
  ],
);

/**
 * A count of the cash in a drawer or safe against what the books say it holds. The count is notes and coins; the books'
 * figure is read at that moment; the difference (short or over) is written to the books at once, with a note, and the
 * count is kept for good. Counts are never changed or removed: a mistake is answered by counting again.
 */
export const cashCounts = pgTable(
  'cash_counts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    countDate: date('count_date', { mode: 'string' }).notNull(),
    currency: text('currency').notNull(),
    /** Each denomination counted: its value and how many. Empty when only a total was entered. */
    denominations: jsonb('denominations').$type<{ value: string; count: number }[]>().notNull().default([]),
    countedAmount: numeric('counted_amount', { precision: 20, scale: 2 }).notNull(),
    /** What the books said the account held on the count date. */
    expectedAmount: numeric('expected_amount', { precision: 20, scale: 2 }).notNull(),
    /** Counted less expected: negative is short, positive is over. */
    difference: numeric('difference', { precision: 20, scale: 2 }).notNull(),
    varianceGlAccountId: uuid('variance_gl_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    note: text('note'),
    registerId: uuid('register_id'),
    bankEntryId: bigint('bank_entry_id', { mode: 'number' }),
    countedBy: text('counted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cash_counts_company_number_uidx').on(t.companyId, t.number),
    index('cash_counts_account_idx').on(t.bankAccountId, t.countDate, t.createdAt),
    check('cash_counts_counted_chk', sql`${t.countedAmount} >= 0`),
    check('cash_counts_difference_chk', sql`${t.difference} = ${t.countedAmount} - ${t.expectedAmount}`),
  ],
);

export type CashCountRow = typeof cashCounts.$inferSelect;

export type PaymentMethodKind =
  | 'cash'
  | 'bank_transfer'
  | 'bank_deposit'
  | 'cheque'
  | 'mobile_money'
  | 'card'
  | 'gateway'
  | 'wallet'
  | 'gift_card'
  | 'offset'
  | 'other';

/** How a customer pays, and what that does to the books. Data, never code. */
export const paymentMethods = pgTable(
  'payment_methods',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').$type<PaymentMethodKind>().notNull(),
    /** The bank / cash / clearing account the money lands in. Always set. */
    balancingBankAccountId: uuid('balancing_bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    requiresReference: boolean('requires_reference').notNull().default(false),
    requiresEvidence: boolean('requires_evidence').notNull().default(false),
    /** Cheque number, bank and drawer must be given. */
    requiresCounterparty: boolean('requires_counterparty').notNull().default(false),
    /** The one provider this method goes through (the built-in "Manual" one for cash, cheques and the like). */
    providerId: uuid('provider_id')
      .notNull()
      .references(() => paymentProviderConfigs.id, { onDelete: 'restrict' }),
    /** The branch this method belongs to. Empty = every branch. */
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    /** The G/L account its money posts to. */
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'restrict' }),
    /** What the number is (paybill, till, account) and the number itself. */
    channelKind: text('channel_kind'),
    channelNumber: text('channel_number'),
    /** customer_receipt | customer_refund | vendor_payment | vendor_receipt */
    usableFor: jsonb('usable_for').$type<string[]>().notNull().default(['customer_receipt']),
    settlementMode: text('settlement_mode')
      .$type<'immediate' | 'delayed' | 'on_statement'>()
      .notNull()
      .default('immediate'),
    settlementDays: integer('settlement_days').notNull().default(0),
    feePolicy: jsonb('fee_policy').$type<Record<string, unknown>>().notNull().default({}),
    limits: jsonb('limits').$type<{ min?: string; max?: string }>().notNull().default({}),
    /** none | manual | automatic: may a refund be paid out through this method? */
    refundDestination: text('refund_destination')
      .$type<'none' | 'manual' | 'automatic'>()
      .notNull()
      .default('none'),
    /** Old free-text provider codes (orders.payment_method) this method stands for. */
    legacyCodes: jsonb('legacy_codes').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(100),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_methods_company_code_uidx').on(t.companyId, t.code),
    index('payment_methods_bank_idx').on(t.balancingBankAccountId),
    index('payment_methods_provider_idx').on(t.providerId),
    index('payment_methods_gl_idx').on(t.glAccountId),
  ],
);

/** Movements on a bank or cash account. Append-only; reconciliation (F-5) marks them in its own table. */
export const bankLedgerEntries = pgTable(
  'bank_ledger_entries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    documentType: text('document_type').notNull(),
    documentNo: text('document_no').notNull(),
    documentId: uuid('document_id'),
    description: text('description'),
    /** The G/L account this movement posted to (from the payment method it went through). */
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'restrict' }),
    /** Positive = money in, negative = money out. */
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    currency: text('currency').notNull(),
    registerId: uuid('register_id'),
    reversesEntryId: bigint('reverses_entry_id', { mode: 'number' }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bank_ledger_account_date_idx').on(t.bankAccountId, t.postingDate),
    index('bank_ledger_gl_idx').on(t.glAccountId),
    index('bank_ledger_document_idx').on(t.documentId),
  ],
);

export type ReceiptStatus = 'draft' | 'posted' | 'reversed' | 'cancelled';
export type ChequeStatus = 'received' | 'deposited' | 'cleared' | 'bounced';

/** A payment received from a customer. Draft until posted; never edited after. */
export const customerReceipts = pgTable(
  'customer_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    paymentMethodId: uuid('payment_method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict' }),
    /** Where the money landed (the method's account at the time). */
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    /** Rate of the receipt currency to the base currency (text, like the engine). */
    rate: text('rate').notNull().default('1'),
    paymentDate: date('payment_date', { mode: 'string' }).notNull(),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    externalReference: text('external_reference'),
    payerName: text('payer_name'),
    /** Cheque number, drawer bank, drawer, cheque date; deposit slip number. */
    counterparty: jsonb('counterparty').$type<Record<string, string>>().notNull().default({}),
    narration: text('narration'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    status: text('status').$type<ReceiptStatus>().notNull().default('draft'),
    chequeStatus: text('cheque_status').$type<ChequeStatus>(),
    source: text('source')
      .$type<'manual' | 'gateway' | 'bank_statement' | 'pos' | 'portal' | 'import'>()
      .notNull()
      .default('manual'),
    sourceRef: text('source_ref'),
    orderId: text('order_id'),
    /** An advance with no invoice behind it: the whole amount goes to the wallet when posted. */
    isDeposit: boolean('is_deposit').notNull().default(false),
    idempotencyKey: text('idempotency_key'),
    ledgerEntryId: uuid('ledger_entry_id'),
    registerId: uuid('register_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: text('posted_by'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_receipts_company_number_uidx').on(t.companyId, t.number),
    uniqueIndex('customer_receipts_idem_uidx')
      .on(t.companyId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    // The same outside reference on the same method cannot be recorded twice (a bank or
    // M-Pesa reference is one payment), unless the earlier one was cancelled or reversed.
    uniqueIndex('customer_receipts_reference_uidx')
      .on(t.companyId, t.paymentMethodId, t.externalReference)
      .where(sql`${t.externalReference} IS NOT NULL AND ${t.status} IN ('draft','posted')`),
    index('customer_receipts_customer_idx').on(t.customerId, t.createdAt),
    index('customer_receipts_status_idx').on(t.companyId, t.status, t.createdAt),
    check('customer_receipts_amount_chk', sql`${t.amount} > 0`),
  ],
);

/** The life of a receipt: every step, who took it, why. Append-only. */
export const receiptEvents = pgTable(
  'receipt_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => customerReceipts.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('receipt_events_receipt_idx').on(t.receiptId, t.id)],
);

export type CustomerDetailedEntryType =
  | 'initial'
  | 'application'
  | 'unapplication'
  | 'reversal'
  | 'write_off'
  | 'payment_discount'
  | 'rounding'
  | 'fx_gain'
  | 'fx_loss'
  | 'wallet_transfer'
  | 'refund_transfer';

/**
 * Every change to what is open on a customer ledger entry. Append-only. An entry's remaining
 * amount is the sum of its detailed entries (kept up to date in the same transaction and
 * checked by `customerBalanceDrift`).
 */
export const customerDetailedEntries = pgTable(
  'customer_detailed_entries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    ledgerEntryId: uuid('ledger_entry_id')
      .notNull()
      .references(() => customerLedgerEntries.id, { onDelete: 'restrict' }),
    entryType: text('entry_type').$type<CustomerDetailedEntryType>().notNull(),
    /** Signed, in the ledger entry's currency; the sum per ledger entry is what is open. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /** For applications: the entry on the other side. */
    appliedToEntryId: uuid('applied_to_entry_id'),
    /** One id per apply / unapply action; both sides of it share it. */
    applicationId: uuid('application_id'),
    /** An unapplication names the application it undoes (each can be undone once). */
    unappliesApplicationId: uuid('unapplies_application_id'),
    postingDate: date('posting_date', { mode: 'string' }),
    registerId: uuid('register_id'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('customer_detailed_entry_idx').on(t.ledgerEntryId),
    index('customer_detailed_customer_idx').on(t.customerId, t.id),
    index('customer_detailed_application_idx').on(t.applicationId),
    // Each row of an application can be undone once (an application to several invoices has
    // several rows on the receipt's side, one per invoice).
    uniqueIndex('customer_detailed_unapply_once_uidx')
      .on(t.unappliesApplicationId, t.ledgerEntryId, t.appliedToEntryId)
      .where(sql`${t.unappliesApplicationId} IS NOT NULL`),
  ],
);

/** A file kept as evidence for a finance document (deposit slip, screenshot, cheque image). */
export const financeAttachments = pgTable(
  'finance_attachments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    mediaAssetId: text('media_asset_id').notNull(),
    fileName: text('file_name').notNull(),
    note: text('note'),
    uploadedBy: text('uploaded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('finance_attachments_subject_idx').on(t.subjectType, t.subjectId)],
);

export type SalesPostingKind =
  | 'invoice'
  | 'cash_sale'
  | 'credit_payment'
  | 'rebate_credit'
  | 'wallet_use'
  | 'gift_card_issue'
  | 'gift_card_adjust'
  | 'loyalty_change'
  | 'fx_application'
  | 'fx_unapplication';
export type SalesPostingStatus = 'pending' | 'posted' | 'failed' | 'skipped';

// ─── Finance F-2: customer wallet ────────────────────────────────────────────────────────

export type WalletEntryType =
  | 'deposit'
  | 'overpayment'
  | 'utilisation'
  | 'tender'
  | 'credit_note'
  | 'cash_out'
  | 'adjustment'
  | 'expiry'
  | 'reversal';

/** A customer's credit held by the business, one per currency. A liability, never a debtor. */
export const customerWallets = pgTable(
  'customer_wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    currency: text('currency').notNull(),
    status: text('status').$type<'active' | 'frozen'>().notNull().default('active'),
    /** The sum of the wallet's entries, kept in step with them in the same transaction. */
    balance: numeric('balance', { precision: 14, scale: 2 }).notNull().default('0'),
    /** What the balance is worth in the books' currency (the same as the balance for a wallet in that currency). */
    baseValue: numeric('base_value', { precision: 18, scale: 4 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_wallets_customer_currency_uidx').on(t.customerId, t.currency),
    index('customer_wallets_company_idx').on(t.companyId),
    index('customer_wallets_dormant_idx').on(t.companyId, t.updatedAt).where(sql`${t.balance} > 0`),
    check('customer_wallets_not_negative_chk', sql`${t.balance} >= 0`),
  ],
);

/** Every movement of a wallet. Append-only. */
export const walletEntries = pgTable(
  'wallet_entries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => customerWallets.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull(),
    entryType: text('entry_type').$type<WalletEntryType>().notNull(),
    /** Signed: money into the wallet is positive. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    /** What caused it: a receipt, an invoice, an order. */
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    /** The customer-ledger entry on the other side, when there is one. */
    ledgerEntryId: uuid('ledger_entry_id'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text'),
    registerId: uuid('register_id'),
    /** The rate this movement is carried at: the receipt's for money in, the wallet's average for money out ("1" in the books' currency). */
    rate: text('rate').notNull().default('1'),
    /** Signed, like `amount`, but in the books' currency at `rate`. */
    baseAmount: numeric('base_amount', { precision: 18, scale: 4 }).notNull().default('0'),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('wallet_entries_wallet_idx').on(t.walletId, t.id),
    index('wallet_entries_customer_idx').on(t.customerId, t.id),
    index('wallet_entries_source_idx').on(t.sourceType, t.sourceId),
  ],
);

/**
 * The "refund or wallet" switch, effective-dated. A row with no group applies to the company; a
 * row for a customer posting group overrides it for that group. The newest row in force wins.
 */
export const customerCreditPolicies = pgTable(
  'customer_credit_policies',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    groupCode: text('group_code'),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    walletEnabled: boolean('wallet_enabled').notNull().default(false),
    allowDeposits: boolean('allow_deposits').notNull().default(true),
    /** What to do with money paid beyond what is owed: wallet | hold | ask. */
    overpaymentDefault: text('overpayment_default').$type<'wallet' | 'hold' | 'ask'>().notNull().default('ask'),
    /** On a credit invoice: apply the wallet automatically (oldest_first) or leave it (never). */
    autoApply: text('auto_apply').$type<'never' | 'oldest_first'>().notNull().default('never'),
    /** Where the part of a credit note that the invoice cannot absorb goes: wallet, or wait for a person (ask). */
    creditNoteExcessDefault: text('credit_note_excess_default').$type<'wallet' | 'ask'>().notNull().default('ask'),
    /** Can money be paid back out to customers at all? Off makes every excess go to the wallet. */
    refundsEnabled: boolean('refunds_enabled').notNull().default(true),
    /** May a customer's wallet be paid out in cash (a refund from the wallet)? */
    walletCashOut: boolean('wallet_cash_out').notNull().default(false),
    maxBalance: numeric('max_balance', { precision: 14, scale: 2 }),
    /** A balance nobody has touched for this many days lapses (null = never). */
    expiryDays: integer('expiry_days'),
    /** How many days before it lapses a balance is shown as about to. */
    expiryNoticeDays: integer('expiry_notice_days').notNull().default(30),
    /** What the customer sees it called: Wallet, Account credit, Store credit. */
    label: text('label').notNull().default('Wallet'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_credit_policies_scope_uidx').on(t.companyId, sql`coalesce(${t.groupCode}, '')`, t.effectiveFrom),
  ],
);

export type CustomerWalletRow = typeof customerWallets.$inferSelect;
export type WalletEntryRow = typeof walletEntries.$inferSelect;
export type CustomerCreditPolicyRow = typeof customerCreditPolicies.$inferSelect;

// ─── Finance F-3: credit-note accounting and restock confirmation ────────────────────────────

/** What a credit note did to the customer's account and the books. One row per credit note. */
export const creditNoteAccounting = pgTable('credit_note_accounting', {
  creditNoteId: uuid('credit_note_id')
    .primaryKey()
    .references(() => creditNotes.id, { onDelete: 'restrict' }),
  companyId: uuid('company_id')
    .notNull()
    .references(() => companySettings.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull(),
  /** The credit entry on the customer's account. */
  ledgerEntryId: uuid('ledger_entry_id').notNull(),
  registerId: uuid('register_id'),
  currency: text('currency').notNull(),
  /** What was credited (goods and their tax). */
  gross: numeric('gross', { precision: 14, scale: 2 }).notNull(),
  taxAmount: numeric('tax_amount', { precision: 14, scale: 2 }).notNull(),
  /** Taken off what the customer still owed on the original invoice. */
  applied: numeric('applied', { precision: 14, scale: 2 }).notNull(),
  /** The rest: the customer is owed it, and it waits for a decision until resolved. */
  excess: numeric('excess', { precision: 14, scale: 2 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** How a credit note's excess was settled. Append-only. */
export const creditNoteResolutions = pgTable(
  'credit_note_resolutions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    creditNoteId: uuid('credit_note_id')
      .notNull()
      .references(() => creditNotes.id, { onDelete: 'restrict' }),
    /** wallet = moved to the customer's wallet; applied = used against the customer's other invoices. */
    kind: text('kind').$type<'wallet' | 'applied' | 'refund' | 'refund_undone' | 'waived'>().notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    walletEntryId: bigint('wallet_entry_id', { mode: 'number' }),
    applicationId: uuid('application_id'),
    registerId: uuid('register_id'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credit_note_resolutions_cn_idx').on(t.creditNoteId, t.id)],
);

export type ReturnReceiptStatus = 'awaiting_goods' | 'partially_confirmed' | 'confirmed' | 'rejected';
export type ReturnDisposition = 'return_to_stock' | 'quarantine' | 'scrap' | 'return_to_supplier';
export type ReturnCondition = 'good' | 'damaged' | 'expired' | 'wrong_item';

/** Goods expected back because of a credit note. Stock changes only when someone confirms them. */
export const returnReceipts = pgTable(
  'return_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    creditNoteId: uuid('credit_note_id')
      .notNull()
      .references(() => creditNotes.id, { onDelete: 'restrict' }),
    orderId: text('order_id').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    status: text('status').$type<ReturnReceiptStatus>().notNull().default('awaiting_goods'),
    requestedBy: text('requested_by').notNull(),
    closedBy: text('closed_by'),
    closeReasonCode: text('close_reason_code'),
    closeReasonText: text('close_reason_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('return_receipts_company_number_uidx').on(t.companyId, t.number),
    uniqueIndex('return_receipts_credit_note_uidx').on(t.creditNoteId),
    index('return_receipts_status_idx').on(t.companyId, t.status, t.createdAt),
  ],
);

export const returnReceiptLines = pgTable(
  'return_receipt_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => returnReceipts.id, { onDelete: 'cascade' }),
    productId: text('product_id').notNull(),
    description: text('description').notNull(),
    expectedQty: quantity('expected_qty').notNull(),
    receivedQty: quantity('received_qty').notNull().default(0),
    /** What it cost when it was sold (kept with the sale), for the stock-value slice. */
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }),
    /**
     * The unit the goods were sold in (null when sold in the base unit, or in a mix of units): `quantity`
     * is always base units, as on the order line this came from.
     */
    unitId: uuid('unit_id').references(() => unitsOfMeasure.id, { onDelete: 'restrict' }),
    unitCode: text('unit_code'),
    /** Base units in one of that unit, as on the order when it was sold. */
    qtyPerUnit: numeric('qty_per_unit', { precision: 24, scale: 10 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('return_receipt_lines_receipt_idx').on(t.receiptId), index('return_receipt_lines_unit_idx').on(t.unitId), check('return_receipt_lines_qty_chk', sql`${t.receivedQty} >= 0 AND ${t.receivedQty} <= ${t.expectedQty}`)],
);

/** Each act of confirming goods: how many, in what condition, and what was done with them. Append-only. */
export const returnReceiptConfirmations = pgTable(
  'return_receipt_confirmations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => returnReceipts.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => returnReceiptLines.id, { onDelete: 'cascade' }),
    quantity: quantity('quantity').notNull(),
    condition: text('condition').$type<ReturnCondition>().notNull(),
    disposition: text('disposition').$type<ReturnDisposition>().notNull(),
    /** Set when stock was added, so the movement can be traced to this act. */
    stockAdded: boolean('stock_added').notNull().default(false),
    note: text('note'),
    confirmedBy: text('confirmed_by').notNull(),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('return_receipt_confirmations_receipt_idx').on(t.receiptId, t.id)],
);

export type CreditNoteAccountingRow = typeof creditNoteAccounting.$inferSelect;
export type CreditNoteResolutionRow = typeof creditNoteResolutions.$inferSelect;
export type ReturnReceiptRow = typeof returnReceipts.$inferSelect;
export type ReturnReceiptLineRow = typeof returnReceiptLines.$inferSelect;

// ─── Finance F-4: refunds ────────────────────────────────────────────────────────────────

export type RefundStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'rejected' | 'cancelled';
export type RefundSource = 'credit_note_excess' | 'wallet' | 'receipt_unapplied' | 'returned_payout';

/**
 * Money the business pays out to a customer because it owes them. Always made from a source
 * obligation, so it can never be for more than is owed. A refund is a document with a life, not a flag.
 */
/**
 * How fast refunds may be asked for, per company: a customer, a destination (phone or account) and a person can only be
 * refunded, or ask for refunds, so many times and for so much in a window. Past a limit a refund is refused, or held for
 * approval whatever its amount (the fraud signals refunds are known for: one phone paid many times, one person paying out
 * a lot). Off until someone sets it.
 */
export const refundLimits = pgTable(
  'refund_limits',
  {
    companyId: uuid('company_id')
      .primaryKey()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    windowHours: integer('window_hours').notNull().default(24),
    maxPerCustomer: integer('max_per_customer'),
    maxAmountPerCustomer: numeric('max_amount_per_customer', { precision: 14, scale: 2 }),
    maxPerDestination: integer('max_per_destination'),
    maxPerRequester: integer('max_per_requester'),
    maxAmountPerRequester: numeric('max_amount_per_requester', { precision: 14, scale: 2 }),
    /** What happens past a limit: hold the refund for approval, or refuse it. */
    mode: text('mode').$type<'review' | 'refuse'>().notNull().default('review'),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('refund_limits_window_chk', sql`${t.windowHours} BETWEEN 1 AND 720`),
    check('refund_limits_counts_chk', sql`COALESCE(${t.maxPerCustomer}, 1) >= 1 AND COALESCE(${t.maxPerDestination}, 1) >= 1 AND COALESCE(${t.maxPerRequester}, 1) >= 1`),
    check('refund_limits_amounts_chk', sql`COALESCE(${t.maxAmountPerCustomer}, 1) > 0 AND COALESCE(${t.maxAmountPerRequester}, 1) > 0`),
  ],
);

export type RefundLimitsRow = typeof refundLimits.$inferSelect;

export const refundRequests = pgTable(
  'refund_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    sourceKind: text('source_kind').$type<RefundSource>().notNull(),
    /** The credit note, wallet or receipt the money is owed from. */
    sourceId: text('source_id').notNull(),
    /** The order it relates to, when there is one (for the "refunded" status). */
    orderId: text('order_id'),
    currency: text('currency').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /** The rate a refund in another currency is booked at: what its source was carried at when it was approved ("1" otherwise). */
    rate: text('rate').notNull().default('1'),
    status: text('status').$type<RefundStatus>().notNull().default('draft'),
    reasonCode: text('reason_code').notNull(),
    reasonText: text('reason_text'),
    /** How it will be paid: a payment method, and the customer's details as given at the time. */
    paymentMethodId: uuid('payment_method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict' }),
    payoutDetails: jsonb('payout_details').$type<Record<string, string>>().notNull().default({}),
    /** The destination differs from what is on the customer's record (a fraud signal). */
    detailsChanged: boolean('details_changed').notNull().default(false),
    /** Why this refund is held for approval whatever the amount: it went past a velocity limit. Null when it did not. */
    heldForReview: text('held_for_review'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    requestedBy: text('requested_by').notNull(),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** The credit taken out of the customer's account (or wallet) when it was approved. */
    ledgerEntryId: uuid('ledger_entry_id'),
    walletEntryId: bigint('wallet_entry_id', { mode: 'number' }),
    reserveRegisterId: uuid('reserve_register_id'),
    paidFromBankAccountId: uuid('paid_from_bank_account_id').references(() => bankAccounts.id, { onDelete: 'restrict' }),
    /** The payment method the money was paid out through (its bank account and G/L account). */
    paidFromMethodId: uuid('paid_from_method_id').references(() => paymentMethods.id, { onDelete: 'restrict' }),
    payoutReference: text('payout_reference'),
    payoutDate: date('payout_date', { mode: 'string' }),
    paidBy: text('paid_by'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** Seen on a bank statement (set when a statement line is matched to the payout). */
    bankMatchedAt: timestamp('bank_matched_at', { withTimezone: true }),
    payoutRegisterId: uuid('payout_register_id'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('refund_requests_company_number_uidx').on(t.companyId, t.number),
    uniqueIndex('refund_requests_idem_uidx').on(t.companyId, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('refund_requests_status_idx').on(t.companyId, t.status, t.createdAt),
    index('refund_requests_source_idx').on(t.sourceKind, t.sourceId),
    index('refund_requests_customer_idx').on(t.customerId, t.createdAt),
    index('refund_requests_requester_idx').on(t.companyId, t.requestedBy, t.createdAt),
    check('refund_requests_amount_chk', sql`${t.amount} > 0`),
  ],
);

/** Every step of a refund's life: who, what, why, from where. Append-only. */
export const refundEvents = pgTable(
  'refund_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refundRequests.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('refund_events_refund_idx').on(t.refundId, t.id)],
);

export type RefundRequestRow = typeof refundRequests.$inferSelect;
export type RefundEventRow = typeof refundEvents.$inferSelect;

// ─── Finance: credit adjustments, returned payouts and bank payment files ───────────────────

export type CreditAdjustmentKind = 'waive_excess' | 'wallet_increase' | 'wallet_decrease' | 'wallet_expiry';
export type CreditAdjustmentStatus = 'requested' | 'pending_approval' | 'applied' | 'rejected' | 'cancelled';

/**
 * Changing what a customer is owed without paying them: giving up an excess, adding to or taking
 * from a wallet, or a lapsed balance. Asked for by one person, decided by another, and kept for ever.
 */
export const creditAdjustments = pgTable(
  'credit_adjustments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    kind: text('kind').$type<CreditAdjustmentKind>().notNull(),
    status: text('status').$type<CreditAdjustmentStatus>().notNull().default('requested'),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** What is being reduced: a credit note's excess, an unapplied receipt or a wallet. */
    sourceKind: text('source_kind').$type<RefundSource>(),
    sourceId: text('source_id'),
    currency: text('currency').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    reasonCode: text('reason_code').notNull(),
    reasonText: text('reason_text'),
    requestedBy: text('requested_by').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    registerId: uuid('register_id'),
    walletEntryId: bigint('wallet_entry_id', { mode: 'number' }),
    ledgerEntryId: uuid('ledger_entry_id'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_adjustments_company_number_uidx').on(t.companyId, t.number),
    uniqueIndex('credit_adjustments_idem_uidx').on(t.companyId, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('credit_adjustments_status_idx').on(t.companyId, t.status, t.createdAt),
    index('credit_adjustments_source_idx').on(t.sourceKind, t.sourceId),
    index('credit_adjustments_customer_idx').on(t.customerId, t.createdAt),
    check('credit_adjustments_amount_chk', sql`${t.amount} > 0`),
  ],
);

/** Every step of a credit adjustment: who, what, why, from where. Append-only. */
export const creditAdjustmentEvents = pgTable(
  'credit_adjustment_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    adjustmentId: uuid('adjustment_id')
      .notNull()
      .references(() => creditAdjustments.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credit_adjustment_events_adjustment_idx').on(t.adjustmentId, t.id)],
);

export type CreditAdjustmentRow = typeof creditAdjustments.$inferSelect;
export type CreditAdjustmentEventRow = typeof creditAdjustmentEvents.$inferSelect;

/**
 * Money a bank or M-Pesa sent back after a refund was paid. The customer is owed it again, so a new
 * refund (approved, money already set aside) is made for it, to be paid to corrected details.
 */
export const refundReturns = pgTable(
  'refund_returns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refundRequests.id, { onDelete: 'restrict' }),
    replacementRefundId: uuid('replacement_refund_id').references(() => refundRequests.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    returnedOn: date('returned_on', { mode: 'string' }).notNull(),
    reference: text('reference').notNull(),
    reasonCode: text('reason_code').notNull(),
    reasonText: text('reason_text'),
    /** The method whose bank account the money came back into. */
    receivedIntoMethodId: uuid('received_into_method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict' }),
    registerId: uuid('register_id'),
    recordedBy: text('recorded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('refund_returns_refund_idx').on(t.refundId),
    uniqueIndex('refund_returns_reference_uidx').on(t.companyId, t.receivedIntoMethodId, t.reference),
    check('refund_returns_amount_chk', sql`${t.amount} > 0`),
  ],
);

export type RefundFileFormat = 'csv' | 'pain001';
export type RefundFileStatus = 'generated' | 'confirmed' | 'cancelled';

/** A file of bank-transfer refunds handed to the bank in one go. The text is kept exactly as it was sent. */
export const refundPaymentFiles = pgTable(
  'refund_payment_files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    /** The method the money leaves through (its bank account is the debit side). */
    methodId: uuid('method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict' }),
    format: text('format').$type<RefundFileFormat>().notNull(),
    currency: text('currency').notNull(),
    total: numeric('total', { precision: 14, scale: 2 }).notNull(),
    itemCount: integer('item_count').notNull(),
    status: text('status').$type<RefundFileStatus>().notNull().default('generated'),
    content: text('content').notNull(),
    contentSha256: text('content_sha256').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    downloads: integer('downloads').notNull().default(0),
    confirmedBy: text('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    bankReference: text('bank_reference'),
    cancelledBy: text('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    uniqueIndex('refund_payment_files_company_number_uidx').on(t.companyId, t.number),
    index('refund_payment_files_status_idx').on(t.companyId, t.status, t.createdAt),
  ],
);

/** One refund inside a payment file. While the file stands, the refund is in no other file. */
export const refundPaymentFileItems = pgTable(
  'refund_payment_file_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => refundPaymentFiles.id, { onDelete: 'restrict' }),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refundRequests.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /** Where the money was told to go, as it was when the file was made. */
    beneficiary: jsonb('beneficiary').$type<Record<string, string>>().notNull(),
    endToEndId: text('end_to_end_id').notNull(),
    /** in_file while the file stands; paid when the bank confirmed it; released when the file was cancelled. */
    state: text('state').$type<'in_file' | 'paid' | 'released'>().notNull().default('in_file'),
  },
  (t) => [
    index('refund_payment_file_items_file_idx').on(t.fileId),
    uniqueIndex('refund_payment_file_items_one_live_uidx').on(t.refundId).where(sql`${t.state} = 'in_file'`),
  ],
);

export type RefundReturnRow = typeof refundReturns.$inferSelect;
export type RefundPaymentFileRow = typeof refundPaymentFiles.$inferSelect;
export type RefundPaymentFileItemRow = typeof refundPaymentFileItems.$inferSelect;

/**
 * Sales events waiting to reach the general ledger. A sale is saved first and posted a moment
 * later, so a set-up mistake in the accounts can never stop a customer from buying: the event
 * waits here, visible, and is retried until someone fixes the setup.
 */
export const financeSalesPostings = pgTable(
  'finance_sales_postings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<SalesPostingKind>().notNull(),
    /** The order id (invoice, cash sale) or the customer ledger entry id (credit payment, rebate credit). */
    subjectId: text('subject_id').notNull(),
    /** The date the event happened; decides whether it is on or after the go-live date. */
    eventDate: date('event_date', { mode: 'string' }).notNull(),
    status: text('status').$type<SalesPostingStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    registerId: uuid('register_id'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('finance_sales_postings_subject_uidx').on(t.companyId, t.kind, t.subjectId),
    index('finance_sales_postings_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} IN ('pending','failed')`),
  ],
);
export type FinanceSalesPostingRow = typeof financeSalesPostings.$inferSelect;

export type BankAccountRow = typeof bankAccounts.$inferSelect;
export type PaymentMethodRow = typeof paymentMethods.$inferSelect;
export type BankLedgerEntryRow = typeof bankLedgerEntries.$inferSelect;
export type CustomerReceiptRow = typeof customerReceipts.$inferSelect;
export type ReceiptEventRow = typeof receiptEvents.$inferSelect;
export type CustomerDetailedEntryRow = typeof customerDetailedEntries.$inferSelect;
export type FinanceAttachmentRow = typeof financeAttachments.$inferSelect;

// ─── Pricing ─────────────────────────────────────────────────────────────────

/**
 * A named group of customers for pricing (Wholesale A, VIP, Government). A customer may be in
 * several; the highest-priority group is the one that prices their sales.
 */
export const customerGroups = pgTable(
  'customer_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Higher wins when a customer is in several groups. */
    priority: integer('priority').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('customer_groups_company_code_uidx').on(t.companyId, t.code)],
);

export const customerGroupMembers = pgTable(
  'customer_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => customerGroups.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    addedBy: text('added_by'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.customerId] }),
    index('customer_group_members_customer_idx').on(t.customerId),
  ],
);

/**
 * A named set of products chosen by hand (a supplier's range, a promotion line), so a price floor
 * can be set for all of them at once. A product may be in several.
 */
export const productGroups = pgTable(
  'product_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('product_groups_company_code_uidx').on(t.companyId, t.code)],
);

export const productGroupMembers = pgTable(
  'product_group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => productGroups.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    addedBy: text('added_by'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.productId] }),
    index('product_group_members_product_idx').on(t.productId),
  ],
);

/**
 * The lowest a product may be sold for: its cost plus a markup. One rule per scope; the most
 * specific rule that applies to a product wins (product, then a group or brand, then its category
 * or the nearest category above it, then the company default).
 */
export const priceFloorRules = pgTable(
  'price_floor_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    scopeType: text('scope_type').$type<FloorScopeType>().notNull(),
    /** Product id, product group id, brand, or category id. Empty for the company default. */
    scopeRef: text('scope_ref').notNull().default(''),
    /** Floor = cost x (1 + markup / 100). */
    markupPercent: numeric('markup_percent', { precision: 8, scale: 3 }).notNull(),
    /** 'approval': a sale below it needs approval. 'block': it is refused. */
    enforcement: text('enforcement').$type<FloorEnforcement>().notNull().default('approval'),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('price_floor_rules_scope_uidx').on(t.companyId, t.scopeType, t.scopeRef),
    check('price_floor_rules_markup_chk', sql`${t.markupPercent} >= 0`),
  ],
);

/**
 * How far below the list price a person may take a price (a typed price, a line discount) before
 * the sale needs approval. Per role; `*` is the default for roles without their own limit. Where
 * a person holds several roles the most generous limit applies. No rows means no limit.
 */
export const priceOverrideLimits = pgTable(
  'price_override_limits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    roleKey: text('role_key').notNull(),
    maxPercent: numeric('max_percent', { precision: 6, scale: 3 }).notNull(),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('price_override_limits_role_uidx').on(t.companyId, t.roleKey),
    check('price_override_limits_pct_chk', sql`${t.maxPercent} >= 0 and ${t.maxPercent} <= 100`),
  ],
);

/**
 * A discount rule: a reduction on a line or on a whole order, with who it is for, what it covers,
 * when it runs, what it gives, and how it combines with others. Changing one bumps `version`;
 * documents record the version they used.
 */
export const discountRules = pgTable(
  'discount_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind').$type<DiscountKind>().notNull(),
    status: text('status').$type<DiscountStatus>().notNull().default('draft'),
    /** Set while activation waits on an approval workflow. */
    approvalStatus: text('approval_status').notNull().default('none'),
    version: integer('version').notNull().default(1),
    /** Higher wins a tie. */
    priority: integer('priority').notNull().default(0),
    stacking: text('stacking').$type<Stacking>().notNull().default('exclusive'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    schedule: jsonb('schedule').$type<DiscountSchedule>().notNull().default({}),
    scopes: jsonb('scopes').$type<Scopes>().notNull().default({}),
    target: jsonb('target').$type<DiscountTarget>().notNull().default({}),
    conditions: jsonb('conditions').$type<DiscountConditions>().notNull().default({}),
    /** What a line or order rule gives. Empty for a mix or gift rule, which is described by `mix`. */
    reward: jsonb('reward').$type<DiscountReward>(),
    /** The deal, for a mix or gift rule. */
    mix: jsonb('mix').$type<MixConfig>(),
    requiresCoupon: boolean('requires_coupon').notNull().default(false),
    limits: jsonb('limits').$type<DiscountLimits>().notNull().default({}),
    /** Check the limits exactly (one at a time) instead of allowing a small overshoot in a burst. */
    strictLimits: boolean('strict_limits').notNull().default(false),
    appliesToContract: boolean('applies_to_contract').notNull().default(false),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('discount_rules_company_code_uidx').on(t.companyId, t.code),
    index('discount_rules_company_status_idx').on(t.companyId, t.status),
  ],
);

/** A code a customer gives to unlock a coupon rule, with its own validity and limits. */
export const discountCoupons = pgTable(
  'discount_coupons',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => discountRules.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    maxUses: integer('max_uses'),
    maxUsesPerCustomer: integer('max_uses_per_customer'),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('discount_coupons_company_code_uidx').on(t.companyId, t.code),
    index('discount_coupons_rule_idx').on(t.ruleId),
  ],
);

/**
 * Every use of a rule by a document. Append-only: a cancelled document adds a reversal, never
 * edits or deletes. One use and one reversal per document and rule, so committing twice is safe.
 */
export const discountUsage = pgTable(
  'discount_usage',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => discountRules.id, { onDelete: 'restrict' }),
    ruleVersion: integer('rule_version').notNull(),
    couponId: uuid('coupon_id').references(() => discountCoupons.id, { onDelete: 'restrict' }),
    couponCode: text('coupon_code'),
    customerId: uuid('customer_id'),
    documentType: text('document_type').notNull(),
    documentId: text('document_id').notNull(),
    kind: text('kind').$type<'use' | 'reversal'>().notNull().default('use'),
    /** What was given (positive), or given back (negative on a reversal). */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('discount_usage_document_uidx').on(t.ruleId, t.documentType, t.documentId, t.kind),
    index('discount_usage_customer_idx').on(t.ruleId, t.customerId),
    index('discount_usage_coupon_idx').on(t.couponId, t.customerId),
    index('discount_usage_occurred_idx').on(t.companyId, t.occurredAt),
  ],
);

/**
 * How many times each rule has been used and what it has given away, split into a few shards so
 * many orders at once do not queue on one row. The total is the sum of the shards.
 */
export const discountCounters = pgTable(
  'discount_counters',
  {
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => discountRules.id, { onDelete: 'cascade' }),
    shard: integer('shard').notNull(),
    uses: integer('uses').notNull().default(0),
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull().default('0'),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.shard] })],
);

/**
 * A kit or hamper: one product that is really several. Sold as one line; when the sale is saved
 * it becomes one line per component, each with its share of the price.
 */
export const productKits = pgTable(
  'product_kits',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** The product that is sold as the kit. Its own stock is not used: the components' is. */
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    allocation: text('allocation').$type<KitAllocation>().notNull().default('list_price'),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('product_kits_product_uidx').on(t.productId)],
);

export const productKitComponents = pgTable(
  'product_kit_components',
  {
    kitId: uuid('kit_id')
      .notNull()
      .references(() => productKits.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    quantity: quantity('quantity').notNull().default(1),
    /** For the "shares you set" method. */
    weight: numeric('weight', { precision: 12, scale: 4 }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.kitId, t.productId] }),
    index('product_kit_components_product_idx').on(t.productId),
    check('product_kit_components_qty_chk', sql`${t.quantity} > 0`),
  ],
);

/** How much each scope dimension counts towards a price list's specificity. Per company. */
export const priceSpecificityWeights = pgTable(
  'price_specificity_weights',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** A scope dimension, or 'contract'. */
    dimension: text('dimension').notNull(),
    weight: integer('weight').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.dimension] })],
);

/**
 * A price list header. Lines are effective-dated rows (never edited, only replaced), so a list of
 * millions of lines is changed without copying. Changing the header bumps `version`; documents
 * keep the version and line they were priced from in their trace.
 */
export const priceLists = pgTable(
  'price_lists',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind').$type<PriceListKind>().notNull().default('list'),
    currency: text('currency').notNull(),
    taxInclusive: boolean('tax_inclusive').notNull().default(true),
    quantityMode: text('quantity_mode').$type<QuantityMode>().notNull().default('all_units'),
    priority: integer('priority').notNull().default(0),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    scopes: jsonb('scopes').$type<Scopes>().notNull().default({}),
    status: text('status').$type<PriceListStatus>().notNull().default('draft'),
    /** Set when activation is waiting on an approval workflow. */
    approvalStatus: text('approval_status').notNull().default('none'),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('price_lists_company_code_uidx').on(t.companyId, t.code),
    index('price_lists_company_status_idx').on(t.companyId, t.status),
  ],
);

/**
 * One price for a product in a list, in force from `valid_from` until `valid_to`. Changing a price
 * closes the open row and adds a new one; the old one stays so a past sale can be explained.
 */
export const priceListLines = pgTable(
  'price_list_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    price: numeric('price', { precision: 14, scale: 4 }).notNull(),
    tiers: jsonb('tiers').$type<Tier[]>().notNull().default([]),
    /** A soft floor: selling below it is flagged, and needs a decision elsewhere. */
    floorPrice: numeric('floor_price', { precision: 14, scale: 4 }),
    /** While in the future, this price cannot be replaced without an explicit override. */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    reasonCode: text('reason_code'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('price_list_lines_product_idx').on(t.productId, t.priceListId, t.validFrom),
    index('price_list_lines_list_product_idx').on(t.priceListId, t.productId, t.validFrom),
    // At most one open-ended price per product in a list; replaced rows are always closed.
    uniqueIndex('price_list_lines_open_uidx')
      .on(t.priceListId, t.productId)
      .where(sql`${t.validTo} is null`),
  ],
);

/**
 * A rebate programme: money given back after the fact on what a customer buys over a period, at a
 * rate that steps up with the total. Editing a programme in force is not allowed; pause it first.
 */
export const rebatePrograms = pgTable(
  'rebate_programs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status')
      .$type<'draft' | 'active' | 'paused' | 'retired'>()
      .notNull()
      .default('draft'),
    version: integer('version').notNull().default(1),
    period: text('period').$type<'month' | 'quarter' | 'year'>().notNull(),
    tierMode: text('tier_mode').$type<'all_sales' | 'incremental'>().notNull().default('all_sales'),
    tiers: jsonb('tiers').$type<RebateTier[]>().notNull().default([]),
    scopes: jsonb('scopes').$type<Scopes>().notNull().default({}),
    target: jsonb('target').$type<DiscountTarget>().notNull().default({}),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp('valid_to', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rebate_programs_company_code_uidx').on(t.companyId, t.code),
    index('rebate_programs_company_status_idx').on(t.companyId, t.status),
  ],
);

/** What each order added to a customer's total for a programme period. Append-only. */
export const rebateAccruals = pgTable(
  'rebate_accruals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => rebatePrograms.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull(),
    periodKey: text('period_key').notNull(),
    sourceType: text('source_type').$type<'order' | 'order_cancel' | 'credit_note'>().notNull(),
    sourceId: text('source_id').notNull(),
    /** Net purchases counted (negative when taken back). */
    basisAmount: numeric('basis_amount', { precision: 16, scale: 2 }).notNull(),
    programVersion: integer('program_version').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rebate_accruals_source_uidx').on(t.programId, t.sourceType, t.sourceId),
    index('rebate_accruals_customer_idx').on(t.programId, t.customerId, t.periodKey),
  ],
);

/** The running total per programme, customer and period: the sum of the accruals, kept in step with them. */
export const rebateBalances = pgTable(
  'rebate_balances',
  {
    programId: uuid('program_id')
      .notNull()
      .references(() => rebatePrograms.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull(),
    periodKey: text('period_key').notNull(),
    basis: numeric('basis', { precision: 16, scale: 2 }).notNull().default('0'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.programId, t.customerId, t.periodKey] }),
    index('rebate_balances_period_idx').on(t.programId, t.periodKey),
  ],
);

/** A rebate paid out to a customer for a finished period, through an approval. */
export const rebateSettlements = pgTable(
  'rebate_settlements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => rebatePrograms.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    periodKey: text('period_key').notNull(),
    basis: numeric('basis', { precision: 16, scale: 2 }).notNull(),
    percent: numeric('percent', { precision: 9, scale: 4 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    status: text('status')
      .$type<'pending' | 'settled' | 'rejected' | 'cancelled'>()
      .notNull()
      .default('pending'),
    approvalStatus: text('approval_status')
      .$type<'none' | 'pending' | 'approved' | 'rejected' | 'draft'>()
      .notNull()
      .default('none'),
    /** The credit posted to the customer's account. */
    creditRef: text('credit_ref'),
    requestedBy: text('requested_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    // A programme pays a customer once for a period (a refused or cancelled one can be asked again).
    uniqueIndex('rebate_settlements_period_uidx')
      .on(t.programId, t.customerId, t.periodKey)
      .where(sql`${t.status} in ('pending', 'settled')`),
    index('rebate_settlements_company_idx').on(t.companyId, t.status),
  ],
);

/** The company's loyalty programme (one per company) and its rules. */
export const loyaltyPrograms = pgTable(
  'loyalty_programs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    name: text('name').notNull().default('Loyalty'),
    status: text('status').$type<'active' | 'paused'>().notNull().default('paused'),
    version: integer('version').notNull().default(1),
    pointsPer100: numeric('points_per_100', { precision: 9, scale: 4 }).notNull(),
    pointValue: numeric('point_value', { precision: 9, scale: 4 }).notNull(),
    minRedeemPoints: integer('min_redeem_points').notNull().default(1),
    maxRedeemPercent: numeric('max_redeem_percent', { precision: 5, scale: 2 })
      .notNull()
      .default('100'),
    expiryMonths: integer('expiry_months'),
    tiers: jsonb('tiers').$type<LoyaltyTier[]>().notNull().default([]),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('loyalty_programs_company_uidx').on(t.companyId)],
);

/** Each customer's points: the running balance and what was ever earned (for the tier). */
export const loyaltyAccounts = pgTable(
  'loyalty_accounts',
  {
    customerId: uuid('customer_id')
      .primaryKey()
      .references(() => customers.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    balance: bigint('balance', { mode: 'number' }).notNull().default(0),
    lifetimeEarned: bigint('lifetime_earned', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('loyalty_accounts_balance_chk', sql`${t.balance} >= 0`)],
);

/** Every movement of points. Append-only: a mistake is corrected by a later entry. */
export const loyaltyLedger = pgTable(
  'loyalty_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    kind: text('kind')
      .$type<'earn' | 'redeem' | 'reverse_earn' | 'reverse_redeem' | 'adjust' | 'expire'>()
      .notNull(),
    /** Positive adds points, negative takes them away. */
    points: bigint('points', { mode: 'number' }).notNull(),
    orderId: text('order_id'),
    /** For earned points: when they lapse, if the programme says so. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** For earned points: how many are still unspent (kept on the earning row only). */
    reasonCode: text('reason_code'),
    note: text('note'),
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('loyalty_ledger_customer_idx').on(t.customerId, t.createdAt),
    index('loyalty_ledger_order_idx').on(t.orderId),
    uniqueIndex('loyalty_ledger_order_kind_uidx')
      .on(t.orderId, t.kind, t.customerId)
      .where(sql`${t.orderId} is not null and ${t.kind} in ('earn', 'redeem', 'reverse_redeem')`),
  ],
);

/** A gift card: prepaid value that is spent as a payment, never as a price change. */
export const giftCards = pgTable(
  'gift_cards',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    initialValue: numeric('initial_value', { precision: 14, scale: 2 }).notNull(),
    balance: numeric('balance', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('KES'),
    /** What one unit of the card's currency was worth in the books' currency when it was issued ("1" in that currency): the card is carried at it. */
    rate: text('rate').notNull().default('1'),
    status: text('status').$type<'active' | 'blocked'>().notNull().default('active'),
    /** How the card came to exist: bought with money, handed out free, or (cards from before the books) not said. */
    fundedBy: text('funded_by').$type<'sold' | 'complimentary' | 'unspecified'>().notNull().default('unspecified'),
    /** For a card that was sold: the payment method the money came in through. */
    fundingMethodId: uuid('funding_method_id').references(() => paymentMethods.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    note: text('note'),
    issuedBy: text('issued_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('gift_cards_code_uidx').on(t.companyId, t.code),
    index('gift_cards_company_idx').on(t.companyId, t.createdAt),
    check('gift_cards_balance_chk', sql`${t.balance} >= 0`),
  ],
);

/** Every movement on a card. Append-only. */
export const giftCardLedger = pgTable(
  'gift_card_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    cardId: uuid('card_id')
      .notNull()
      .references(() => giftCards.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<'issue' | 'redeem' | 'reverse' | 'adjust'>().notNull(),
    /** Positive adds value, negative spends it. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    orderId: text('order_id'),
    reasonCode: text('reason_code'),
    note: text('note'),
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('gift_card_ledger_card_idx').on(t.cardId, t.createdAt),
    index('gift_card_ledger_order_idx').on(t.orderId),
  ],
);

/** What of an order was paid with a gift card or points. Append-only; a cancelled order reverses it elsewhere. */
export const orderTenders = pgTable(
  'order_tenders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<'gift_card' | 'loyalty_points' | 'wallet'>().notNull(),
    /** The card, or the customer whose points were spent. */
    reference: text('reference').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    points: bigint('points', { mode: 'number' }),
    /** What the points were worth in the books' currency when they were spent (an order in another currency). */
    baseAmount: numeric('base_amount', { precision: 18, scale: 4 }),
    actor: text('actor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('order_tenders_order_idx').on(t.orderId),
    index('order_tenders_created_idx').on(t.createdAt),
  ],
);

export type RebateProgramRow = typeof rebatePrograms.$inferSelect;
export type RebateSettlementRow = typeof rebateSettlements.$inferSelect;
export type LoyaltyProgramRow = typeof loyaltyPrograms.$inferSelect;
export type LoyaltyAccountRow = typeof loyaltyAccounts.$inferSelect;
export type GiftCardRow = typeof giftCards.$inferSelect;

// ── Core Finance (F-0): chart of accounts, periods, posting setup, journals, ledgers ───────

/** One row per company: the finance basics that everything else reads. */
export type InventoryEventKind = 'movement' | 'revaluation';
export type InventoryEventStatus = 'pending' | 'posted' | 'failed' | 'skipped';

/**
 * A change in the value of stock waiting to reach the general ledger: a movement of goods at the cost they had,
 * or a change of cost on the goods in hand. Written by the database itself the moment stock moves, so no way of
 * changing stock can be missed; the books follow within a minute and retry until the setup is right.
 */
export const financeInventoryEvents = pgTable(
  'finance_inventory_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<InventoryEventKind>().notNull(),
    /** The stock movement it came from (movements only); a movement posts once. */
    movementId: text('movement_id'),
    productId: text('product_id').notNull(),
    changeType: text('change_type').notNull(),
    /** Units gained (positive) or lost (negative); for a revaluation, the units on hand. */
    quantity: quantity('quantity').notNull(),
    /** The cost per unit the goods had when they moved; for a revaluation, the change in cost per unit. */
    unitCost: numeric('unit_cost', { precision: 14, scale: 2 }).notNull(),
    /**
     * Signed value in cents-exact money: quantity × unit cost, with the sub-cent part carried from one change of a product to the
     * next (see `finance_inventory_totals`), so a product's values always add up to its units × cost to the cent.
     */
    value: numeric('value', { precision: 20, scale: 2 }).notNull(),
    eventDate: date('event_date', { mode: 'string' }).notNull(),
    status: text('status').$type<InventoryEventStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    registerId: uuid('register_id'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    postedAt: timestamp('posted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('finance_inventory_events_movement_uidx').on(t.companyId, t.movementId).where(sql`${t.movementId} IS NOT NULL`),
    index('finance_inventory_events_due_idx').on(t.nextAttemptAt).where(sql`${t.status} IN ('pending', 'failed')`),
    index('finance_inventory_events_status_idx').on(t.companyId, t.status, t.id),
  ],
);

/**
 * What each product is worth in the books, exactly. Units have three decimals and costs two, so one change is worth up to five
 * decimals; writing every change down to the cent would drift from units × cost by a little each time. Instead each change is
 * written as the difference between the rounded running totals, so the books for a product are always units × cost to the cent.
 * Kept up by the database triggers in the same transaction as the stock movement.
 */
export const financeInventoryTotals = pgTable(
  'finance_inventory_totals',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    productId: text('product_id').notNull(),
    /** Units × cost per unit since the books started for the product, with no rounding. */
    exactTotal: numeric('exact_total', { precision: 30, scale: 5 }).notNull(),
    /** What has been written down, to the cent: always the exact total rounded. */
    bookedTotal: numeric('booked_total', { precision: 20, scale: 2 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.productId] })],
);

export type FinanceInventoryEventRow = typeof financeInventoryEvents.$inferSelect;

// ─── Bank statements: matching rules and feeds ───────────────────────────────────────────────

/**
 * How lines on a statement are matched to what we recorded. One row for the whole company (no account) and, if wanted, one
 * for a single bank account, which wins. With no row the standard rules apply.
 */
export const bankMatchRules = pgTable(
  'bank_match_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id').references(() => bankAccounts.id, { onDelete: 'cascade' }),
    rules: jsonb('rules').$type<Record<string, unknown>>().notNull(),
    updatedBy: text('updated_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bank_match_rules_scope_uidx').on(t.companyId, sql`coalesce(${t.bankAccountId}::text, '')`)],
);

/**
 * A bank (or a script, or an aggregator) that pushes statement lines to us. The address carries a secret that is kept only as
 * a fingerprint, so it is shown once, when made.
 */
export const bankFeeds = pgTable(
  'bank_feeds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    secretHash: text('secret_hash').notNull(),
    /** The last four characters of the secret, so a person can tell which one an address carries. */
    secretHint: text('secret_hint').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    lastReceivedAt: timestamp('last_received_at', { withTimezone: true }),
    lastLines: integer('last_lines').notNull().default(0),
    receivedCount: integer('received_count').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [uniqueIndex('bank_feeds_account_uidx').on(t.bankAccountId)],
);

export type BankMatchRulesRow = typeof bankMatchRules.$inferSelect;
export type BankFeedRow = typeof bankFeeds.$inferSelect;

export const financeSettings = pgTable('finance_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companySettings.id, { onDelete: 'cascade' }),
  baseCurrency: text('base_currency').notNull(),
  chartTemplate: text('chart_template'),
  chartAppliedAt: timestamp('chart_applied_at', { withTimezone: true }),
  /** Company-wide posting window (inclusive). Null = no limit on that side. */
  postingFrom: date('posting_from', { mode: 'string' }),
  postingTo: date('posting_to', { mode: 'string' }),
  /**
   * From this date, receipts (and, when released, invoices) post to the general ledger. Null
   * keeps the receivables sub-ledger and bank ledger running without touching the GL, so a
   * company can set everything up and check it before the books start (like a go-live date).
   */
  salesGlGoLive: date('sales_gl_go_live', { mode: 'string' }),
  /** The customer posting group a customer without one uses. */
  defaultCustomerGroup: text('default_customer_group').notNull().default('DOMESTIC'),
  /**
   * From this date stock movements post to the general ledger at cost (Dr/Cr inventory against cost of sales,
   * the adjustment account or the receipts clearing account). Null keeps stock out of the books.
   */
  inventoryGlGoLive: date('inventory_gl_go_live', { mode: 'string' }),
  /** The business and product groups a sale uses until customers and products carry their own. */
  defaultBusinessGroup: text('default_business_group').notNull().default('DOMESTIC'),
  defaultProductGroup: text('default_product_group').notNull().default('GOODS'),
  /** Where the tax charged on sales is owed (output VAT or sales tax). */
  outputTaxAccountId: uuid('output_tax_account_id').references((): AnyPgColumn => glAccounts.id, {
    onDelete: 'restrict',
  }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const glAccounts = pgTable(
  'gl_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    no: text('no').notNull(),
    name: text('name').notNull(),
    type: text('type')
      .$type<'posting' | 'heading' | 'begin_total' | 'end_total' | 'total'>()
      .notNull(),
    category: text('category').$type<
      'assets' | 'liabilities' | 'equity' | 'income' | 'cost_of_sales' | 'expense'
    >(),
    subcategory: text('subcategory'),
    normalBalance: text('normal_balance').$type<'debit' | 'credit'>().notNull(),
    directPosting: boolean('direct_posting').notNull().default(true),
    /** engine_only = a control account: only its sub-ledger may post to it. */
    postingSource: text('posting_source').$type<'manual' | 'engine_only'>().notNull().default('manual'),
    blocked: boolean('blocked').notNull().default(false),
    /** "any", or the one currency this account may carry. */
    currencyPolicy: text('currency_policy').notNull().default('any'),
    dimensionRule: text('dimension_rule')
      .$type<'none' | 'required' | 'forbidden'>()
      .notNull()
      .default('none'),
    totaling: text('totaling'),
    indent: integer('indent').notNull().default(0),
    /** Set once the account has been posted to: number, type and currency policy freeze. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('gl_accounts_company_no_uidx').on(t.companyId, t.no),
    index('gl_accounts_company_type_idx').on(t.companyId, t.type),
  ],
);

export const fiscalYears = pgTable(
  'fiscal_years',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    shape: text('shape').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fiscal_years_company_code_uidx').on(t.companyId, t.code),
    uniqueIndex('fiscal_years_company_start_uidx').on(t.companyId, t.startsOn),
    check('fiscal_years_dates_chk', sql`${t.endsOn} >= ${t.startsOn}`),
  ],
);

export const accountingPeriods = pgTable(
  'accounting_periods',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id, { onDelete: 'cascade' }),
    no: integer('no').notNull(),
    name: text('name').notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    status: text('status')
      .$type<'open' | 'soft_closed' | 'closed' | 'locked'>()
      .notNull()
      .default('open'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    statusChangedBy: text('status_changed_by'),
  },
  (t) => [
    uniqueIndex('accounting_periods_company_start_uidx').on(t.companyId, t.startsOn),
    uniqueIndex('accounting_periods_year_no_uidx').on(t.fiscalYearId, t.no),
    index('accounting_periods_company_dates_idx').on(t.companyId, t.startsOn, t.endsOn),
    check('accounting_periods_dates_chk', sql`${t.endsOn} >= ${t.startsOn}`),
  ],
);

export const businessPostingGroups = pgTable(
  'business_posting_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('business_posting_groups_company_code_uidx').on(t.companyId, t.code)],
);

export const productPostingGroups = pgTable(
  'product_posting_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('product_posting_groups_company_code_uidx').on(t.companyId, t.code)],
);

/** Business group × product group -> accounts. Effective-dated: the newest row in force wins. */
export const generalPostingSetup = pgTable(
  'general_posting_setup',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    businessGroupId: uuid('business_group_id')
      .notNull()
      .references(() => businessPostingGroups.id, { onDelete: 'restrict' }),
    productGroupId: uuid('product_group_id')
      .notNull()
      .references(() => productPostingGroups.id, { onDelete: 'restrict' }),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    effectiveTo: date('effective_to', { mode: 'string' }),
    salesAccountId: uuid('sales_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    salesReturnsAccountId: uuid('sales_returns_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    salesDiscountAccountId: uuid('sales_discount_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    cogsAccountId: uuid('cogs_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    inventoryAdjustmentAccountId: uuid('inventory_adjustment_account_id').references(
      () => glAccounts.id,
      { onDelete: 'restrict' },
    ),
    /** The stock on hand, at cost: the asset that sales draw down and receipts build up. */
    inventoryAccountId: uuid('inventory_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    /** Where stock received but not yet invoiced waits (the other side of a stock receipt). */
    inventoryClearingAccountId: uuid('inventory_clearing_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('general_posting_setup_uidx').on(
      t.businessGroupId,
      t.productGroupId,
      t.effectiveFrom,
    ),
    index('general_posting_setup_company_idx').on(t.companyId),
  ],
);

export const customerPostingGroups = pgTable(
  'customer_posting_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    receivablesAccountId: uuid('receivables_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    customerDepositsAccountId: uuid('customer_deposits_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    refundsPayableAccountId: uuid('refunds_payable_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    paymentDiscountAccountId: uuid('payment_discount_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    writeOffAccountId: uuid('write_off_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    roundingAccountId: uuid('rounding_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    fxGainAccountId: uuid('fx_gain_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    fxLossAccountId: uuid('fx_loss_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    serviceChargeAccountId: uuid('service_charge_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    /** Cost of a rebate credited to a customer's account. */
    rebateExpenseAccountId: uuid('rebate_expense_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    /** What is owed to holders of gift cards, debited when a card pays for a sale. */
    giftCardLiabilityAccountId: uuid('gift_card_liability_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    /** What is owed for loyalty points, debited when points pay for a sale. */
    loyaltyProvisionAccountId: uuid('loyalty_provision_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    /** Income when credit a customer was owed is given up, lapses or is taken off. */
    creditForfeitAccountId: uuid('credit_forfeit_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
    /** Cost when credit is added to a customer's wallet by hand (goodwill, correction). */
    creditAdjustmentAccountId: uuid('credit_adjustment_account_id').references(() => glAccounts.id, {
      onDelete: 'restrict',
    }),
  },
  (t) => [uniqueIndex('customer_posting_groups_company_code_uidx').on(t.companyId, t.code)],
);

/** A named place to prepare journal lines. Lines are drafts until posted, then deleted. */
export const journalBatches = pgTable(
  'journal_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('journal_batches_company_code_uidx').on(t.companyId, t.code)],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => journalBatches.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    documentNo: text('document_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'restrict' }),
    description: text('description'),
    debit: numeric('debit', { precision: 20, scale: 4 }).notNull().default('0'),
    credit: numeric('credit', { precision: 20, scale: 4 }).notNull().default('0'),
    currency: text('currency').notNull(),
    rate: text('rate').notNull().default('1'),
    dimensionSetId: uuid('dimension_set_id'),
    createdBy: text('created_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('journal_lines_batch_idx').on(t.batchId, t.lineNo),
    check('journal_lines_one_side_chk', sql`(${t.debit} = 0) <> (${t.credit} = 0)`),
  ],
);

/** The head of one hash chain: locked while a register is appended to it. */
export const ledgerRegisterChains = pgTable(
  'ledger_register_chains',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    chainKey: text('chain_key').notNull(),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastHash: text('last_hash').notNull(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.chainKey] })],
);

/** One row per posting run. Append-only. */
export const ledgerRegisters = pgTable(
  'ledger_registers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    chainKey: text('chain_key').notNull(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    documentType: text('document_type').notNull(),
    documentNo: text('document_no').notNull(),
    description: text('description'),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    periodId: uuid('period_id').notNull(),
    currency: text('currency').notNull(),
    rate: text('rate').notNull(),
    rateSource: text('rate_source').notNull(),
    totalDebit: numeric('total_debit', { precision: 20, scale: 4 }).notNull(),
    totalCredit: numeric('total_credit', { precision: 20, scale: 4 }).notNull(),
    baseTotalDebit: numeric('base_total_debit', { precision: 20, scale: 4 }).notNull(),
    baseTotalCredit: numeric('base_total_credit', { precision: 20, scale: 4 }).notNull(),
    lineCount: integer('line_count').notNull(),
    branchId: uuid('branch_id'),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    reversalOfId: uuid('reversal_of_id'),
    postedByType: text('posted_by_type').notNull(),
    postedById: text('posted_by_id'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text'),
    /** Where in the system this came from (surface, action, request, ip, session, permission). */
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull(),
    previousHash: text('previous_hash').notNull(),
    hash: text('hash').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ledger_registers_idem_uidx').on(t.companyId, t.idempotencyKey),
    uniqueIndex('ledger_registers_chain_seq_uidx').on(t.companyId, t.chainKey, t.seq),
    index('ledger_registers_company_date_idx').on(t.companyId, t.postingDate),
    index('ledger_registers_doc_idx').on(t.companyId, t.documentNo),
    check('ledger_registers_balanced_chk', sql`${t.totalDebit} = ${t.totalCredit}`),
    check('ledger_registers_base_balanced_chk', sql`${t.baseTotalDebit} = ${t.baseTotalCredit}`),
  ],
);

/** Marks a register as reversed (unique per original), since registers themselves never change. */
export const registerReversals = pgTable(
  'register_reversals',
  {
    originalId: uuid('original_id')
      .primaryKey()
      .references(() => ledgerRegisters.id, { onDelete: 'restrict' }),
    reversalId: uuid('reversal_id')
      .notNull()
      .references(() => ledgerRegisters.id, { onDelete: 'restrict' }),
    reversedAt: timestamp('reversed_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * The general ledger. Append-only and range-partitioned by posting month (the partitioning and
 * the `id` identity are declared in the migration SQL, which drizzle cannot express).
 */
export const glEntries = pgTable(
  'gl_entries',
  {
    id: bigint('id', { mode: 'number' })
      .notNull()
      .default(sql`nextval('gl_entries_id_seq')`),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    companyId: uuid('company_id').notNull(),
    registerId: uuid('register_id').notNull(),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id').notNull(),
    debit: numeric('debit', { precision: 20, scale: 4 }).notNull(),
    credit: numeric('credit', { precision: 20, scale: 4 }).notNull(),
    baseDebit: numeric('base_debit', { precision: 20, scale: 4 }).notNull(),
    baseCredit: numeric('base_credit', { precision: 20, scale: 4 }).notNull(),
    currency: text('currency').notNull(),
    description: text('description'),
    dimensionSetId: uuid('dimension_set_id'),
    documentType: text('document_type').notNull(),
    documentNo: text('document_no').notNull(),
    branchId: uuid('branch_id'),
    sourceLedger: text('source_ledger'),
    sourceEntryId: text('source_entry_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.postingDate] }),
    index('gl_entries_account_date_idx').on(t.companyId, t.accountId, t.postingDate),
    index('gl_entries_register_idx').on(t.registerId),
    index('gl_entries_document_idx').on(t.companyId, t.documentNo),
  ],
);

/** Running totals per account × period × dimension set, sharded so hot accounts do not queue. */
export const glAccountBalances = pgTable(
  'gl_account_balances',
  {
    companyId: uuid('company_id').notNull(),
    accountId: uuid('account_id').notNull(),
    periodId: uuid('period_id').notNull(),
    /** The nil UUID stands for "no dimensions". */
    dimensionSetId: uuid('dimension_set_id')
      .notNull()
      .default(sql`'00000000-0000-0000-0000-000000000000'`),
    shard: smallint('shard').notNull(),
    baseDebit: numeric('base_debit', { precision: 20, scale: 4 }).notNull().default('0'),
    baseCredit: numeric('base_credit', { precision: 20, scale: 4 }).notNull().default('0'),
    entryCount: bigint('entry_count', { mode: 'number' }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.accountId, t.periodId, t.dimensionSetId, t.shard] }),
    index('gl_account_balances_period_idx').on(t.companyId, t.periodId),
  ],
);

export type GlAccountRow = typeof glAccounts.$inferSelect;
export type AccountingPeriodRow = typeof accountingPeriods.$inferSelect;
export type LedgerRegisterRow = typeof ledgerRegisters.$inferSelect;
export type GlEntryRow = typeof glEntries.$inferSelect;

// ── F-5: bank statements and reconciliation ─────────────────────────────────

export type StatementLineStatus = 'unmatched' | 'proposed' | 'matched' | 'ignored';

/** How one bank's file is read: saved per bank account so the second import is one click. */
export const bankStatementFormats = pgTable(
  'bank_statement_formats',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'csv' | 'mt940'>().notNull(),
    mapping: jsonb('mapping').$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bank_statement_formats_account_uidx').on(t.bankAccountId)],
);

/** One uploaded file. The same file cannot be imported twice into the same account. */
export const bankStatementImports = pgTable(
  'bank_statement_imports',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    fileName: text('file_name').notNull(),
    fileHash: text('file_hash').notNull(),
    format: text('format').notNull(),
    lineCount: integer('line_count').notNull(),
    skippedCount: integer('skipped_count').notNull().default(0),
    totalIn: numeric('total_in', { precision: 20, scale: 4 }).notNull(),
    totalOut: numeric('total_out', { precision: 20, scale: 4 }).notNull(),
    dateFrom: date('date_from', { mode: 'string' }),
    dateTo: date('date_to', { mode: 'string' }),
    openingBalance: numeric('opening_balance', { precision: 20, scale: 4 }),
    closingBalance: numeric('closing_balance', { precision: 20, scale: 4 }),
    importedBy: text('imported_by').notNull(),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bank_statement_imports_file_uidx').on(t.bankAccountId, t.fileHash)],
);

/** A line the bank reported. What it says never changes; only how it was dealt with does. */
export const bankStatementLines = pgTable(
  'bank_statement_lines',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    importId: uuid('import_id')
      .notNull()
      .references(() => bankStatementImports.id, { onDelete: 'restrict' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    lineNo: integer('line_no').notNull(),
    lineDate: date('line_date', { mode: 'string' }).notNull(),
    description: text('description').notNull().default(''),
    reference: text('reference'),
    counterparty: text('counterparty'),
    /** Positive = money in, negative = money out. */
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    balance: numeric('balance', { precision: 20, scale: 4 }),
    lineHash: text('line_hash').notNull(),
    status: text('status').$type<StatementLineStatus>().notNull().default('unmatched'),
    /** Ledger entries suggested by a rule that is not certain enough to apply itself. */
    proposedEntryIds: jsonb('proposed_entry_ids').$type<number[]>().notNull().default([]),
    matchRule: text('match_rule'),
    ignoreReason: text('ignore_reason'),
    reconciliationId: uuid('reconciliation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_statement_lines_hash_uidx').on(t.bankAccountId, t.lineHash),
    index('bank_statement_lines_work_idx').on(t.bankAccountId, t.status, t.lineDate),
    index('bank_statement_lines_import_idx').on(t.importId, t.lineNo),
  ],
);

/** A statement line closed against a ledger entry. Undone, never deleted. */
export const bankStatementMatches = pgTable(
  'bank_statement_matches',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    lineId: bigint('line_id', { mode: 'number' })
      .notNull()
      .references(() => bankStatementLines.id, { onDelete: 'restrict' }),
    bankEntryId: bigint('bank_entry_id', { mode: 'number' })
      .notNull()
      .references(() => bankLedgerEntries.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    rule: text('rule').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoneBy: text('undone_by'),
    undoReasonCode: text('undo_reason_code'),
    undoReasonText: text('undo_reason_text'),
  },
  (t) => [
    index('bank_statement_matches_line_idx').on(t.lineId),
    // A ledger entry can be closed against one line at a time.
    uniqueIndex('bank_statement_matches_entry_open_uidx')
      .on(t.bankEntryId)
      .where(sql`${t.undoneAt} IS NULL`),
  ],
);

export type BankReconciliationStatus = 'posted' | 'reversed';

/** A reconciliation of one bank account to its statement, up to a date. Immutable once posted. */
export const bankReconciliations = pgTable(
  'bank_reconciliations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    statementDate: date('statement_date', { mode: 'string' }).notNull(),
    openingBalance: numeric('opening_balance', { precision: 20, scale: 4 }).notNull(),
    statementBalance: numeric('statement_balance', { precision: 20, scale: 4 }).notNull(),
    linesTotal: numeric('lines_total', { precision: 20, scale: 4 }).notNull(),
    lineCount: integer('line_count').notNull(),
    ignoredTotal: numeric('ignored_total', { precision: 20, scale: 4 }).notNull().default('0'),
    notes: text('notes'),
    status: text('status').$type<BankReconciliationStatus>().notNull().default('posted'),
    postedBy: text('posted_by').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    reversedBy: text('reversed_by'),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reverseReasonCode: text('reverse_reason_code'),
    reverseReasonText: text('reverse_reason_text'),
  },
  (t) => [
    uniqueIndex('bank_reconciliations_number_uidx').on(t.companyId, t.number),
    index('bank_reconciliations_account_idx').on(t.bankAccountId, t.statementDate),
  ],
);

// ── F-6: payment platform engine ────────────────────────────────────────────

export type ProviderOperationStatus =
  | 'created'
  | 'pending_approval'
  | 'approved'
  | 'queued'
  | 'submitted'
  | 'accepted'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'in_doubt'
  | 'cancelled'
  | 'rejected';

/**
 * One request to a payment platform (collect, pay out, query, register...), from the moment it is
 * asked for to the moment the platform's final answer has been confirmed. Never deleted.
 */
export const providerOperations = pgTable(
  'provider_operations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => paymentProviderConfigs.id, { onDelete: 'restrict' }),
    /** The payment method (shortcode, branch, bank account, G/L account) the operation runs for. */
    methodId: uuid('method_id').references(() => paymentMethods.id, { onDelete: 'restrict' }),
    operation: text('operation').notNull(),
    status: text('status').$type<ProviderOperationStatus>().notNull().default('created'),
    /** The same request asked twice is one operation. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** The unique id we sent the platform (OriginatorConversationID, RequestRefID...). */
    originatorId: text('originator_id'),
    /** The platform's own id for the request (ConversationID, CheckoutRequestID...). */
    conversationId: text('conversation_id'),
    /** The transaction id the platform gave (M-Pesa receipt) once known. */
    platformReference: text('platform_reference'),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    amount: numeric('amount', { precision: 20, scale: 4 }),
    currency: text('currency'),
    /** What the operation was asked to do (no secrets): enough to send it again exactly as before. */
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    /** What was sent (secrets removed) and what came back. */
    request: jsonb('request').$type<Record<string, unknown>>().notNull().default({}),
    response: jsonb('response').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>().notNull().default({}),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    requestedBy: text('requested_by'),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('provider_operations_idem_uidx').on(t.companyId, t.idempotencyKey),
    index('provider_operations_provider_idx').on(t.providerId, t.operation, t.status),
    index('provider_operations_originator_idx').on(t.originatorId),
    index('provider_operations_conversation_idx').on(t.conversationId),
    index('provider_operations_subject_idx').on(t.subjectType, t.subjectId),
    index('provider_operations_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} IN ('queued','submitted','accepted','timed_out','in_doubt')`),
  ],
);

export type ProviderEventState =
  | 'received'
  | 'rejected'
  | 'unmatched'
  | 'mismatch'
  | 'awaiting_verification'
  | 'verified'
  | 'unverified'
  | 'consumed'
  | 'ignored';

/**
 * Everything a platform sends us, exactly as it arrived, with who sent it, whether it could be
 * trusted, and what was decided. A callback is a hint: only what we confirm ourselves counts.
 */
export const providerEvents = pgTable(
  'provider_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => paymentProviderConfigs.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    sourceIp: text('source_ip'),
    headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
    rawText: text('raw_text').notNull().default(''),
    rawBody: jsonb('raw_body').$type<unknown>(),
    bodyHash: text('body_hash').notNull(),
    /** What the callback claims, read once when it arrived (the payer only as a fingerprint). */
    claim: jsonb('claim').$type<Record<string, unknown>>(),
    operationId: uuid('operation_id').references(() => providerOperations.id, { onDelete: 'set null' }),
    attemptId: uuid('attempt_id'),
    state: text('state').$type<ProviderEventState>().notNull().default('received'),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    platformReference: text('platform_reference'),
    amount: numeric('amount', { precision: 20, scale: 4 }),
    /** How many times the very same body has been seen (a replay is logged, not acted on twice). */
    duplicateOf: uuid('duplicate_of'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('provider_events_provider_idx').on(t.providerId, t.kind, t.state),
    index('provider_events_ref_idx').on(t.platformReference),
    index('provider_events_hash_idx').on(t.providerId, t.bodyHash),
    index('provider_events_operation_idx').on(t.operationId),
    index('provider_events_created_idx').on(t.createdAt),
  ],
);

export type ProviderTransactionState = 'claimed' | 'verified' | 'review' | 'consumed' | 'rejected';

/**
 * Money the platform says moved into our account, one row per platform transaction id. Claimed from
 * a callback, **verified by asking the platform**, and consumed exactly once.
 */
export const providerTransactions = pgTable(
  'provider_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => paymentProviderConfigs.id, { onDelete: 'restrict' }),
    methodId: uuid('method_id').references(() => paymentMethods.id, { onDelete: 'restrict' }),
    /** stk | c2b | bill | b2b_express | gateway */
    kind: text('kind').notNull(),
    platformReference: text('platform_reference').notNull(),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    currency: text('currency').notNull().default('KES'),
    payerMasked: text('payer_masked'),
    payerHash: text('payer_hash'),
    shortcode: text('shortcode'),
    accountReference: text('account_reference'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    state: text('state').$type<ProviderTransactionState>().notNull().default('claimed'),
    /** What confirmed it: stk_query, transaction_status, pull, status_api... and what they said. */
    verifiedBy: text('verified_by'),
    evidence: jsonb('evidence').$type<Record<string, unknown>[]>().notNull().default([]),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    consumedType: text('consumed_type'),
    consumedId: text('consumed_id'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A platform transaction can be counted once, whatever number of callbacks announce it.
    uniqueIndex('provider_transactions_ref_uidx').on(t.providerId, t.platformReference),
    index('provider_transactions_state_idx').on(t.companyId, t.state),
    index('provider_transactions_occurred_idx').on(t.providerId, t.occurredAt),
  ],
);

export type ProviderOperationRow = typeof providerOperations.$inferSelect;
export type ProviderEventRow = typeof providerEvents.$inferSelect;
export type ProviderTransactionRow = typeof providerTransactions.$inferSelect;

// ─── Payments: Bill Manager invoices, one by one ──────────────────────────────────────────────

export type BillInvoiceStatus = 'requested' | 'sent' | 'failed' | 'part_paid' | 'paid' | 'cancelled';

/**
 * An invoice sent to a customer through M-Pesa Bill Manager, followed to the end: asked for, sent (or refused), paid in part
 * or in full by a payment Safaricom confirmed, acknowledged back to Bill Manager so the customer gets a receipt, or cancelled.
 */
export const billInvoices = pgTable(
  'bill_invoices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => paymentProviderConfigs.id, { onDelete: 'restrict' }),
    methodId: uuid('method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict' }),
    /** Our invoice number: how Bill Manager and we both name it. */
    reference: text('reference').notNull(),
    /** What the customer pays to (the account number on the paybill). */
    accountReference: text('account_reference').notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    billedName: text('billed_name').notNull(),
    /** Only the masked number is kept; the invoice was sent with the real one. */
    phoneMasked: text('phone_masked').notNull(),
    invoiceName: text('invoice_name').notNull(),
    period: text('period').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    status: text('status').$type<BillInvoiceStatus>().notNull().default('requested'),
    failureReason: text('failure_reason'),
    paidAmount: numeric('paid_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    lastTransactionId: uuid('last_transaction_id'),
    sendOperationId: uuid('send_operation_id').references(() => providerOperations.id, { onDelete: 'set null' }),
    cancelOperationId: uuid('cancel_operation_id').references(() => providerOperations.id, { onDelete: 'set null' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    ackError: text('ack_error'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bill_invoices_ref_uidx').on(t.providerId, t.reference),
    index('bill_invoices_account_idx').on(t.providerId, t.accountReference, t.status),
    index('bill_invoices_status_idx').on(t.companyId, t.status, t.createdAt),
    check('bill_invoices_amount_chk', sql`${t.amount} > 0`),
  ],
);

export type BillInvoiceRow = typeof billInvoices.$inferSelect;

/** Each confirmed payment settles an invoice once: this is the record that it did, and the guard against doing it again. */
export const billInvoicePayments = pgTable(
  'bill_invoice_payments',
  {
    transactionId: uuid('transaction_id')
      .primaryKey()
      .references(() => providerTransactions.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => billInvoices.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('bill_invoice_payments_invoice_idx').on(t.invoiceId)],
);

// ─── Foreign currency: rates, and the revaluation of what is owed ───────────────────────────

/**
 * What one unit of a foreign currency is worth in the books' currency, from a date. A day's rate is set once and then
 * stands for good: sales, receipts and settlements dated on or after it are valued by it.
 */
export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    currency: text('currency').notNull(),
    effectiveOn: date('effective_on', { mode: 'string' }).notNull(),
    /** Books' currency per one unit of `currency`. */
    rate: numeric('rate', { precision: 24, scale: 8 }).notNull(),
    source: text('source').notNull().default('manual'),
    note: text('note'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('exchange_rates_day_uidx').on(t.companyId, t.currency, t.effectiveOn),
    check('exchange_rates_positive_chk', sql`${t.rate} > 0`),
  ],
);

/** A month-end (or any day's) revaluation of foreign balances owed by or to customers. Posted, then undone the next day. */
export const fxRevaluations = pgTable(
  'fx_revaluations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    /** The rates used, by currency. */
    rates: jsonb('rates').$type<Record<string, string>>().notNull(),
    /** Net gain (positive) or loss (negative) in the books' currency. */
    net: numeric('net', { precision: 20, scale: 4 }).notNull(),
    /** What was posted for each customer posting group, and the register that undid it. */
    groups: jsonb('groups').$type<Record<string, { net: string; register: string; reversal: string | null }>>().notNull(),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('fx_revaluations_day_uidx').on(t.companyId, t.asOf)],
);

export type ExchangeRateRow = typeof exchangeRates.$inferSelect;
export type FxRevaluationRow = typeof fxRevaluations.$inferSelect;

// ─── Projects: work for a customer, or for the company itself ───────────────────────────────

export type ProjectStatus = 'draft' | 'open' | 'on_hold' | 'completed' | 'closed' | 'cancelled';
export type ProjectTaskStatus = 'open' | 'completed' | 'cancelled';

/**
 * A piece of work. Draft until someone opens it, then it can wait, be finished, be closed, or be
 * cancelled. Closing and cancelling are the end: the history of how it got there is kept on
 * `project_events`, which is never rewritten.
 */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** Null when the work is for the company itself, not for a customer. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    status: text('status').$type<ProjectStatus>().notNull().default('draft'),
    /** True when this work is meant to be sold. */
    billable: boolean('billable').notNull().default(false),
    currency: text('currency').notNull(),
    budgetAmount: numeric('budget_amount', { precision: 19, scale: 4 }).notNull().default('0'),
    startOn: date('start_on', { mode: 'string' }),
    endOn: date('end_on', { mode: 'string' }),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projects_company_number_uidx').on(t.companyId, t.number),
    uniqueIndex('projects_idem_uidx').on(t.companyId, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('projects_list_idx').on(t.companyId, t.createdAt, t.id),
    index('projects_status_idx').on(t.companyId, t.status, t.createdAt),
    index('projects_customer_idx').on(t.companyId, t.customerId, t.createdAt),
    check('projects_name_chk', sql`char_length(btrim(${t.name})) BETWEEN 1 AND 120`),
    check('projects_description_chk', sql`${t.description} IS NULL OR char_length(${t.description}) <= 2000`),
    check('projects_currency_chk', sql`char_length(${t.currency}) = 3`),
    check('projects_budget_chk', sql`${t.budgetAmount} >= 0`),
    check('projects_dates_chk', sql`${t.endOn} IS NULL OR ${t.startOn} IS NULL OR ${t.endOn} >= ${t.startOn}`),
    check('projects_version_chk', sql`${t.version} >= 1`),
  ],
);

/** A step of a project. Its code is unique on that project. */
export const projectTasks = pgTable(
  'project_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').$type<ProjectTaskStatus>().notNull().default('open'),
    budgetAmount: numeric('budget_amount', { precision: 19, scale: 4 }).notNull().default('0'),
    sortOrder: integer('sort_order').notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_tasks_project_code_uidx').on(t.projectId, t.code),
    index('project_tasks_order_idx').on(t.projectId, t.sortOrder, t.id),
    check('project_tasks_code_chk', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'`),
    check('project_tasks_name_chk', sql`char_length(btrim(${t.name})) BETWEEN 1 AND 120`),
    check('project_tasks_description_chk', sql`${t.description} IS NULL OR char_length(${t.description}) <= 2000`),
    check('project_tasks_budget_chk', sql`${t.budgetAmount} >= 0`),
    check('project_tasks_version_chk', sql`${t.version} >= 1`),
  ],
);

/** Every step of a project's life: who, what, from where. Append-only. */
export const projectEvents = pgTable(
  'project_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('project_events_project_idx').on(t.projectId, t.id)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectTaskRow = typeof projectTasks.$inferSelect;
export type ProjectEventRow = typeof projectEvents.$inferSelect;

// ── Vendor management and accounts payable (F-7, docs/architecture/vendor-management-module.md) ──

export type VendorStatus =
  | 'registered'
  | 'profile_in_progress'
  | 'profile_submitted'
  | 'under_review'
  | 'revision_requested'
  | 'active'
  | 'rejected'
  | 'suspended'
  | 'archived';
export type VendorBlock = 'none' | 'payment' | 'all';
export type VendorPortalRole = 'owner' | 'finance' | 'sales' | 'readonly';

/** Which accounts a vendor's payables, advances, discounts, tolerance, exchange differences and withholding post to. */
export const vendorPostingGroups = pgTable(
  'vendor_posting_groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    payablesAccountId: uuid('payables_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    prepaymentsAccountId: uuid('prepayments_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    paymentDiscountAccountId: uuid('payment_discount_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    paymentToleranceAccountId: uuid('payment_tolerance_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    fxGainAccountId: uuid('fx_gain_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    fxLossAccountId: uuid('fx_loss_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    withholdingPayableAccountId: uuid('withholding_payable_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vendor_posting_groups_company_code_uidx').on(t.companyId, t.code),
    check('vendor_posting_groups_code_chk', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9._-]{0,19}$'`),
  ],
);

/** A business we buy from. The number is given when the vendor is approved, not when it registers. */
export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number'),
    status: text('status').$type<VendorStatus>().notNull().default('registered'),
    /** BC's Blocked field: payments refused, or every new document refused. */
    block: text('block').$type<VendorBlock>().notNull().default('none'),
    vendorType: text('vendor_type').notNull().default('company'),
    legalName: text('legal_name').notNull(),
    tradingName: text('trading_name'),
    taxId: text('tax_id'),
    vatNo: text('vat_no'),
    registrationNo: text('registration_no'),
    country: text('country'),
    email: text('email').notNull(),
    phone: text('phone'),
    /** The same business as a customer, when it is both. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    postingGroupId: uuid('posting_group_id').references(() => vendorPostingGroups.id, { onDelete: 'restrict' }),
    paymentTermDays: integer('payment_term_days').notNull().default(30),
    currency: text('currency'),
    /** May be invoiced without a purchase order (an approved expense vendor). */
    approvedExpenseVendor: boolean('approved_expense_vendor').notNull().default(false),
    createdByStaff: boolean('created_by_staff').notNull().default(false),
    notes: text('notes'),
    // The profile the vendor fills in itself (portal, V-1).
    yearEstablished: integer('year_established'),
    website: text('website'),
    description: text('description'),
    physicalStreet: text('physical_street'),
    physicalCity: text('physical_city'),
    physicalCounty: text('physical_county'),
    physicalPostalCode: text('physical_postal_code'),
    postalAddress: text('postal_address'),
    registrationDate: date('registration_date', { mode: 'string' }),
    employeeCount: integer('employee_count'),
    turnoverBand: text('turnover_band'),
    /** The payment terms the vendor asks for (ours are `paymentTermDays`). */
    offeredPaymentTermDays: integer('offered_payment_term_days'),
    mobileMoneyNumber: text('mobile_money_number'),
    taxExempt: boolean('tax_exempt').notNull().default(false),
    /** Tax withheld from what is paid to this vendor (a code with a rate and a base); empty when none is. */
    withholdingCodeId: uuid('withholding_code_id').references((): AnyPgColumn => withholdingCodes.id, { onDelete: 'restrict' }),
    /** Early-payment discount the vendor allows: this percent when paid within this many days of the invoice date. */
    earlyDiscountPercent: numeric('early_discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    earlyDiscountDays: integer('early_discount_days').notNull().default(0),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewerId: text('reviewer_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vendors_company_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    uniqueIndex('vendors_company_tax_id_uidx')
      .on(t.companyId, sql`lower(${t.taxId})`)
      .where(sql`${t.taxId} IS NOT NULL AND ${t.status} <> 'archived'`),
    index('vendors_company_status_idx').on(t.companyId, t.status, t.createdAt),
    index('vendors_company_email_idx').on(t.companyId, sql`lower(${t.email})`),
    check(
      'vendors_status_chk',
      sql`${t.status} IN ('registered','profile_in_progress','profile_submitted','under_review','revision_requested','active','rejected','suspended','archived')`,
    ),
    check('vendors_block_chk', sql`${t.block} IN ('none','payment','all')`),
    check('vendors_legal_name_chk', sql`char_length(btrim(${t.legalName})) BETWEEN 1 AND 200`),
    // A vendor in good standing always has a number.
    check('vendors_active_numbered_chk', sql`${t.status} <> 'active' OR ${t.number} IS NOT NULL`),
    check('vendors_term_chk', sql`${t.paymentTermDays} BETWEEN 0 AND 365`),
  ],
);

/** The people who can sign in to the vendor portal for one vendor business. */
export const vendorUsers = pgTable(
  'vendor_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    portalRole: text('portal_role').$type<VendorPortalRole>().notNull().default('owner'),
    status: text('status').notNull().default('active'),
    invitedBy: text('invited_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One portal login belongs to one vendor business.
    uniqueIndex('vendor_users_user_uidx').on(t.userId),
    index('vendor_users_vendor_idx').on(t.vendorId),
    uniqueIndex('vendor_users_one_owner_uidx')
      .on(t.vendorId)
      .where(sql`${t.portalRole} = 'owner' AND ${t.status} = 'active'`),
    check('vendor_users_role_chk', sql`${t.portalRole} IN ('owner','finance','sales','readonly')`),
    check('vendor_users_status_chk', sql`${t.status} IN ('active','removed')`),
  ],
);

/** Every step of a vendor's life: who, what, why, from where. Append-only. */
export const vendorEvents = pgTable(
  'vendor_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    origin: jsonb('origin').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vendor_events_vendor_idx').on(t.vendorId, t.id)],
);

export type VendorLedgerDocumentType = 'invoice' | 'credit_memo' | 'payment' | 'advance' | 'refund';

/**
 * What the company owes each vendor, one row per posted document. Amounts are positive when the
 * company owes the vendor (invoices, advances' counterpart) and negative for payments and credits,
 * the same convention as the customer ledger turned round, so "remaining" is what is still open.
 */
export const vendorLedgerEntries = pgTable(
  'vendor_ledger_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    documentType: text('document_type').$type<VendorLedgerDocumentType>().notNull(),
    documentNo: text('document_no').notNull(),
    /** The vendor's own number for it (their invoice number). */
    externalDocumentNo: text('external_document_no'),
    description: text('description'),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    remainingAmount: numeric('remaining_amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    /** Base currency per one unit of `currency` when it was booked (1 in the books' own currency). Fixed for the life of the entry. */
    rate: numeric('rate', { precision: 24, scale: 8 }).notNull().default('1'),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    documentDate: date('document_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    /** The document behind it (posted purchase invoice, payment voucher). */
    documentId: uuid('document_id'),
    registerId: uuid('register_id'),
    idempotencyKey: text('idempotency_key'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vendor_ledger_vendor_idx').on(t.vendorId, t.postingDate),
    index('vendor_ledger_document_idx').on(t.documentId),
    index('vendor_ledger_open_due_idx').on(t.dueDate).where(sql`${t.remainingAmount} <> 0`),
    uniqueIndex('vendor_ledger_idem_uidx').on(t.companyId, t.idempotencyKey).where(sql`${t.idempotencyKey} IS NOT NULL`),
    // The same vendor invoice number cannot be booked twice for one vendor.
    uniqueIndex('vendor_ledger_external_no_uidx')
      .on(t.vendorId, sql`lower(btrim(${t.externalDocumentNo}))`)
      .where(sql`${t.externalDocumentNo} IS NOT NULL AND ${t.documentType} = 'invoice'`),
    check('vendor_ledger_type_chk', sql`${t.documentType} IN ('invoice','credit_memo','payment','advance','refund')`),
  ],
);

export type VendorDetailedEntryType =
  | 'initial'
  | 'application'
  | 'unapplication'
  | 'reversal'
  | 'write_off'
  | 'payment_discount'
  | 'payment_tolerance'
  | 'fx_gain'
  | 'fx_loss'
  | 'advance_application';

/** Every change to what is open on a vendor ledger entry. Append-only; the sum per entry is what is open. */
export const vendorDetailedEntries = pgTable(
  'vendor_detailed_entries',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    ledgerEntryId: uuid('ledger_entry_id')
      .notNull()
      .references(() => vendorLedgerEntries.id, { onDelete: 'restrict' }),
    entryType: text('entry_type').$type<VendorDetailedEntryType>().notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    appliedToEntryId: uuid('applied_to_entry_id'),
    applicationId: uuid('application_id'),
    unappliesApplicationId: uuid('unapplies_application_id'),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    registerId: uuid('register_id'),
    reasonCode: text('reason_code'),
    reasonText: text('reason_text'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vendor_detailed_entry_idx').on(t.ledgerEntryId),
    index('vendor_detailed_vendor_idx').on(t.vendorId, t.id),
    index('vendor_detailed_application_idx').on(t.applicationId),
    uniqueIndex('vendor_detailed_unapply_once_uidx')
      .on(t.unappliesApplicationId, t.ledgerEntryId, t.appliedToEntryId)
      .where(sql`${t.unappliesApplicationId} IS NOT NULL`),
  ],
);

export type VendorRow = typeof vendors.$inferSelect;
export type VendorUserRow = typeof vendorUsers.$inferSelect;
export type VendorLedgerEntryRow = typeof vendorLedgerEntries.$inferSelect;

export type VendorSection = 'profile' | 'business' | 'financial' | 'contacts' | 'attachments';
export type VendorContactRole = 'management' | 'sales' | 'finance' | 'technical';
export type VendorDocumentStatus = 'submitted' | 'valid' | 'invalid' | 'expired' | 'replaced';
export type VendorBankStatus = 'draft' | 'active' | 'pending_change' | 'retired';
export type VendorDecision = 'pending' | 'approved' | 'revision_requested' | 'rejected';

export const vendorContacts = pgTable(
  'vendor_contacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    role: text('role').$type<VendorContactRole>().notNull(),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vendor_contacts_vendor_idx').on(t.vendorId),
    uniqueIndex('vendor_contacts_one_primary_uidx').on(t.vendorId).where(sql`${t.isPrimary}`),
    check('vendor_contacts_role_chk', sql`${t.role} IN ('management','sales','finance','technical')`),
  ],
);

/** Owners and directors. The ID number is sealed: it is shown only to the person who must verify it. */
export const vendorDirectors = pgTable(
  'vendor_directors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    idType: text('id_type').notNull(),
    idNumberSealed: jsonb('id_number_sealed').$type<EncryptedCredentialsBlob>().notNull(),
    idLast4: text('id_last4').notNull(),
    sharePercent: numeric('share_percent', { precision: 5, scale: 2 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vendor_directors_vendor_idx').on(t.vendorId), check('vendor_directors_share_chk', sql`${t.sharePercent} IS NULL OR ${t.sharePercent} BETWEEN 0 AND 100`)],
);

export const vendorReferences = pgTable(
  'vendor_references',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    clientName: text('client_name').notNull(),
    workDescription: text('work_description'),
    valueAmount: numeric('value_amount', { precision: 14, scale: 2 }),
    contactName: text('contact_name'),
    contactPhone: text('contact_phone'),
    year: integer('year'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vendor_references_vendor_idx').on(t.vendorId)],
);

/**
 * Where a vendor is paid. The number is sealed and shown masked; its hash finds the same account on two vendors. A bank
 * account is never edited: a change is a new row (`pending_change`) that replaces the old one only when approved.
 */
export const vendorBankAccounts = pgTable(
  'vendor_bank_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    /** What the money is sent to: a bank account, or an M-Pesa phone, paybill or till. For the last three the sealed number is that phone or shortcode. */
    kind: text('kind').$type<'bank' | 'mpesa_phone' | 'mpesa_paybill' | 'mpesa_till'>().notNull().default('bank'),
    /** The account number a paybill or till payment quotes (what the vendor recognises it by). */
    reference: text('reference'),
    bankName: text('bank_name').notNull(),
    branch: text('branch').notNull(),
    accountName: text('account_name').notNull(),
    accountSealed: jsonb('account_sealed').$type<EncryptedCredentialsBlob>().notNull(),
    accountLast4: text('account_last4').notNull(),
    accountHash: text('account_hash').notNull(),
    swift: text('swift'),
    status: text('status').$type<VendorBankStatus>().notNull().default('draft'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // A change to an approved vendor's bank details (design doc §17.2): proposed by the vendor, a call-back by one person,
    // approval by a different one, then a cool-off before the account is used.
    /** The account this one takes the place of when it goes live; empty when it is an additional account. */
    replacesId: uuid('replaces_id').references((): AnyPgColumn => vendorBankAccounts.id, { onDelete: 'set null' }),
    proposedBy: text('proposed_by'),
    /** The bank letter the vendor gave as evidence for this change. */
    evidenceDocumentId: uuid('evidence_document_id').references((): AnyPgColumn => vendorDocuments.id, { onDelete: 'set null' }),
    callbackBy: text('callback_by'),
    callbackAt: timestamp('callback_at', { withTimezone: true }),
    callbackNote: text('callback_note'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** When the account may be used: approval plus the cool-off. */
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    decisionNote: text('decision_note'),
  },
  (t) => [
    index('vendor_bank_vendor_idx').on(t.vendorId),
    index('vendor_bank_hash_idx').on(t.accountHash),
    uniqueIndex('vendor_bank_one_pending_uidx').on(t.vendorId).where(sql`${t.status} = 'pending_change'`),
    index('vendor_bank_pending_idx').on(t.effectiveFrom).where(sql`${t.status} = 'pending_change'`),
    check('vendor_bank_four_eyes_chk', sql`(${t.approvedBy} IS NULL OR ${t.approvedBy} IS DISTINCT FROM ${t.proposedBy}) AND (${t.approvedBy} IS NULL OR ${t.approvedBy} IS DISTINCT FROM ${t.callbackBy})`),
    check('vendor_bank_kind_chk', sql`${t.kind} IN ('bank','mpesa_phone','mpesa_paybill','mpesa_till')`),
    check('vendor_bank_status_chk', sql`${t.status} IN ('draft','active','pending_change','retired')`),
  ],
);

export const vendorDocumentTypes = pgTable(
  'vendor_document_types',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Every vendor must hold a valid one before it can be approved. */
    requiredForAll: boolean('required_for_all').notNull().default(false),
    needsExpiry: boolean('needs_expiry').notNull().default(false),
    /** Days before expiry on which the vendor and the buyer are reminded. */
    reminderDays: jsonb('reminder_days').$type<number[]>().notNull().default([30, 7, 0]),
    /** An expired one suspends what it supports (qualifications, V-2) until replaced. */
    blocking: boolean('blocking').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('vendor_document_types_company_code_uidx').on(t.companyId, t.code), check('vendor_document_types_code_chk', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9._-]{0,29}$'`)],
);

/** What a vendor uploads, kept in the database behind our own authorised routes: never a public link. */
export const vendorFiles = pgTable(
  'vendor_files',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    fileName: text('file_name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    data: bytea('data').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vendor_files_vendor_idx').on(t.vendorId),
    check('vendor_files_mime_chk', sql`${t.mime} IN ('application/pdf','image/jpeg','image/png','image/webp')`),
    check('vendor_files_size_chk', sql`${t.sizeBytes} BETWEEN 1 AND 26214400`),
  ],
);

export const vendorDocuments = pgTable(
  'vendor_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    documentTypeId: uuid('document_type_id')
      .notNull()
      .references(() => vendorDocumentTypes.id, { onDelete: 'restrict' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => vendorFiles.id, { onDelete: 'restrict' }),
    issuedOn: date('issued_on', { mode: 'string' }),
    expiresOn: date('expires_on', { mode: 'string' }),
    status: text('status').$type<VendorDocumentStatus>().notNull().default('submitted'),
    /** The reminder threshold (days before expiry) last mailed for this document, so each is sent once. */
    lastReminderDay: integer('last_reminder_day'),
    verifiedBy: text('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('vendor_documents_vendor_idx').on(t.vendorId, t.documentTypeId),
    index('vendor_documents_expiry_idx').on(t.expiresOn).where(sql`${t.status} IN ('submitted','valid')`),
    check('vendor_documents_status_chk', sql`${t.status} IN ('submitted','valid','invalid','expired','replaced')`),
  ],
);

/** One row each time a vendor submits its profile: a frozen copy, and what the reviewer decided about it. */
export const vendorProfileVersions = pgTable(
  'vendor_profile_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    submittedBy: text('submitted_by'),
    decision: text('decision').$type<VendorDecision>().notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
    reasonCode: text('reason_code'),
    comment: text('comment'),
    /** For a revision request: what to fix, section by section. */
    sectionNotes: jsonb('section_notes').$type<Partial<Record<VendorSection, string>>>().notNull().default({}),
  },
  (t) => [
    uniqueIndex('vendor_profile_versions_uidx').on(t.vendorId, t.version),
    check('vendor_profile_versions_decision_chk', sql`${t.decision} IN ('pending','approved','revision_requested','rejected')`),
  ],
);

export type VendorContactRow = typeof vendorContacts.$inferSelect;
export type VendorDirectorRow = typeof vendorDirectors.$inferSelect;
export type VendorBankAccountRow = typeof vendorBankAccounts.$inferSelect;
export type VendorDocumentRow = typeof vendorDocuments.$inferSelect;
export type VendorDocumentTypeRow = typeof vendorDocumentTypes.$inferSelect;
export type VendorProfileVersionRow = typeof vendorProfileVersions.$inferSelect;

// ── Prequalification (V-2, docs/architecture/vendor-management-module.md §7) ──

export type CategoryStatus = 'draft' | 'open' | 'closed' | 'archived';
export type QuestionKind = 'yes_no' | 'number' | 'text' | 'choice';
export type PrequalStatus = 'draft' | 'submitted' | 'in_review' | 'revision_requested' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'suspended' | 'revoked';

/** What a vendor can be qualified for. A tree; its questions and required documents are fixed once it leaves draft. */
export const procurementCategories = pgTable(
  'procurement_categories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => procurementCategories.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').$type<CategoryStatus>().notNull().default('draft'),
    /** Months a qualification lasts. */
    validityMonths: integer('validity_months').notNull().default(24),
    windowFrom: date('window_from', { mode: 'string' }),
    windowTo: date('window_to', { mode: 'string' }),
    /** The score (percent of the highest possible) needed to pass; empty means pass or fail by the evaluator's decision only. */
    passMarkPercent: numeric('pass_mark_percent', { precision: 5, scale: 2 }),
    /** The person who decides cannot be one who scored. */
    fourEyes: boolean('four_eyes').notNull().default(true),
    // What the vendor may see of an evaluation (the decision and its reason are always shown).
    showTotalScore: boolean('show_total_score').notNull().default(false),
    showPassMark: boolean('show_pass_mark').notNull().default(false),
    showQuestionScores: boolean('show_question_scores').notNull().default(false),
    showEvaluatorComments: boolean('show_evaluator_comments').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('procurement_categories_company_code_uidx').on(t.companyId, t.code),
    index('procurement_categories_parent_idx').on(t.parentId),
    check('procurement_categories_code_chk', sql`${t.code} ~ '^[A-Z0-9][A-Z0-9._-]{0,29}$'`),
    check('procurement_categories_status_chk', sql`${t.status} IN ('draft','open','closed','archived')`),
    check('procurement_categories_validity_chk', sql`${t.validityMonths} BETWEEN 1 AND 120`),
    check('procurement_categories_pass_chk', sql`${t.passMarkPercent} IS NULL OR ${t.passMarkPercent} BETWEEN 0 AND 100`),
  ],
);

export const categoryDocuments = pgTable(
  'category_documents',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => procurementCategories.id, { onDelete: 'cascade' }),
    documentTypeId: uuid('document_type_id')
      .notNull()
      .references(() => vendorDocumentTypes.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.documentTypeId] })],
);

export const categoryQuestions = pgTable(
  'category_questions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => procurementCategories.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    prompt: text('prompt').notNull(),
    kind: text('kind').$type<QuestionKind>().notNull(),
    choices: jsonb('choices').$type<string[]>().notNull().default([]),
    /** The most an evaluator can give this question; 0 means it is asked but not scored. */
    weight: integer('weight').notNull().default(0),
    required: boolean('required').notNull().default(true),
  },
  (t) => [
    index('category_questions_category_idx').on(t.categoryId, t.position),
    check('category_questions_kind_chk', sql`${t.kind} IN ('yes_no','number','text','choice')`),
    check('category_questions_weight_chk', sql`${t.weight} BETWEEN 0 AND 100`),
  ],
);

/** One vendor's application for one category (a renewal is a new row pointing at the old). */
export const prequalEntries = pgTable(
  'prequal_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => procurementCategories.id, { onDelete: 'restrict' }),
    status: text('status').$type<PrequalStatus>().notNull().default('draft'),
    previousEntryId: uuid('previous_entry_id').references((): AnyPgColumn => prequalEntries.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
    reasonCode: text('reason_code'),
    decisionComment: text('decision_comment'),
    revisionDue: date('revision_due', { mode: 'string' }),
    validFrom: date('valid_from', { mode: 'string' }),
    validUntil: date('valid_until', { mode: 'string' }),
    /** A condition on what the vendor may be given: the largest order value, and a note. */
    maxOrderValue: numeric('max_order_value', { precision: 14, scale: 2 }),
    conditionsNote: text('conditions_note'),
    /** Filled in at the decision, from the scores. */
    totalScore: numeric('total_score', { precision: 7, scale: 2 }),
    maxScore: numeric('max_score', { precision: 7, scale: 2 }),
    /** Why a suspension is in force: a staff decision or an expired document. */
    suspendedBecause: text('suspended_because'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live application or qualification per vendor and category.
    uniqueIndex('prequal_entries_live_uidx')
      .on(t.vendorId, t.categoryId)
      .where(sql`${t.status} IN ('draft','submitted','in_review','revision_requested','approved','suspended')`),
    index('prequal_entries_category_idx').on(t.categoryId, t.status),
    index('prequal_entries_queue_idx').on(t.companyId, t.status, t.submittedAt),
    index('prequal_entries_valid_idx').on(t.validUntil).where(sql`${t.status} IN ('approved','suspended')`),
    check('prequal_entries_status_chk', sql`${t.status} IN ('draft','submitted','in_review','revision_requested','approved','rejected','withdrawn','expired','suspended','revoked')`),
  ],
);

export const prequalAnswers = pgTable(
  'prequal_answers',
  {
    entryId: uuid('entry_id')
      .notNull()
      .references(() => prequalEntries.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => categoryQuestions.id, { onDelete: 'restrict' }),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.questionId] })],
);

export const prequalEvaluators = pgTable(
  'prequal_evaluators',
  {
    entryId: uuid('entry_id')
      .notNull()
      .references(() => prequalEntries.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.userId] })],
);

export const prequalScores = pgTable(
  'prequal_scores',
  {
    entryId: uuid('entry_id')
      .notNull()
      .references(() => prequalEntries.id, { onDelete: 'cascade' }),
    evaluatorId: text('evaluator_id').notNull(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => categoryQuestions.id, { onDelete: 'restrict' }),
    score: integer('score').notNull(),
    comment: text('comment'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.evaluatorId, t.questionId] }), check('prequal_scores_score_chk', sql`${t.score} >= 0`)],
);

export type ProcurementCategoryRow = typeof procurementCategories.$inferSelect;
export type CategoryQuestionRow = typeof categoryQuestions.$inferSelect;
export type PrequalEntryRow = typeof prequalEntries.$inferSelect;

// ── Requests for quotation (V-3, docs/architecture/vendor-management-module.md §8) ──

export type RfqStatus = 'draft' | 'issued' | 'closed' | 'awarded' | 'cancelled';
export type RfqQuoteStatus = 'draft' | 'submitted' | 'withdrawn';
export type RfqDecision = 'pending' | 'accepted' | 'rejected' | 'revision_requested';

/** One request sent to several qualified vendors, answered in confidence, compared, then awarded. */
export const rfqs = pgTable(
  'rfqs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number'),
    status: text('status').$type<RfqStatus>().notNull().default('draft'),
    title: text('title').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => procurementCategories.id, { onDelete: 'restrict' }),
    description: text('description'),
    terms: text('terms'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    requiredBy: date('required_by', { mode: 'string' }),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    /** Days a quote must hold. */
    validityDays: integer('validity_days').notNull().default(30),
    currency: text('currency').notNull(),
    /** Staff cannot read quotes before `opensAt` when sealed. */
    sealed: boolean('sealed').notNull().default(true),
    opensAt: timestamp('opens_at', { withTimezone: true }),
    allowPartial: boolean('allow_partial').notNull().default(false),
    allowAlternatives: boolean('allow_alternatives').notNull().default(false),
    estimatedValue: numeric('estimated_value', { precision: 14, scale: 2 }),
    buyerId: text('buyer_id'),
    createdBy: text('created_by'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
    awardedAt: timestamp('awarded_at', { withTimezone: true }),
    awardNote: text('award_note'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    /** Which deadline reminders have gone out (48 h, 4 h), reset when the deadline moves. */
    reminded48: boolean('reminded_48').notNull().default(false),
    reminded4: boolean('reminded_4').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rfqs_company_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    index('rfqs_company_status_idx').on(t.companyId, t.status, t.createdAt),
    index('rfqs_deadline_idx').on(t.deadline).where(sql`${t.status} = 'issued'`),
    check('rfqs_status_chk', sql`${t.status} IN ('draft','issued','closed','awarded','cancelled')`),
    check('rfqs_validity_chk', sql`${t.validityDays} BETWEEN 1 AND 365`),
  ],
);

export const rfqLines = pgTable(
  'rfq_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    specification: text('specification'),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unit: text('unit').notNull().default('each'),
    requiredDate: date('required_date', { mode: 'string' }),
  },
  (t) => [index('rfq_lines_rfq_idx').on(t.rfqId, t.position), check('rfq_lines_qty_chk', sql`${t.quantity} > 0`)],
);

export const rfqInvitations = pgTable(
  'rfq_invitations',
  {
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    /** invited → opened by the vendor; or declined to bid. */
    status: text('status').notNull().default('invited'),
    declineReason: text('decline_reason'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    declinedAt: timestamp('declined_at', { withTimezone: true }),
    /** The buyer's decision about this vendor's quote. */
    decision: text('decision').$type<RfqDecision>().notNull().default('pending'),
    decisionReason: text('decision_reason'),
    decisionComment: text('decision_comment'),
    revisionDue: timestamp('revision_due', { withTimezone: true }),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Told of the result (awarded or not) once. */
    resultSeenAt: timestamp('result_seen_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.rfqId, t.vendorId] }),
    index('rfq_invitations_vendor_idx').on(t.vendorId),
    check('rfq_invitations_status_chk', sql`${t.status} IN ('invited','opened','declined')`),
    check('rfq_invitations_decision_chk', sql`${t.decision} IN ('pending','accepted','rejected','revision_requested')`),
  ],
);

/** A numbered addendum sent to every invitee. Append-only. */
export const rfqAddenda = pgTable(
  'rfq_addenda',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    body: text('body').notNull(),
    deadlineBefore: timestamp('deadline_before', { withTimezone: true }),
    deadlineAfter: timestamp('deadline_after', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('rfq_addenda_uidx').on(t.rfqId, t.number)],
);

export const rfqQuestions = pgTable(
  'rfq_questions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    answer: text('answer'),
    /** Only a published answer goes to the invitees, and then without saying who asked. */
    published: boolean('published').notNull().default(false),
    answeredBy: text('answered_by'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rfq_questions_rfq_idx').on(t.rfqId, t.createdAt)],
);

/** One version of a vendor's quote. Once submitted, a version never changes. */
export const rfqQuotes = pgTable(
  'rfq_quotes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    status: text('status').$type<RfqQuoteStatus>().notNull().default('draft'),
    paymentTerms: text('payment_terms'),
    deliveryTerms: text('delivery_terms'),
    validUntil: date('valid_until', { mode: 'string' }),
    notes: text('notes'),
    /** Worked out on the server from the lines; never taken from the browser. */
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 14, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    submittedBy: text('submitted_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rfq_quotes_version_uidx').on(t.rfqId, t.vendorId, t.version),
    // At most one version being written at a time.
    uniqueIndex('rfq_quotes_one_draft_uidx').on(t.rfqId, t.vendorId).where(sql`${t.status} = 'draft'`),
    index('rfq_quotes_rfq_idx').on(t.rfqId, t.status),
    check('rfq_quotes_status_chk', sql`${t.status} IN ('draft','submitted','withdrawn')`),
  ],
);

export const rfqQuoteLines = pgTable(
  'rfq_quote_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    quoteId: uuid('quote_id')
      .notNull()
      .references(() => rfqQuotes.id, { onDelete: 'cascade' }),
    rfqLineId: uuid('rfq_line_id')
      .notNull()
      .references(() => rfqLines.id, { onDelete: 'restrict' }),
    noBid: boolean('no_bid').notNull().default(false),
    isAlternative: boolean('is_alternative').notNull().default(false),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    leadTimeDays: integer('lead_time_days'),
    brand: text('brand'),
    warranty: text('warranty'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('rfq_quote_lines_uidx').on(t.quoteId, t.rfqLineId, t.isAlternative),
    check('rfq_quote_lines_price_chk', sql`${t.unitPrice} IS NULL OR ${t.unitPrice} >= 0`),
    check('rfq_quote_lines_bid_chk', sql`${t.noBid} OR (${t.unitPrice} IS NOT NULL AND ${t.quantity} IS NOT NULL AND ${t.quantity} > 0)`),
  ],
);

/** What was awarded to whom, line by line, with the price and quantity the quote gave. Append-only. */
export const rfqAwards = pgTable(
  'rfq_awards',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    rfqLineId: uuid('rfq_line_id')
      .notNull()
      .references(() => rfqLines.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    quoteLineId: uuid('quote_line_id')
      .notNull()
      .references(() => rfqQuoteLines.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    justification: text('justification'),
    awardedBy: text('awarded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rfq_awards_rfq_idx').on(t.rfqId), check('rfq_awards_qty_chk', sql`${t.quantity} > 0`)],
);

/** An award waiting for an approval workflow: what was chosen, kept until it is approved (then awarded) or refused (then dropped). */
export const rfqAwardProposals = pgTable(
  'rfq_award_proposals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    allocations: jsonb('allocations').$type<{ rfqLineId: string; vendorId: string; quantity: string }[]>().notNull(),
    justification: text('justification'),
    proposedBy: text('proposed_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('rfq_award_proposals_rfq_uq').on(t.rfqId)],
);

export const rfqEvents = pgTable(
  'rfq_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    rfqId: uuid('rfq_id')
      .notNull()
      .references(() => rfqs.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id'),
    event: text('event').notNull(),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('rfq_events_rfq_idx').on(t.rfqId, t.id)],
);

export type RfqRow = typeof rfqs.$inferSelect;
export type RfqLineRow = typeof rfqLines.$inferSelect;
export type RfqQuoteRow = typeof rfqQuotes.$inferSelect;

// ── Purchase orders and advance payments (V-4, docs/architecture/vendor-management-module.md §9) ──

export type PurchaseOrderStatus =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'sent'
  | 'confirmed'
  | 'amendment_pending'
  | 'partially_received'
  | 'received'
  | 'partially_invoiced'
  | 'invoiced'
  | 'closed'
  | 'cancelled';
export type AdvancePaymentStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'applied' | 'refunded' | 'written_off' | 'cancelled';

/** Company-wide vendor policy that is data, not code. */
export const vendorSettings = pgTable('vendor_settings', {
  companyId: uuid('company_id')
    .primaryKey()
    .references(() => companySettings.id, { onDelete: 'cascade' }),
  /** A purchase order above this value needs a request for quotation, unless someone allowed to skip it says why. Empty: never required. */
  rfqRequiredAbove: numeric('rfq_required_above', { precision: 14, scale: 2 }),
  /** An amendment that raises the value by more than this percent goes to approval again (any price change always does). */
  amendmentTolerancePercent: numeric('amendment_tolerance_percent', { precision: 5, scale: 2 }).notNull().default('0'),
  /** How much more than ordered a delivery may bring before it is refused (percent of the line). */
  receiptTolerancePercent: numeric('receipt_tolerance_percent', { precision: 5, scale: 2 }).notNull().default('0'),
  /** The account the tax on supplier invoices is booked to (input tax). Without it, an invoice with tax cannot be booked. */
  inputTaxAccountId: uuid('input_tax_account_id').references((): AnyPgColumn => glAccounts.id, { onDelete: 'restrict' }),
  /** An invoice price above the order's by no more than this percent, or this amount on the line, passes the match. */
  invoicePriceTolerancePercent: numeric('invoice_price_tolerance_percent', { precision: 5, scale: 2 }).notNull().default('2'),
  invoicePriceToleranceAmount: numeric('invoice_price_tolerance_amount', { precision: 14, scale: 2 }).notNull().default('100'),
  /** An invoice quantity above what is linked by no more than this percent passes. */
  invoiceQuantityTolerancePercent: numeric('invoice_quantity_tolerance_percent', { precision: 5, scale: 2 }).notNull().default('0'),
  /** A payment voucher of at least this value needs three different people: to prepare, approve and pay it. 0 turns it off. */
  paymentThreeEyesAbove: numeric('payment_three_eyes_above', { precision: 14, scale: 2 }).notNull().default('100000'),
  /** A payment may close a leftover on an invoice of no more than this, as tolerance. 0 turns it off. */
  /** A vendor's invoice with tax on it must carry its eTIMS invoice number before it can be sent, so the input tax can be claimed. */
  requireEtimsForTax: boolean('require_etims_for_tax').notNull().default(false),
  paymentToleranceAmount: numeric('payment_tolerance_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  /** Watch list (design doc §17.4): invoices with the same vendor and total this many days apart are listed. */
  watchDuplicateWindowDays: integer('watch_duplicate_window_days').notNull().default(7),
  /** A payment of at least `watchNewVendorAmount` to a vendor added within this many days is listed, and may be held. */
  watchNewVendorDays: integer('watch_new_vendor_days').notNull().default(30),
  watchNewVendorAmount: numeric('watch_new_vendor_amount', { precision: 14, scale: 2 }).notNull().default('100000'),
  /** A flagged payment (new vendor, or a bank account shared with another vendor) needs three different people. */
  holdFlaggedPayments: boolean('hold_flagged_payments').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Given when the order is approved, so abandoned drafts leave no gaps. */
    number: text('number'),
    version: integer('version').notNull().default(1),
    status: text('status').$type<PurchaseOrderStatus>().notNull().default('draft'),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => procurementCategories.id, { onDelete: 'restrict' }),
    rfqId: uuid('rfq_id').references(() => rfqs.id, { onDelete: 'restrict' }),
    quoteId: uuid('quote_id').references(() => rfqQuotes.id, { onDelete: 'restrict' }),
    /** The blanket order (contract) this order calls off, when it does. Its prices are the contract's. */
    contractId: uuid('contract_id').references((): AnyPgColumn => vendorContracts.id, { onDelete: 'restrict' }),
    orderDate: date('order_date', { mode: 'string' }).notNull(),
    expectedDate: date('expected_date', { mode: 'string' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    currency: text('currency').notNull(),
    paymentTerms: text('payment_terms'),
    deliveryTerms: text('delivery_terms'),
    notesToVendor: text('notes_to_vendor'),
    internalNotes: text('internal_notes'),
    /** Only someone with the flag permission sets it; it is approved with the order. */
    requiresAdvancePayment: boolean('requires_advance_payment').notNull().default(false),
    /** Raised without a request for quotation, with the reason. */
    noRfq: boolean('no_rfq').notNull().default(false),
    noRfqReason: text('no_rfq_reason'),
    /** The vendor was not qualified in the category and someone allowed to override said why (reported). */
    qualificationOverrideReason: text('qualification_override_reason'),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 14, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    buyerId: text('buyer_id'),
    createdBy: text('created_by'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: text('confirmed_by'),
    confirmationNote: text('confirmation_note'),
    cancelReason: text('cancel_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('purchase_orders_company_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    // One order per awarded vendor per request, unless it was cancelled.
    uniqueIndex('purchase_orders_rfq_vendor_uidx').on(t.rfqId, t.vendorId).where(sql`${t.rfqId} IS NOT NULL AND ${t.status} <> 'cancelled'`),
    index('purchase_orders_company_status_idx').on(t.companyId, t.status, t.createdAt),
    index('purchase_orders_vendor_idx').on(t.vendorId, t.createdAt),
    check('purchase_orders_status_chk', sql`${t.status} IN ('draft','pending_approval','approved','sent','confirmed','amendment_pending','partially_received','received','partially_invoiced','invoiced','closed','cancelled')`),
    check('purchase_orders_no_rfq_chk', sql`NOT ${t.noRfq} OR ${t.noRfqReason} IS NOT NULL`),
    check('purchase_orders_approver_chk', sql`${t.approvedBy} IS NULL OR ${t.approvedBy} IS DISTINCT FROM ${t.createdBy}`),
  ],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    specification: text('specification'),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unit: text('unit').notNull().default('each'),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    /** Worked out on the server. */
    lineTotal: numeric('line_total', { precision: 14, scale: 2 }).notNull().default('0'),
    expectedDate: date('expected_date', { mode: 'string' }),
    awardId: uuid('award_id').references(() => rfqAwards.id, { onDelete: 'restrict' }),
    contractLineId: uuid('contract_line_id').references((): AnyPgColumn => vendorContractLines.id, { onDelete: 'restrict' }),
    // Kept by receiving and invoicing (later slices), never edited by hand.
    receivedQuantity: numeric('received_quantity', { precision: 14, scale: 3 }).notNull().default('0'),
    invoicedQuantity: numeric('invoiced_quantity', { precision: 14, scale: 3 }).notNull().default('0'),
    cancelledQuantity: numeric('cancelled_quantity', { precision: 14, scale: 3 }).notNull().default('0'),
  },
  (t) => [
    index('purchase_order_lines_po_idx').on(t.poId, t.position),
    check('purchase_order_lines_qty_chk', sql`${t.quantity} > 0 AND ${t.unitPrice} >= 0`),
    check('purchase_order_lines_discount_chk', sql`${t.discountPercent} BETWEEN 0 AND 100`),
  ],
);

/** Every version that was ever released, as it was. Append-only. */
export const purchaseOrderVersions = pgTable(
  'purchase_order_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    reason: text('reason'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('purchase_order_versions_uidx').on(t.poId, t.version)],
);

/** A change to an order after it was released: proposed, approved when it needs to be, then applied as the next version. */
export const purchaseOrderAmendments = pgTable(
  'purchase_order_amendments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending_approval'),
    reason: text('reason').notNull(),
    proposed: jsonb('proposed').$type<Record<string, unknown>>().notNull(),
    needsApproval: boolean('needs_approval').notNull(),
    proposedBy: text('proposed_by'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    appliedVersion: integer('applied_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('purchase_order_amendments_open_uidx').on(t.poId).where(sql`${t.status} = 'pending_approval'`),
    check('purchase_order_amendments_status_chk', sql`${t.status} IN ('pending_approval','applied','rejected','withdrawn')`),
    check('purchase_order_amendments_approver_chk', sql`${t.decidedBy} IS NULL OR ${t.status} <> 'applied' OR NOT ${t.needsApproval} OR ${t.decidedBy} IS DISTINCT FROM ${t.proposedBy}`),
  ],
);

export const purchaseOrderEvents = pgTable(
  'purchase_order_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('purchase_order_events_po_idx').on(t.poId, t.id)],
);

/** The document that lets money go out as an advance. A payment voucher must reference it (V-7). */
export const vendorAdvancePayments = pgTable(
  'vendor_advance_payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    status: text('status').$type<AdvancePaymentStatus>().notNull().default('draft'),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    reason: text('reason').notNull(),
    /** The account it will be paid into, fixed when the document is approved. */
    bankAccountId: uuid('bank_account_id').references(() => vendorBankAccounts.id, { onDelete: 'restrict' }),
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    /** The payment voucher that paid it (V-7). */
    voucherId: uuid('voucher_id'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live advance document per order.
    uniqueIndex('vendor_advance_payments_live_uidx').on(t.poId).where(sql`${t.status} IN ('draft','pending_approval','approved','paid')`),
    index('vendor_advance_payments_company_idx').on(t.companyId, t.status),
    check('vendor_advance_payments_status_chk', sql`${t.status} IN ('draft','pending_approval','approved','paid','applied','refunded','written_off','cancelled')`),
    check('vendor_advance_payments_amount_chk', sql`${t.amount} > 0`),
    check('vendor_advance_payments_approver_chk', sql`${t.approvedBy} IS NULL OR ${t.approvedBy} IS DISTINCT FROM ${t.createdBy}`),
  ],
);

export type PurchaseOrderRow = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLineRow = typeof purchaseOrderLines.$inferSelect;
export type VendorAdvancePaymentRow = typeof vendorAdvancePayments.$inferSelect;

// ── Received goods notes (V-5, docs/architecture/vendor-management-module.md §10) ──

export type RgnStatus = 'draft' | 'posted' | 'reversed' | 'cancelled';

/** What arrived against one purchase order. A posted note never changes; a mistake is reversed. */
export const rgns = pgTable(
  'rgns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Given when the note is posted. */
    number: text('number'),
    status: text('status').$type<RgnStatus>().notNull().default('draft'),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    receivedDate: date('received_date', { mode: 'string' }).notNull(),
    /** The number printed on the vendor's own delivery note. */
    deliveryNoteNo: text('delivery_note_no').notNull(),
    vehicle: text('vehicle'),
    notes: text('notes'),
    receivedBy: text('received_by'),
    createdBy: text('created_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: text('posted_by'),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedBy: text('reversed_by'),
    reverseReason: text('reverse_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rgns_company_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    // A vendor's delivery note is received once: the same note number cannot be posted twice.
    uniqueIndex('rgns_delivery_note_uidx').on(t.vendorId, sql`lower(${t.deliveryNoteNo})`).where(sql`${t.status} = 'posted'`),
    index('rgns_po_idx').on(t.poId),
    index('rgns_company_status_idx').on(t.companyId, t.status, t.createdAt),
    check('rgns_status_chk', sql`${t.status} IN ('draft','posted','reversed','cancelled')`),
  ],
);

export const rgnLines = pgTable(
  'rgn_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rgnId: uuid('rgn_id')
      .notNull()
      .references(() => rgns.id, { onDelete: 'cascade' }),
    poLineId: uuid('po_line_id')
      .notNull()
      .references(() => purchaseOrderLines.id, { onDelete: 'restrict' }),
    delivered: numeric('delivered', { precision: 14, scale: 3 }).notNull(),
    accepted: numeric('accepted', { precision: 14, scale: 3 }).notNull(),
    rejected: numeric('rejected', { precision: 14, scale: 3 }).notNull().default('0'),
    rejectReason: text('reject_reason'),
    /** What the accepted goods cost per unit, fixed when the note is posted. */
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }),
    // Kept by supplier invoices (V-6): how much of the accepted quantity has been invoiced.
    invoicedQuantity: numeric('invoiced_quantity', { precision: 14, scale: 3 }).notNull().default('0'),
    // Kept by purchase returns: how much of the accepted quantity has gone back to the vendor.
    returnedQuantity: numeric('returned_quantity', { precision: 14, scale: 3 }).notNull().default('0'),
  },
  (t) => [
    check('rgn_lines_returned_chk', sql`${t.returnedQuantity} >= 0 AND ${t.returnedQuantity} + ${t.invoicedQuantity} <= ${t.accepted}`),
    index('rgn_lines_rgn_idx').on(t.rgnId),
    index('rgn_lines_po_line_idx').on(t.poLineId),
    uniqueIndex('rgn_lines_uidx').on(t.rgnId, t.poLineId),
    check('rgn_lines_qty_chk', sql`${t.delivered} > 0 AND ${t.accepted} >= 0 AND ${t.rejected} >= 0 AND ${t.accepted} + ${t.rejected} = ${t.delivered}`),
    check('rgn_lines_reason_chk', sql`${t.rejected} = 0 OR ${t.rejectReason} IS NOT NULL`),
  ],
);

export type RgnRow = typeof rgns.$inferSelect;
export type RgnLineRow = typeof rgnLines.$inferSelect;

// ── Supplier invoices (V-6) ──

export type SupplierInvoiceState =
  | 'draft'
  | 'submitted'
  | 'received'
  | 'rgn_linked'
  | 'matched'
  | 'pending_approval'
  | 'approved'
  | 'posted'
  | 'returned'
  | 'rejected'
  | 'closed';

/**
 * The vendor's invoice, made in the portal and processed by staff until it is booked. Two numbers: the vendor's own
 * (`vendorInvoiceNo`, printed on their paper) and ours (`number`, given at the first submission).
 */
export const supplierInvoices = pgTable(
  'supplier_invoices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number'),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    vendorInvoiceNo: text('vendor_invoice_no').notNull(),
    /** The number KRA's eTIMS gave the vendor's invoice (the control unit invoice number printed on it), and where it can be verified. */
    etimsInvoiceNo: text('etims_invoice_no'),
    etimsVerificationUrl: text('etims_verification_url'),
    state: text('state').$type<SupplierInvoiceState>().notNull().default('draft'),
    revision: integer('revision').notNull().default(1),
    currency: text('currency').notNull(),
    invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    notes: text('notes'),
    declaration: boolean('declaration').notNull().default(false),
    /** The vendor's own paper or PDF invoice, required to submit. */
    invoiceFileId: uuid('invoice_file_id').references(() => vendorFiles.id, { onDelete: 'restrict' }),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 14, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    /** True when it was accepted without a delivery note because the order has an approved advance. */
    advanceBasis: boolean('advance_basis').notNull().default(false),
    createdByPortalUser: text('created_by_portal_user'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    assignedTo: text('assigned_to'),
    /** Empty until a member of staff first acts. A recall is possible only while it is empty. */
    firstActionAt: timestamp('first_action_at', { withTimezone: true }),
    linkedBy: text('linked_by'),
    linkedAt: timestamp('linked_at', { withTimezone: true }),
    matchedBy: text('matched_by'),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    matchOverrideReason: text('match_override_reason'),
    sentForApprovalBy: text('sent_for_approval_by'),
    sentForApprovalAt: timestamp('sent_for_approval_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    returnReasonCode: text('return_reason_code'),
    returnNote: text('return_note'),
    rejectReasonCode: text('reject_reason_code'),
    rejectNote: text('reject_note'),
    closeReason: text('close_reason'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: text('posted_by'),
    purchaseInvoiceId: uuid('purchase_invoice_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('supplier_invoices_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    // The duplicate guard: one live invoice per vendor and number, whatever the spaces and case. A closed or refused one frees the number.
    uniqueIndex('supplier_invoices_vendor_no_uidx')
      .on(t.vendorId, sql`regexp_replace(lower(${t.vendorInvoiceNo}), '[[:space:]]+', '', 'g')`)
      .where(sql`${t.state} NOT IN ('closed','rejected')`),
    index('supplier_invoices_queue_idx').on(t.companyId, t.state, t.submittedAt),
    index('supplier_invoices_vendor_idx').on(t.vendorId, t.createdAt),
    index('supplier_invoices_po_idx').on(t.poId),
    check('supplier_invoices_state_chk', sql`${t.state} IN ('draft','submitted','received','rgn_linked','matched','pending_approval','approved','posted','returned','rejected','closed')`),
    check('supplier_invoices_total_chk', sql`${t.subtotal} >= 0 AND ${t.taxTotal} >= 0 AND ${t.total} = ${t.subtotal} + ${t.taxTotal}`),
    check('supplier_invoices_posted_chk', sql`${t.state} <> 'posted' OR ${t.purchaseInvoiceId} IS NOT NULL`),
    // Whoever linked or checked an invoice cannot approve it.
    check('supplier_invoices_four_eyes_chk', sql`${t.approvedBy} IS NULL OR (${t.approvedBy} IS DISTINCT FROM ${t.linkedBy} AND ${t.approvedBy} IS DISTINCT FROM ${t.matchedBy})`),
  ],
);

export const supplierInvoiceLines = pgTable(
  'supplier_invoice_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    poLineId: uuid('po_line_id')
      .notNull()
      .references(() => purchaseOrderLines.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    unit: text('unit').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    netAmount: numeric('net_amount', { precision: 14, scale: 2 }).notNull(),
    taxAmount: numeric('tax_amount', { precision: 14, scale: 2 }).notNull(),
    /** For a line with no stock behind it: the account it is booked to, chosen by staff. */
    glAccountId: uuid('gl_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
  },
  (t) => [
    uniqueIndex('supplier_invoice_lines_pos_uidx').on(t.invoiceId, t.position),
    index('supplier_invoice_lines_po_line_idx').on(t.poLineId),
    check('supplier_invoice_lines_amounts_chk', sql`${t.quantity} > 0 AND ${t.unitPrice} >= 0 AND ${t.netAmount} >= 0 AND ${t.taxAmount} >= 0`),
  ],
);

/** Stage 1: which received goods an invoice line is for, and how much of them. */
export const supplierInvoiceLineRgn = pgTable(
  'supplier_invoice_line_rgn',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invoiceLineId: uuid('invoice_line_id')
      .notNull()
      .references(() => supplierInvoiceLines.id, { onDelete: 'cascade' }),
    rgnLineId: uuid('rgn_line_id')
      .notNull()
      .references(() => rgnLines.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
  },
  (t) => [
    uniqueIndex('supplier_invoice_line_rgn_uidx').on(t.invoiceLineId, t.rgnLineId),
    index('supplier_invoice_line_rgn_rgn_idx').on(t.rgnLineId),
    check('supplier_invoice_line_rgn_qty_chk', sql`${t.quantity} > 0`),
  ],
);

/** The vendor's own delivery notes that the invoice claims payment for. Stage 1 matches each to a received goods note. */
export const supplierInvoiceDeliveryNotes = pgTable(
  'supplier_invoice_delivery_notes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: 'cascade' }),
    noteNo: text('note_no').notNull(),
    noteDate: date('note_date', { mode: 'string' }).notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => vendorFiles.id, { onDelete: 'restrict' }),
    matchedRgnId: uuid('matched_rgn_id').references(() => rgns.id, { onDelete: 'restrict' }),
  },
  (t) => [uniqueIndex('supplier_invoice_dn_uidx').on(t.invoiceId, sql`lower(btrim(${t.noteNo}))`)],
);

/** The outcome of the last match, line by line. Replaced each time the match is run. */
export const supplierInvoiceMatches = pgTable(
  'supplier_invoice_matches',
  {
    invoiceLineId: uuid('invoice_line_id')
      .primaryKey()
      .references(() => supplierInvoiceLines.id, { onDelete: 'cascade' }),
    status: text('status').$type<'ok' | 'exception'>().notNull(),
    problems: jsonb('problems').$type<string[]>().notNull().default([]),
    priceDifference: numeric('price_difference', { precision: 14, scale: 2 }).notNull().default('0'),
    quantityDifference: numeric('quantity_difference', { precision: 14, scale: 3 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('supplier_invoice_matches_status_chk', sql`${t.status} IN ('ok','exception')`)],
);

export const supplierInvoiceEvents = pgTable(
  'supplier_invoice_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    fromState: text('from_state'),
    toState: text('to_state'),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('supplier_invoice_events_idx').on(t.invoiceId, t.id)],
);

/** The booked invoice. Never changes; a correction is a credit memo and a new invoice. */
export const purchaseInvoices = pgTable(
  'purchase_invoices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    supplierInvoiceId: uuid('supplier_invoice_id')
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    vendorInvoiceNo: text('vendor_invoice_no').notNull(),
    currency: text('currency').notNull(),
    invoiceDate: date('invoice_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull(),
    taxTotal: numeric('tax_total', { precision: 14, scale: 2 }).notNull(),
    total: numeric('total', { precision: 14, scale: 2 }).notNull(),
    registerId: uuid('register_id').notNull(),
    ledgerEntryId: uuid('ledger_entry_id').notNull(),
    postedBy: text('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('purchase_invoices_number_uidx').on(t.companyId, t.number),
    uniqueIndex('purchase_invoices_supplier_invoice_uidx').on(t.supplierInvoiceId),
    index('purchase_invoices_vendor_idx').on(t.vendorId, t.postedAt),
  ],
);

export type SupplierInvoiceRow = typeof supplierInvoices.$inferSelect;
export type SupplierInvoiceLineRow = typeof supplierInvoiceLines.$inferSelect;
export type PurchaseInvoiceRow = typeof purchaseInvoices.$inferSelect;

// ── Vendor payments (V-7) ──

export type VendorVoucherStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'reversed' | 'cancelled';

/** The document that authorises one payment to one vendor: of invoices, or an advance. */
export const vendorPaymentVouchers = pgTable(
  'vendor_payment_vouchers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Given when it is approved, so abandoned drafts leave no gaps. */
    number: text('number'),
    kind: text('kind').$type<'invoices' | 'advance' | 'on_account'>().notNull(),
    status: text('status').$type<VendorVoucherStatus>().notNull().default('draft'),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    currency: text('currency').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    methodId: uuid('method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict' }),
    advanceId: uuid('advance_id').references(() => vendorAdvancePayments.id, { onDelete: 'restrict' }),
    narration: text('narration'),
    /** The vendor's bank account the money goes to, fixed when the voucher is approved; and how to recognise it. */
    vendorBankAccountId: uuid('vendor_bank_account_id').references(() => vendorBankAccounts.id, { onDelete: 'restrict' }),
    destination: text('destination'),
    createdBy: text('created_by'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** Decided at approval from the value: a third person must pay it. */
    needsThree: boolean('needs_three').notNull().default(false),
    sendBackReason: text('send_back_reason'),
    cancelReason: text('cancel_reason'),
    paidBy: text('paid_by'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidOn: date('paid_on', { mode: 'string' }),
    paymentReference: text('payment_reference'),
    registerId: uuid('register_id'),
    ledgerEntryId: uuid('ledger_entry_id'),
    reversedBy: text('reversed_by'),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reverseReason: text('reverse_reason'),
    reversalRegisterId: uuid('reversal_register_id'),
    /** How the payment settles: tax withheld, early-payment discount taken, a leftover closed as tolerance, and the cash that goes out. Fixed at approval. */
    withholdingAmount: numeric('withholding_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    toleranceAmount: numeric('tolerance_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    cashAmount: numeric('cash_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    /** The run this voucher is paid in, when it is paid with others. */
    batchId: uuid('batch_id').references((): AnyPgColumn => vendorPaymentBatches.id, { onDelete: 'set null' }),
    /** The cheque number written for it, when the run is a cheque run. */
    chequeNo: text('cheque_no'),
    /** The bank statement line this payment was made from: the money had already left the bank, and the line is matched when the payment is recorded. */
    /** Base currency per one unit of the voucher's currency on the day it was paid. */
    rate: numeric('rate', { precision: 24, scale: 8 }).notNull().default('1'),
    /** The journal that books the exchange difference between the invoices' rates and this payment's rate, in the books' currency. */
    fxRegisterId: uuid('fx_register_id'),
    /** What the business gained (positive) or lost (negative) on the exchange between the rates, in the books' currency. */
    fxDifference: numeric('fx_difference', { precision: 14, scale: 2 }).notNull().default('0'),
    statementLineId: bigint('statement_line_id', { mode: 'number' }).references(() => bankStatementLines.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vendor_payment_vouchers_statement_line_uidx').on(t.statementLineId).where(sql`${t.statementLineId} IS NOT NULL AND ${t.status} <> 'cancelled'`),
    index('vendor_payment_vouchers_batch_idx').on(t.batchId).where(sql`${t.batchId} IS NOT NULL`),
    // One cheque number is written once on one way of paying (one cheque book), while the voucher is alive.
    uniqueIndex('vendor_payment_vouchers_cheque_uidx').on(t.methodId, t.chequeNo).where(sql`${t.chequeNo} IS NOT NULL AND ${t.status} IN ('approved','paid')`),
    uniqueIndex('vendor_payment_vouchers_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    // An advance document is paid by one voucher at a time.
    uniqueIndex('vendor_payment_vouchers_advance_uidx').on(t.advanceId).where(sql`${t.advanceId} IS NOT NULL AND ${t.status} IN ('draft','pending_approval','approved','paid')`),
    index('vendor_payment_vouchers_company_idx').on(t.companyId, t.status, t.createdAt),
    index('vendor_payment_vouchers_vendor_idx').on(t.vendorId, t.createdAt),
    check('vendor_payment_vouchers_status_chk', sql`${t.status} IN ('draft','pending_approval','approved','paid','reversed','cancelled')`),
    check('vendor_payment_vouchers_amount_chk', sql`${t.amount} > 0`),
    check('vendor_payment_vouchers_settle_chk', sql`${t.withholdingAmount} >= 0 AND ${t.discountAmount} >= 0 AND ${t.toleranceAmount} >= 0 AND ${t.cashAmount} >= 0 AND ${t.cashAmount} = ${t.amount} - ${t.discountAmount} - ${t.withholdingAmount}`),
    check('vendor_payment_vouchers_advance_chk', sql`(${t.kind} = 'advance') = (${t.advanceId} IS NOT NULL)`),
    check('vendor_payment_vouchers_approver_chk', sql`${t.approvedBy} IS NULL OR ${t.approvedBy} IS DISTINCT FROM ${t.createdBy}`),
    check('vendor_payment_vouchers_payer_chk', sql`NOT ${t.needsThree} OR ${t.paidBy} IS NULL OR (${t.paidBy} IS DISTINCT FROM ${t.createdBy} AND ${t.paidBy} IS DISTINCT FROM ${t.approvedBy})`),
    check('vendor_payment_vouchers_paid_chk', sql`${t.status} NOT IN ('paid','reversed') OR (${t.registerId} IS NOT NULL AND ${t.ledgerEntryId} IS NOT NULL AND ${t.paidBy} IS NOT NULL AND ${t.paymentReference} IS NOT NULL)`),
  ],
);

/** Which booked invoices a voucher pays, and how much of each. */
export const vendorPaymentVoucherLines = pgTable(
  'vendor_payment_voucher_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vendorPaymentVouchers.id, { onDelete: 'cascade' }),
    purchaseInvoiceId: uuid('purchase_invoice_id')
      .notNull()
      .references(() => purchaseInvoices.id, { onDelete: 'restrict' }),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /** Close what is left on the invoice after this payment as tolerance. */
    closeRemainder: boolean('close_remainder').notNull().default(false),
    discount: numeric('discount', { precision: 14, scale: 2 }).notNull().default('0'),
    tolerance: numeric('tolerance', { precision: 14, scale: 2 }).notNull().default('0'),
    withholdingBase: numeric('withholding_base', { precision: 14, scale: 2 }).notNull().default('0'),
    withholding: numeric('withholding', { precision: 14, scale: 2 }).notNull().default('0'),
  },
  (t) => [
    uniqueIndex('vendor_payment_voucher_lines_uidx').on(t.voucherId, t.purchaseInvoiceId),
    index('vendor_payment_voucher_lines_invoice_idx').on(t.purchaseInvoiceId),
    check('vendor_payment_voucher_lines_amount_chk', sql`${t.amount} > 0`),
  ],
);

export const vendorPaymentEvents = pgTable(
  'vendor_payment_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vendorPaymentVouchers.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vendor_payment_events_idx').on(t.voucherId, t.id)],
);

export type VendorPaymentVoucherRow = typeof vendorPaymentVouchers.$inferSelect;

export type VendorBatchStatus = 'draft' | 'pending_approval' | 'approved' | 'released' | 'confirmed' | 'cancelled';

/** Vouchers paid together: suggested from what is due, approved as one, released as a bank file or a cheque run, confirmed when paid. */
export const vendorPaymentBatches = pgTable(
  'vendor_payment_batches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number'),
    status: text('status').$type<VendorBatchStatus>().notNull().default('draft'),
    methodId: uuid('method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict' }),
    currency: text('currency').notNull(),
    /** The day the bank should pay (or the cheques are dated). */
    executionDate: date('execution_date', { mode: 'string' }).notNull(),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    itemCount: integer('item_count').notNull().default(0),
    /** csv | pain001 (bank transfer), cheque (cheque run), none (paid another way). */
    format: text('format').$type<'csv' | 'pain001' | 'cheque' | 'none'>(),
    /** The file is not kept (it carries account numbers): this fingerprint proves a rebuilt file is the one that was made. */
    contentSha256: text('content_sha256'),
    fileCreatedAt: timestamp('file_created_at', { withTimezone: true }),
    downloads: integer('downloads').notNull().default(0),
    firstChequeNo: text('first_cheque_no'),
    note: text('note'),
    createdBy: text('created_by'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    releasedBy: text('released_by'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    confirmedBy: text('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    bankReference: text('bank_reference'),
    cancelReason: text('cancel_reason'),
    cancelledBy: text('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vendor_payment_batches_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    index('vendor_payment_batches_company_idx').on(t.companyId, t.status, t.createdAt),
    check('vendor_payment_batches_status_chk', sql`${t.status} IN ('draft','pending_approval','approved','released','confirmed','cancelled')`),
    // Whoever released the run cannot be the one who confirms the bank paid it.
    check('vendor_payment_batches_confirmer_chk', sql`${t.confirmedBy} IS NULL OR ${t.confirmedBy} IS DISTINCT FROM ${t.releasedBy}`),
  ],
);

export const vendorPaymentBatchEvents = pgTable(
  'vendor_payment_batch_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => vendorPaymentBatches.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vendor_payment_batch_events_idx').on(t.batchId, t.id)],
);

export type VendorPaymentBatchRow = typeof vendorPaymentBatches.$inferSelect;

// ── Withholding tax (V-7) ──

/** A kind of tax withheld from vendors: its rate and what it is taken on. Data, never code. */
export const withholdingCodes = pgTable(
  'withholding_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    ratePercent: numeric('rate_percent', { precision: 5, scale: 2 }).notNull(),
    /** net: the part of what is paid that is the invoice before tax. gross: all of what is paid. */
    base: text('base').$type<'net' | 'gross'>().notNull().default('net'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('withholding_codes_company_code_uidx').on(t.companyId, sql`lower(${t.code})`),
    check('withholding_codes_rate_chk', sql`${t.ratePercent} > 0 AND ${t.ratePercent} <= 100`),
    check('withholding_codes_base_chk', sql`${t.base} IN ('net','gross')`),
  ],
);

/** What the vendor is given as proof of the tax withheld from a payment. Never edited; a reversed payment cancels it. */
export const withholdingCertificates = pgTable(
  'withholding_certificates',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    number: text('number').notNull(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    voucherId: uuid('voucher_id')
      .notNull()
      .references(() => vendorPaymentVouchers.id, { onDelete: 'restrict' }),
    status: text('status').$type<'issued' | 'cancelled'>().notNull().default('issued'),
    paidOn: date('paid_on', { mode: 'string' }).notNull(),
    /** The month the tax was withheld in (YYYY-MM): what the tax return is made from. */
    period: text('period').notNull(),
    codeName: text('code_name').notNull(),
    ratePercent: numeric('rate_percent', { precision: 5, scale: 2 }).notNull(),
    baseAmount: numeric('base_amount', { precision: 14, scale: 2 }).notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    cancelReason: text('cancel_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdBy: text('created_by'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('withholding_certificates_number_uidx').on(t.companyId, t.number),
    uniqueIndex('withholding_certificates_voucher_uidx').on(t.voucherId),
    index('withholding_certificates_vendor_idx').on(t.vendorId, t.issuedAt),
    index('withholding_certificates_period_idx').on(t.companyId, t.period),
    check('withholding_certificates_status_chk', sql`${t.status} IN ('issued','cancelled')`),
    check('withholding_certificates_amount_chk', sql`${t.amount} > 0 AND ${t.baseAmount} > 0`),
  ],
);

export type WithholdingCodeRow = typeof withholdingCodes.$inferSelect;
export type WithholdingCertificateRow = typeof withholdingCertificates.$inferSelect;

/** The result of comparing the vendor ledger with the general ledger's payables and prepayments accounts, kept each time it is run. */
export const payablesChecks = pgTable(
  'payables_checks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
    /** A person's id, or 'system' for the nightly run. */
    ranBy: text('ran_by').notNull(),
    ok: boolean('ok').notNull(),
    differences: integer('differences').notNull().default(0),
    rows: jsonb('rows').$type<{ accountId: string; accountNo: string; accountName: string; purpose: 'payables' | 'prepayments'; ledgerCents: number; glCents: number; diffCents: number }[]>().notNull().default([]),
    drift: jsonb('drift').$type<{ id: string; documentNo: string; remaining: string; detailed: string }[]>().notNull().default([]),
  },
  (t) => [index('payables_checks_company_idx').on(t.companyId, t.ranAt)],
);

// ── Credit memos from vendors (V-7) ──

export type VendorCreditMemoState = 'draft' | 'submitted' | 'received' | 'approved' | 'posted' | 'returned' | 'rejected' | 'closed';

/**
 * A credit note the vendor sends for a booked invoice (over-billing, a price correction, a quantity billed that was not delivered).
 * The vendor makes it in the portal, staff review and approve it, and booking it reduces what is owed.
 */
export const vendorCreditMemos = pgTable(
  'vendor_credit_memos',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Given at the first submission. */
    number: text('number'),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => purchaseInvoices.id, { onDelete: 'restrict' }),
    vendorCreditNo: text('vendor_credit_no').notNull(),
    state: text('state').$type<VendorCreditMemoState>().notNull().default('draft'),
    revision: integer('revision').notNull().default(1),
    currency: text('currency').notNull(),
    creditDate: date('credit_date', { mode: 'string' }).notNull(),
    reason: text('reason').notNull().default(''),
    notes: text('notes'),
    /** The vendor's own credit note, required to submit. */
    fileId: uuid('file_id').references(() => vendorFiles.id, { onDelete: 'restrict' }),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 14, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    createdByPortalUser: text('created_by_portal_user'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    assignedTo: text('assigned_to'),
    firstActionAt: timestamp('first_action_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    returnReasonCode: text('return_reason_code'),
    returnNote: text('return_note'),
    rejectReasonCode: text('reject_reason_code'),
    rejectNote: text('reject_note'),
    closeReason: text('close_reason'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: text('posted_by'),
    registerId: uuid('register_id'),
    ledgerEntryId: uuid('ledger_entry_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vendor_credit_memos_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    uniqueIndex('vendor_credit_memos_vendor_no_uidx')
      .on(t.vendorId, sql`regexp_replace(lower(${t.vendorCreditNo}), '[[:space:]]+', '', 'g')`)
      .where(sql`${t.state} NOT IN ('closed','rejected')`),
    index('vendor_credit_memos_queue_idx').on(t.companyId, t.state, t.submittedAt),
    index('vendor_credit_memos_invoice_idx').on(t.invoiceId),
    index('vendor_credit_memos_vendor_idx').on(t.vendorId, t.createdAt),
    check('vendor_credit_memos_state_chk', sql`${t.state} IN ('draft','submitted','received','approved','posted','returned','rejected','closed')`),
    check('vendor_credit_memos_total_chk', sql`${t.subtotal} >= 0 AND ${t.taxTotal} >= 0 AND ${t.total} = ${t.subtotal} + ${t.taxTotal}`),
    check('vendor_credit_memos_posted_chk', sql`${t.state} <> 'posted' OR (${t.registerId} IS NOT NULL AND ${t.ledgerEntryId} IS NOT NULL)`),
    // Whoever took a credit memo cannot approve it.
    check('vendor_credit_memos_four_eyes_chk', sql`${t.approvedBy} IS NULL OR ${t.approvedBy} IS DISTINCT FROM ${t.assignedTo}`),
  ],
);

export const vendorCreditMemoLines = pgTable(
  'vendor_credit_memo_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    memoId: uuid('memo_id')
      .notNull()
      .references(() => vendorCreditMemos.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    invoiceLineId: uuid('invoice_line_id')
      .notNull()
      .references(() => supplierInvoiceLines.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    unit: text('unit').notNull(),
    /** quantity: some of what was billed is credited, at the price billed. price: all of it was billed too dear, by this much a unit. */
    mode: text('mode').$type<'quantity' | 'price'>().notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    netAmount: numeric('net_amount', { precision: 14, scale: 2 }).notNull(),
    taxAmount: numeric('tax_amount', { precision: 14, scale: 2 }).notNull(),
  },
  (t) => [
    uniqueIndex('vendor_credit_memo_lines_pos_uidx').on(t.memoId, t.position),
    uniqueIndex('vendor_credit_memo_lines_line_uidx').on(t.memoId, t.invoiceLineId),
    index('vendor_credit_memo_lines_invoice_line_idx').on(t.invoiceLineId),
    check('vendor_credit_memo_lines_chk', sql`${t.mode} IN ('quantity','price') AND ${t.quantity} > 0 AND ${t.unitPrice} > 0 AND ${t.netAmount} > 0 AND ${t.taxAmount} >= 0`),
  ],
);

export const vendorCreditMemoEvents = pgTable(
  'vendor_credit_memo_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    memoId: uuid('memo_id')
      .notNull()
      .references(() => vendorCreditMemos.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    fromState: text('from_state'),
    toState: text('to_state'),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vendor_credit_memo_events_idx').on(t.memoId, t.id)],
);

export type VendorCreditMemoRow = typeof vendorCreditMemos.$inferSelect;
export type VendorCreditMemoLineRow = typeof vendorCreditMemoLines.$inferSelect;

// ── Petty cash (V-7) ──

/** A cash float kept by one custodian for small payments: its own cash account, limits, and a level it is topped back up to. */
export const pettyCashFloats = pgTable(
  'petty_cash_floats',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** The cash account of its own whose ledger is the float's balance. */
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => glAccounts.id, { onDelete: 'restrict' }),
    custodianId: text('custodian_id').notNull(),
    currency: text('currency').notNull(),
    floatAmount: numeric('float_amount', { precision: 14, scale: 2 }).notNull(),
    perVoucherLimit: numeric('per_voucher_limit', { precision: 14, scale: 2 }).notNull(),
    dailyLimit: numeric('daily_limit', { precision: 14, scale: 2 }).notNull(),
    /** Below this balance no new voucher can be written until the float is topped up. */
    minimumBalance: numeric('minimum_balance', { precision: 14, scale: 2 }).notNull().default('0'),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('petty_cash_floats_code_uidx').on(t.companyId, sql`lower(${t.code})`),
    uniqueIndex('petty_cash_floats_bank_uidx').on(t.bankAccountId),
    check('petty_cash_floats_limits_chk', sql`${t.floatAmount} > 0 AND ${t.perVoucherLimit} > 0 AND ${t.dailyLimit} >= ${t.perVoucherLimit} AND ${t.minimumBalance} >= 0 AND ${t.minimumBalance} <= ${t.floatAmount}`),
  ],
);

export type PettyVoucherStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'cancelled' | 'reversed';

/** A small payment out of a float: an expense with no vendor, or a small vendor invoice. */
export const pettyCashVouchers = pgTable(
  'petty_cash_vouchers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    floatId: uuid('float_id')
      .notNull()
      .references(() => pettyCashFloats.id, { onDelete: 'restrict' }),
    /** Given when it is approved. */
    number: text('number'),
    status: text('status').$type<PettyVoucherStatus>().notNull().default('draft'),
    kind: text('kind').$type<'expense' | 'vendor_invoice'>().notNull(),
    payeeName: text('payee_name').notNull(),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'restrict' }),
    purchaseInvoiceId: uuid('purchase_invoice_id').references(() => purchaseInvoices.id, { onDelete: 'restrict' }),
    expenseAccountId: uuid('expense_account_id').references(() => glAccounts.id, { onDelete: 'restrict' }),
    description: text('description').notNull(),
    /** The number on the receipt the payee gave. */
    receiptRef: text('receipt_ref').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    createdBy: text('created_by'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sendBackReason: text('send_back_reason'),
    paidBy: text('paid_by'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidOn: date('paid_on', { mode: 'string' }),
    registerId: uuid('register_id'),
    bankLedgerEntryId: bigint('bank_ledger_entry_id', { mode: 'number' }),
    ledgerEntryId: uuid('ledger_entry_id'),
    /** The top-up that put back the cash this voucher paid out. */
    replenishmentId: uuid('replenishment_id'),
    cancelReason: text('cancel_reason'),
    reversedBy: text('reversed_by'),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reverseReason: text('reverse_reason'),
    reversalRegisterId: uuid('reversal_register_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('petty_cash_vouchers_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    index('petty_cash_vouchers_float_idx').on(t.floatId, t.status, t.createdAt),
    index('petty_cash_vouchers_paid_idx').on(t.floatId, t.paidOn).where(sql`${t.status} = 'paid'`),
    index('petty_cash_vouchers_invoice_idx').on(t.purchaseInvoiceId).where(sql`${t.purchaseInvoiceId} IS NOT NULL`),
    check('petty_cash_vouchers_status_chk', sql`${t.status} IN ('draft','pending_approval','approved','paid','cancelled','reversed')`),
    check('petty_cash_vouchers_amount_chk', sql`${t.amount} > 0`),
    check('petty_cash_vouchers_kind_chk', sql`(${t.kind} = 'vendor_invoice') = (${t.purchaseInvoiceId} IS NOT NULL) AND (${t.kind} = 'vendor_invoice' OR ${t.expenseAccountId} IS NOT NULL)`),
    // The person who wrote a voucher cannot approve it (so a custodian never approves their own).
    check('petty_cash_vouchers_approver_chk', sql`${t.approvedBy} IS NULL OR ${t.approvedBy} IS DISTINCT FROM ${t.createdBy}`),
    check('petty_cash_vouchers_paid_chk', sql`${t.status} NOT IN ('paid','reversed') OR (${t.registerId} IS NOT NULL AND ${t.paidBy} IS NOT NULL AND ${t.paidOn} IS NOT NULL)`),
  ],
);

export type PettyReplenishmentStatus = 'pending_approval' | 'approved' | 'paid' | 'cancelled';

/** Topping the float back up to its amount: money from a bank account to the float, listing the vouchers it covers. */
export const pettyCashReplenishments = pgTable(
  'petty_cash_replenishments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    floatId: uuid('float_id')
      .notNull()
      .references(() => pettyCashFloats.id, { onDelete: 'restrict' }),
    number: text('number').notNull(),
    status: text('status').$type<PettyReplenishmentStatus>().notNull().default('pending_approval'),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    fromMethodId: uuid('from_method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict' }),
    /** What the custodian's count of the cash showed against the books, in words (the cash count itself is in Finance). */
    countNote: text('count_note'),
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    paidBy: text('paid_by'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidOn: date('paid_on', { mode: 'string' }),
    reference: text('reference'),
    registerId: uuid('register_id'),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('petty_cash_replenishments_number_uidx').on(t.companyId, t.number),
    index('petty_cash_replenishments_float_idx').on(t.floatId, t.status),
    check('petty_cash_replenishments_status_chk', sql`${t.status} IN ('pending_approval','approved','paid','cancelled')`),
    check('petty_cash_replenishments_amount_chk', sql`${t.amount} > 0`),
    check('petty_cash_replenishments_approver_chk', sql`${t.approvedBy} IS NULL OR ${t.approvedBy} IS DISTINCT FROM ${t.createdBy}`),
    check('petty_cash_replenishments_paid_chk', sql`${t.status} <> 'paid' OR (${t.registerId} IS NOT NULL AND ${t.paidBy} IS NOT NULL AND ${t.reference} IS NOT NULL)`),
  ],
);

export const pettyCashEvents = pgTable(
  'petty_cash_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    subjectType: text('subject_type').$type<'float' | 'voucher' | 'replenishment'>().notNull(),
    subjectId: uuid('subject_id').notNull(),
    event: text('event').notNull(),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('petty_cash_events_idx').on(t.subjectType, t.subjectId, t.id)],
);

export type PettyCashFloatRow = typeof pettyCashFloats.$inferSelect;
export type PettyCashVoucherRow = typeof pettyCashVouchers.$inferSelect;
export type PettyCashReplenishmentRow = typeof pettyCashReplenishments.$inferSelect;

// ── Request limits ──

/** One row per key and window; the count rises by one per try. Old windows are removed when a new one starts. */
export const rateLimitHits = pgTable(
  'rate_limit_hits',
  {
    key: text('key').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    hits: integer('hits').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index('rate_limit_hits_window_idx').on(t.windowStart), check('rate_limit_hits_hits_chk', sql`${t.hits} >= 0`)],
);

// ── Refunds received from vendors (V-7 deferred item) ──

export type VendorRefundStatus = 'pending' | 'posted' | 'cancelled' | 'reversed';

/**
 * Money a vendor pays back to us: an overpayment, a payment on account, an advance or a credit memo that will not be used against
 * an invoice. It is set against that credit in the vendor ledger and books Dr bank / Cr payables (or prepayments).
 */
export const vendorRefunds = pgTable(
  'vendor_refunds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Given when the refund is posted. */
    number: text('number'),
    status: text('status').$type<VendorRefundStatus>().notNull().default('pending'),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    /** The credit the refund is set against: a vendor ledger entry of a payment, an advance or a credit memo. */
    creditEntryId: uuid('credit_entry_id')
      .notNull()
      .references(() => vendorLedgerEntries.id, { onDelete: 'restrict' }),
    creditKind: text('credit_kind').$type<'payment' | 'advance' | 'credit_memo'>().notNull(),
    creditNo: text('credit_no').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    /** The way of paying (and so the bank account) the money came in through. */
    methodId: uuid('method_id')
      .notNull()
      .references(() => paymentMethods.id, { onDelete: 'restrict' }),
    note: text('note'),
    reference: text('reference'),
    receivedOn: date('received_on', { mode: 'string' }),
    createdBy: text('created_by'),
    postedBy: text('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    registerId: uuid('register_id'),
    ledgerEntryId: uuid('ledger_entry_id'),
    bankLedgerEntryId: bigint('bank_ledger_entry_id', { mode: 'number' }),
    cancelReason: text('cancel_reason'),
    reversedBy: text('reversed_by'),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reverseReason: text('reverse_reason'),
    reversalRegisterId: uuid('reversal_register_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vendor_refunds_company_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    index('vendor_refunds_vendor_idx').on(t.vendorId, t.createdAt),
    index('vendor_refunds_credit_idx').on(t.creditEntryId).where(sql`${t.status} IN ('pending','posted')`),
    check('vendor_refunds_status_chk', sql`${t.status} IN ('pending','posted','cancelled','reversed')`),
    check('vendor_refunds_kind_chk', sql`${t.creditKind} IN ('payment','advance','credit_memo')`),
    check('vendor_refunds_amount_chk', sql`${t.amount} > 0`),
    check('vendor_refunds_poster_chk', sql`${t.postedBy} IS NULL OR ${t.postedBy} IS DISTINCT FROM ${t.createdBy}`),
    check('vendor_refunds_posted_chk', sql`${t.status} NOT IN ('posted','reversed') OR (${t.number} IS NOT NULL AND ${t.reference} IS NOT NULL AND ${t.receivedOn} IS NOT NULL AND ${t.registerId} IS NOT NULL)`),
  ],
);

export const vendorRefundEvents = pgTable(
  'vendor_refund_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => vendorRefunds.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vendor_refund_events_idx').on(t.refundId, t.id)],
);

export type VendorRefundRow = typeof vendorRefunds.$inferSelect;

// ── Purchase returns (V-7 deferred item) ──

export type PurchaseReturnStatus = 'draft' | 'posted' | 'cancelled';

/** Goods sent back to the vendor after they were received: the stock goes out at cost, and the vendor's credit memo is expected. */
export const purchaseReturns = pgTable(
  'purchase_returns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Given when the return is posted. */
    number: text('number'),
    status: text('status').$type<PurchaseReturnStatus>().notNull().default('draft'),
    rgnId: uuid('rgn_id')
      .notNull()
      .references(() => rgns.id, { onDelete: 'restrict' }),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    returnDate: date('return_date', { mode: 'string' }).notNull(),
    reason: text('reason').notNull(),
    notes: text('notes'),
    /** The vendor's own reference for the return (a return authorisation, or the credit note it sends). */
    vendorReference: text('vendor_reference'),
    createdBy: text('created_by'),
    postedBy: text('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('purchase_returns_company_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    index('purchase_returns_rgn_idx').on(t.rgnId),
    index('purchase_returns_vendor_idx').on(t.vendorId, t.createdAt),
    check('purchase_returns_status_chk', sql`${t.status} IN ('draft','posted','cancelled')`),
    check('purchase_returns_poster_chk', sql`${t.postedBy} IS NULL OR ${t.postedBy} IS DISTINCT FROM ${t.createdBy}`),
    check('purchase_returns_posted_chk', sql`${t.status} <> 'posted' OR (${t.number} IS NOT NULL AND ${t.postedAt} IS NOT NULL)`),
  ],
);

export const purchaseReturnLines = pgTable(
  'purchase_return_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => purchaseReturns.id, { onDelete: 'cascade' }),
    rgnLineId: uuid('rgn_line_id')
      .notNull()
      .references(() => rgnLines.id, { onDelete: 'restrict' }),
    poLineId: uuid('po_line_id')
      .notNull()
      .references(() => purchaseOrderLines.id, { onDelete: 'restrict' }),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    /** What the goods cost per unit, taken from the note when the return is posted. */
    unitCost: numeric('unit_cost', { precision: 14, scale: 4 }),
  },
  (t) => [
    uniqueIndex('purchase_return_lines_uidx').on(t.returnId, t.rgnLineId),
    index('purchase_return_lines_rgn_line_idx').on(t.rgnLineId),
    check('purchase_return_lines_qty_chk', sql`${t.quantity} > 0`),
  ],
);

export const purchaseReturnEvents = pgTable(
  'purchase_return_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => purchaseReturns.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('purchase_return_events_idx').on(t.returnId, t.id)],
);

export type PurchaseReturnRow = typeof purchaseReturns.$inferSelect;

// ── Purchase requisitions (design doc §23, now built) ──

export type RequisitionStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'converted' | 'cancelled';

/** An internal request to buy something: approved by another person, then turned into a request for quotation or an order. */
export const purchaseRequisitions = pgTable(
  'purchase_requisitions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Given when it is first submitted, so abandoned drafts leave no gaps. */
    number: text('number'),
    status: text('status').$type<RequisitionStatus>().notNull().default('draft'),
    title: text('title').notNull(),
    purpose: text('purpose').notNull().default(''),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => procurementCategories.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    neededBy: date('needed_by', { mode: 'string' }),
    currency: text('currency').notNull(),
    estimatedTotal: numeric('estimated_total', { precision: 14, scale: 2 }).notNull().default('0'),
    requesterId: text('requester_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    rejectReason: text('reject_reason'),
    cancelReason: text('cancel_reason'),
    /** What it became: a request for quotation or an order. */
    convertedType: text('converted_type').$type<'rfq' | 'purchase_order'>(),
    convertedId: uuid('converted_id'),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('purchase_requisitions_company_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    index('purchase_requisitions_company_status_idx').on(t.companyId, t.status, t.createdAt),
    index('purchase_requisitions_requester_idx').on(t.requesterId, t.createdAt),
    check('purchase_requisitions_status_chk', sql`${t.status} IN ('draft','submitted','approved','rejected','converted','cancelled')`),
    check('purchase_requisitions_decider_chk', sql`${t.decidedBy} IS NULL OR ${t.decidedBy} IS DISTINCT FROM ${t.requesterId}`),
    check('purchase_requisitions_converted_chk', sql`${t.status} <> 'converted' OR (${t.convertedType} IS NOT NULL AND ${t.convertedId} IS NOT NULL)`),
  ],
);

export const purchaseRequisitionLines = pgTable(
  'purchase_requisition_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    specification: text('specification'),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    unit: text('unit').notNull().default('each'),
    estimatedUnitPrice: numeric('estimated_unit_price', { precision: 14, scale: 2 }).notNull().default('0'),
  },
  (t) => [index('purchase_requisition_lines_idx').on(t.requisitionId, t.position), check('purchase_requisition_lines_qty_chk', sql`${t.quantity} > 0 AND ${t.estimatedUnitPrice} >= 0`)],
);

export const purchaseRequisitionEvents = pgTable(
  'purchase_requisition_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('purchase_requisition_events_idx').on(t.requisitionId, t.id)],
);

export type PurchaseRequisitionRow = typeof purchaseRequisitions.$inferSelect;

// ── Blanket orders / contracts (design doc §23, now built) ──

export type ContractStatus = 'draft' | 'pending_approval' | 'active' | 'closed' | 'cancelled';

/**
 * An agreement with a vendor for a period: agreed prices, and optionally the most that may be bought (in quantity per line, and in
 * value overall). Orders are called off against it; what has been called off is counted from those orders, never kept as a second figure.
 */
export const vendorContracts = pgTable(
  'vendor_contracts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Given when it is approved. */
    number: text('number'),
    status: text('status').$type<ContractStatus>().notNull().default('draft'),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => procurementCategories.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    currency: text('currency').notNull(),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }).notNull(),
    /** The most all orders called off may come to, with tax. Empty means no ceiling. */
    maxValue: numeric('max_value', { precision: 14, scale: 2 }),
    terms: text('terms'),
    createdBy: text('created_by'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectReason: text('reject_reason'),
    closeReason: text('close_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('vendor_contracts_company_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    index('vendor_contracts_vendor_idx').on(t.vendorId, t.status),
    index('vendor_contracts_company_status_idx').on(t.companyId, t.status, t.validTo),
    check('vendor_contracts_status_chk', sql`${t.status} IN ('draft','pending_approval','active','closed','cancelled')`),
    check('vendor_contracts_period_chk', sql`${t.validFrom} <= ${t.validTo}`),
    check('vendor_contracts_max_chk', sql`${t.maxValue} IS NULL OR ${t.maxValue} > 0`),
    check('vendor_contracts_approver_chk', sql`${t.approvedBy} IS NULL OR ${t.approvedBy} IS DISTINCT FROM ${t.createdBy}`),
    check('vendor_contracts_active_chk', sql`${t.status} NOT IN ('active','closed') OR ${t.number} IS NOT NULL`),
  ],
);

export const vendorContractLines = pgTable(
  'vendor_contract_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => vendorContracts.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    description: text('description').notNull(),
    specification: text('specification'),
    unit: text('unit').notNull().default('each'),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    discountPercent: numeric('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('0'),
    /** The most that may be ordered on this line over the whole contract. Empty means no limit on the line. */
    maxQuantity: numeric('max_quantity', { precision: 14, scale: 3 }),
  },
  (t) => [
    index('vendor_contract_lines_idx').on(t.contractId, t.position),
    check('vendor_contract_lines_chk', sql`${t.unitPrice} >= 0 AND ${t.discountPercent} BETWEEN 0 AND 100 AND (${t.maxQuantity} IS NULL OR ${t.maxQuantity} > 0)`),
  ],
);

export const vendorContractEvents = pgTable(
  'vendor_contract_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => vendorContracts.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vendor_contract_events_idx').on(t.contractId, t.id)],
);

export type VendorContractRow = typeof vendorContracts.$inferSelect;
export type VendorContractLineRow = typeof vendorContractLines.$inferSelect;

// ── Landed costs (design doc §23, now built) ──

export type LandedCostStatus = 'draft' | 'posted' | 'cancelled';

/**
 * A charge on top of what goods cost (freight, duty, insurance), spread over the lines of one received goods note and added to
 * what the goods in stock cost. Posting changes the products' cost, which the books follow through the existing stock revaluation.
 */
export const landedCosts = pgTable(
  'landed_costs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    /** Given when it is posted. */
    number: text('number'),
    status: text('status').$type<LandedCostStatus>().notNull().default('draft'),
    rgnId: uuid('rgn_id')
      .notNull()
      .references(() => rgns.id, { onDelete: 'restrict' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    description: text('description').notNull(),
    /** The invoice or document the charge came on. */
    reference: text('reference').notNull(),
    /** In the books' own currency. */
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    /** How it is spread: by the value of the goods, or by their quantity. */
    method: text('method').$type<'value' | 'quantity'>().notNull().default('value'),
    createdBy: text('created_by'),
    postedBy: text('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('landed_costs_company_number_uidx').on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    // One charge document is added once: the same reference on the same note and kind cannot be posted twice.
    uniqueIndex('landed_costs_reference_uidx').on(t.rgnId, t.kind, sql`lower(${t.reference})`).where(sql`${t.status} <> 'cancelled'`),
    index('landed_costs_rgn_idx').on(t.rgnId),
    check('landed_costs_status_chk', sql`${t.status} IN ('draft','posted','cancelled')`),
    check('landed_costs_method_chk', sql`${t.method} IN ('value','quantity')`),
    check('landed_costs_amount_chk', sql`${t.amount} > 0`),
    check('landed_costs_poster_chk', sql`${t.postedBy} IS NULL OR ${t.postedBy} IS DISTINCT FROM ${t.createdBy}`),
    check('landed_costs_posted_chk', sql`${t.status} <> 'posted' OR (${t.number} IS NOT NULL AND ${t.postedAt} IS NOT NULL)`),
  ],
);

/** What the charge added to each product, fixed when it is posted. */
export const landedCostLines = pgTable(
  'landed_cost_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    landedCostId: uuid('landed_cost_id')
      .notNull()
      .references(() => landedCosts.id, { onDelete: 'cascade' }),
    rgnLineId: uuid('rgn_line_id')
      .notNull()
      .references(() => rgnLines.id, { onDelete: 'restrict' }),
    productId: text('product_id').notNull(),
    quantity: numeric('quantity', { precision: 14, scale: 3 }).notNull(),
    share: numeric('share', { precision: 14, scale: 2 }).notNull(),
    costBefore: numeric('cost_before', { precision: 14, scale: 2 }),
    costAfter: numeric('cost_after', { precision: 14, scale: 2 }),
    /** What reached the stock value: units in stock times the change in cost (the cost is kept to the cent, so this can differ from the share by a few cents). */
    capitalised: numeric('capitalised', { precision: 14, scale: 2 }),
  },
  (t) => [uniqueIndex('landed_cost_lines_uidx').on(t.landedCostId, t.rgnLineId), index('landed_cost_lines_rgn_line_idx').on(t.rgnLineId)],
);

export const landedCostEvents = pgTable(
  'landed_cost_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    landedCostId: uuid('landed_cost_id')
      .notNull()
      .references(() => landedCosts.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    reasonText: text('reason_text'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('landed_cost_events_idx').on(t.landedCostId, t.id)],
);

export type LandedCostRow = typeof landedCosts.$inferSelect;

// ── Vendor scorecards (design doc §23, now built) ──

/** What a scorecard is made of: a measure taken from documents, or a rating a person gives. Weights are the company's. */
export const scorecardCriteria = pgTable(
  'scorecard_criteria',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** on_time, accepted, invoice_accuracy and rfq_response are measured; rating is given by a person. */
    source: text('source').$type<'on_time' | 'accepted' | 'invoice_accuracy' | 'rfq_response' | 'rating'>().notNull(),
    weight: integer('weight').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('scorecard_criteria_code_uidx').on(t.companyId, sql`lower(${t.code})`),
    check('scorecard_criteria_source_chk', sql`${t.source} IN ('on_time','accepted','invoice_accuracy','rfq_response','rating')`),
    check('scorecard_criteria_weight_chk', sql`${t.weight} BETWEEN 1 AND 100`),
  ],
);

/** One person's rating of a vendor on the day: kept, never changed. */
export const vendorReviews = pgTable(
  'vendor_reviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    reviewerId: text('reviewer_id'),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vendor_reviews_vendor_idx').on(t.vendorId, t.createdAt)],
);

export const vendorReviewRatings = pgTable(
  'vendor_review_ratings',
  {
    reviewId: uuid('review_id')
      .notNull()
      .references(() => vendorReviews.id, { onDelete: 'cascade' }),
    criterionId: uuid('criterion_id')
      .notNull()
      .references(() => scorecardCriteria.id, { onDelete: 'restrict' }),
    rating: integer('rating').notNull(),
  },
  (t) => [primaryKey({ columns: [t.reviewId, t.criterionId] }), index('vendor_review_ratings_criterion_idx').on(t.criterionId), check('vendor_review_ratings_chk', sql`${t.rating} BETWEEN 1 AND 5`)],
);

export type ScorecardCriterionRow = typeof scorecardCriteria.$inferSelect;

// ── Foreign currency on the payables side ──

/** What open foreign-currency payables were worth at a day's rate against what the books carry them at; undone the next day. */
export const payablesRevaluations = pgTable(
  'payables_revaluations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companySettings.id, { onDelete: 'cascade' }),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    rates: jsonb('rates').$type<Record<string, string>>().notNull(),
    /** What it added to what is owed, in the books' currency (a loss is positive). */
    net: numeric('net', { precision: 14, scale: 2 }).notNull(),
    groups: jsonb('groups').$type<Record<string, { net: string; register: string; reversal: string | null }>>().notNull(),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payables_revaluations_day_uidx').on(t.companyId, t.asOf), index('payables_revaluations_open_idx').on(t.companyId).where(sql`${t.reversedAt} IS NULL`)],
);

export type PayablesRevaluationRow = typeof payablesRevaluations.$inferSelect;

/**
 * A shopper's review of a product. Shown only once a person at the company has approved it (`status = 'approved'`).
 * One review per person per product (a change goes back to `pending`). The product's `rating` and `review_count` are
 * kept in step with the approved reviews in the same transaction that approves, rejects, changes or deletes one.
 */
export const productReviews = pgTable(
  'product_reviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    /** The signed-in account that wrote it (taken from the session, never from the browser). */
    reviewerKey: text('reviewer_key').notNull(),
    /** How the reviewer is shown: a first name and an initial, never an email address. */
    reviewerName: text('reviewer_name').notNull(),
    rating: smallint('rating').notNull(),
    title: text('title').notNull().default(''),
    body: text('body').notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
    /** Written by someone whose delivered or completed order contains this product. */
    verifiedPurchase: boolean('verified_purchase').notNull().default(false),
    orderId: text('order_id'),
    /** Why it was turned down, shown to the reviewer. */
    moderationNote: text('moderation_note').notNull().default(''),
    moderatedBy: text('moderated_by'),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('product_reviews_one_per_person_uidx').on(t.productId, t.reviewerKey),
    // The public list: approved reviews of one product, newest first.
    index('product_reviews_public_idx')
      .on(t.productId, t.createdAt, t.id)
      .where(sql`${t.status} = 'approved'`),
    // The moderation queue, oldest waiting first.
    index('product_reviews_queue_idx').on(t.status, t.createdAt, t.id),
    index('product_reviews_reviewer_idx').on(t.reviewerKey),
    check('product_reviews_rating_chk', sql`${t.rating} BETWEEN 1 AND 5`),
    check('product_reviews_status_chk', sql`${t.status} IN ('pending', 'approved', 'rejected')`),
    check('product_reviews_body_chk', sql`char_length(btrim(${t.body})) BETWEEN 10 AND 2000`),
    check('product_reviews_title_chk', sql`char_length(${t.title}) <= 100`),
  ],
);

/** Products a signed-in shopper has saved for later. Guests keep theirs in the browser. */
export const wishlistItems = pgTable(
  'wishlist_items',
  {
    userId: text('user_id').notNull(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.productId] }), index('wishlist_items_user_idx').on(t.userId, t.createdAt)],
);

/**
 * People who asked for the shop's news. Double opt-in: a row is `pending` until its link is followed, so nobody can be
 * signed up by someone else. Every message carries the `token` for a one-click unsubscribe.
 */
export const newsletterSubscribers = pgTable(
  'newsletter_subscribers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    status: text('status').$type<'pending' | 'subscribed' | 'unsubscribed'>().notNull().default('pending'),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('newsletter_subscribers_email_uidx').on(t.email),
    uniqueIndex('newsletter_subscribers_token_uidx').on(t.token),
    index('newsletter_subscribers_status_idx').on(t.status, t.createdAt),
    check('newsletter_subscribers_status_chk', sql`${t.status} IN ('pending', 'subscribed', 'unsubscribed')`),
    check('newsletter_subscribers_email_chk', sql`${t.email} = lower(btrim(${t.email})) AND char_length(${t.email}) BETWEEN 3 AND 254`),
  ],
);
