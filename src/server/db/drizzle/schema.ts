import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  integer,
  jsonb,
  numeric,
} from 'drizzle-orm/pg-core';

/** Singleton-style company profile used on invoices / receipts / emails. */
export const companySettings = pgTable('company_settings', {
  id: uuid('id').defaultRandom().primaryKey(),
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
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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

export type CompanySettingsRow = typeof companySettings.$inferSelect;
export type CompanySettingsInsert = typeof companySettings.$inferInsert;
export type InvoiceDocumentRow = typeof invoiceDocuments.$inferSelect;
