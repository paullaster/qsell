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
    /** Per-account colour scheme: light | dark | system. Null = use the app default. */
    themeMode: text('theme_mode'),
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

/** Server and client errors retained for production troubleshooting. */
export const applicationErrorLogs = pgTable(
  'application_error_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    source: text('source').notNull().default('server'),
    errorName: text('error_name').notNull(),
    message: text('message').notNull(),
    stack: text('stack'),
    digest: text('digest'),
    path: text('path'),
    method: text('method'),
    routePath: text('route_path'),
    routeType: text('route_type'),
    runtime: text('runtime'),
    requestId: text('request_id'),
    userAgent: text('user_agent'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    context: jsonb('context').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('application_error_logs_created_idx').on(t.createdAt),
    index('application_error_logs_digest_idx').on(t.digest),
    index('application_error_logs_route_idx').on(t.routePath, t.createdAt),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('categories_slug_uidx').on(t.slug),
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
    /** kg */
    weight: numeric('weight', { precision: 12, scale: 4 }),
    specifications: jsonb('specifications')
      .$type<{ key: string; value: string }[]>()
      .notNull()
      .default([]),
    stockQuantity: integer('stock_quantity').notNull().default(0),
    reservedQuantity: integer('reserved_quantity').notNull().default(0),
    lowStockThreshold: integer('low_stock_threshold').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    imageUrl: text('image_url').notNull().default(''),
    additionalImages: jsonb('additional_images').$type<string[]>().notNull().default([]),
    rating: numeric('rating', { precision: 3, scale: 2 }).notNull().default('0'),
    reviewCount: integer('review_count').notNull().default(0),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('products_sku_uidx').on(t.sku),
    uniqueIndex('products_stock_code_uidx').on(t.stockCode),
    uniqueIndex('products_slug_uidx').on(t.slug),
    index('products_category_idx').on(t.categoryId),
    index('products_item_type_idx').on(t.itemTypeId),
    index('products_active_idx').on(t.isActive),
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
    changeAmount: integer('change_amount').notNull(),
    previousStock: integer('previous_stock').notNull(),
    newStock: integer('new_stock').notNull(),
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retentionUntil: timestamp('retention_until', { withTimezone: true }),
  },
  (t) => [
    index('integration_audit_correlation_idx').on(t.correlationId),
    index('integration_audit_provider_op_idx').on(t.provider, t.operation),
    index('integration_audit_created_idx').on(t.createdAt),
    index('integration_audit_queue_job_idx').on(t.queueJobId),
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
  },
  (t) => [uniqueIndex('sales_quote_lines_number_uidx').on(t.quoteId, t.lineNumber)],
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
export type TaxCategoryRow = typeof taxCategories.$inferSelect;
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
