import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  jsonb,
  numeric,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import type { CompanyUiConfigRaw } from '@/config/company-ui';
import type {
  PaymentProviderCode,
  PaymentProviderEnvironment,
  PaymentAttemptStatus,
  EncryptedCredentialsBlob,
} from '@/server/domains/payments/types';

/** Top-level tenant. */
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
    branchId: uuid('branch_id')
      .notNull()
      .references(() => branches.id, { onDelete: 'cascade' }),
    providerCode: text('provider_code').$type<PaymentProviderCode>().notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_provider_configs_branch_provider_uidx').on(t.branchId, t.providerCode),
    index('payment_provider_configs_branch_idx').on(t.branchId),
  ],
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
    rawBody: jsonb('raw_body').$type<unknown>(),
    processingStatus: text('processing_status').notNull().default('received'),
    processingError: text('processing_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('payment_callback_events_token_idx').on(t.callbackToken),
    index('payment_callback_events_attempt_idx').on(t.paymentAttemptId),
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
    phone: text('phone'),
    role: text('role').notNull().default('customer'), // admin | manager | customer
    customerStoreId: text('customer_store_id'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_uidx').on(t.email)],
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
    paymentMethod: text('payment_method').notNull(),
    shippingCourier: text('shipping_courier'),
    trackingNumber: text('tracking_number'),
    internalNotes: text('internal_notes'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    transactionReference: text('transaction_reference'),
    mpesaReceiptNumber: text('mpesa_receipt_number'),
    pesapalTrackingId: text('pesapal_tracking_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_order_number_uidx').on(t.orderNumber),
    index('orders_customer_email_idx').on(t.customerEmail),
    index('orders_status_idx').on(t.status),
    index('orders_created_at_idx').on(t.createdAt),
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
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    totalPrice: numeric('total_price', { precision: 14, scale: 2 }).notNull(),
    imageUrl: text('image_url').notNull().default(''),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type CompanySettingsRow = typeof companySettings.$inferSelect;
export type CompanySettingsInsert = typeof companySettings.$inferInsert;
export type BranchRow = typeof branches.$inferSelect;
export type BranchInsert = typeof branches.$inferInsert;
export type PaymentProviderConfigRow = typeof paymentProviderConfigs.$inferSelect;
export type PaymentAttemptRow = typeof paymentAttempts.$inferSelect;
export type InvoiceDocumentRow = typeof invoiceDocuments.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;
export type OrderItemRow = typeof orderItems.$inferSelect;
