import type { DocumentLayouts } from '@/lib/document-layouts';

/**
 * Communication & document ports (DI).
 * Adapters implement these interfaces; domain services depend on ports only.
 */

export interface CompanyProfile {
  legalName: string;
  tradingName: string;
  email: string;
  phone: string;
  tel?: string | null;
  website?: string | null;
  streetAddress: string;
  city: string;
  countyOrState: string;
  postalCode: string;
  country: string;
  locationLabel?: string | null;
  tagline?: string | null;
  kraPin: string;
  vatNumber?: string | null;
  registrationNumber?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankBranch?: string | null;
  documentLayouts?: DocumentLayouts;
  /** Legacy invoice-only note retained for compatibility with older integrations. */
  invoiceFooterNote?: string | null;
  invoicePrefix: string;
  logoUrl?: string | null;
  primaryColor: string;
  accentColor: string;
}

export interface InvoiceLineItem {
  kind?: 'section' | 'item';
  sectionTotal?: number;
  sectionDescription?: string | null;
  /** The section's own items, listed under its title when it is set to show them. */
  sectionLines?: {
    sku: string;
    name: string;
    quantity: number;
    /** The unit `quantity` is in (kg, crate), when it has one. */
    unit?: string | null;
    unitPrice: number;
    totalPrice: number;
  }[];
  sku: string;
  name: string;
  quantity: number;
  /** The unit `quantity` is in (kg, crate), when it has one. */
  unit?: string | null;
  unitPrice: number;
  totalPrice: number;
}

export interface InvoicePayload {
  documentType: 'tax_invoice' | 'proforma' | 'sales_quote';
  invoiceNumber: string;
  issuedAt: string;
  orderId: string;
  orderNumber: string;
  currency: string;
  company: CompanyProfile;
  customer: {
    name: string;
    email: string;
    phone: string;
    kraPin?: string | null;
    shippingAddress: {
      street: string;
      city: string;
      countyOrState: string;
      postalCode?: string;
      country: string;
    };
  };
  items: InvoiceLineItem[];
  subtotal: number;
  tax: number;
  taxLabel?: string;
  /** The tax in its parts (on the products, on the delivery, in all). When given, these rows are shown instead of the single tax row, and the shipping row is left out when it is nothing. */
  taxRows?: { label: string; amount: number }[];
  /** What the document is called when it is not the plain tax invoice (for example the invoice of the delivery service). */
  documentTitle?: string | null;
  shippingFee: number;
  totalAmount: number;
  paymentMethod: string;
  paymentReference?: string | null;
  paymentStatus: string;
  customerReference?: string | null;
  notes?: string | null;
  showBillingAddress?: boolean;
  billingInformation?: {
    name: string;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    taxId?: string | null;
  } | null;
  paymentDetails?: string | null;
  paymentTerms?: string | null;
  termsAndConditions?: string | null;
  validUntil?: string | null;
}

export interface InvoicePdfPort {
  readonly name: string;
  generate(payload: InvoicePayload): Promise<Buffer>;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
  /** Where an answer should go, when it is not the business address given in `sender`. Left off when it is not a real address. */
  replyTo?: string;
  /**
   * The business this mail speaks for: its name and its own address. How that appears (as From, or as the display name and Reply-To
   * of the instance's mailbox) is decided by the deployment's settings, because mail servers differ on what From they accept.
   */
  sender?: { name?: string; address?: string };
}

export interface EmailSendResult {
  messageId: string;
  provider: string;
}

export interface EmailPort {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}
