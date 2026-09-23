import { sql } from 'drizzle-orm';
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
  type AnyPgColumn,
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
    customerStoreId: text('customer_store_id'),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'set null' }),
    /** Bumped on every grant change so the access-control cache can invalidate eagerly. */
    permissionsVersion: integer('permissions_version').notNull().default(0),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
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
    paymentMethod: text('payment_method').notNull(),
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
    transmitInvoicesToKra: boolean('transmit_invoices_to_kra').notNull().default(false),
    kraTransmissionStatus: text('kra_transmission_status').notNull().default('not_applicable'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_order_number_uidx').on(t.orderNumber),
    index('orders_customer_email_idx').on(t.customerEmail),
    index('orders_status_idx').on(t.status),
    index('orders_created_at_idx').on(t.createdAt),
    index('orders_dimension_set_idx').on(t.dimensionSetId),
    index('orders_trade_customer_idx').on(t.tradeCustomerId),
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
    transmitInvoicesToKra: boolean('transmit_invoices_to_kra').notNull().default(false),
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
    transmitInvoicesToKra: boolean('transmit_invoices_to_kra').notNull().default(false),
    buyerKraPin: text('buyer_kra_pin'),
    dimensionSetId: uuid('dimension_set_id').references(() => dimensionSets.id, {
      onDelete: 'set null',
    }),
    dimensionCodes: jsonb('dimension_codes')
      .$type<{ global: Record<string, string>; shortcut: Record<string, string> }>()
      .notNull()
      .default({ global: {}, shortcut: {} }),
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
  },
  (t) => [
    index('customer_ledger_customer_idx').on(t.customerId),
    index('customer_ledger_order_idx').on(t.orderId),
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
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
    totalPrice: numeric('total_price', { precision: 14, scale: 2 }).notNull(),
    imageUrl: text('image_url').notNull().default(''),
  },
  (t) => [index('order_items_order_idx').on(t.orderId)],
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
export type InvoiceDocumentRow = typeof invoiceDocuments.$inferSelect;
export type UserRow = typeof users.$inferSelect;
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
