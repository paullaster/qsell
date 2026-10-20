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
  sectionLines?: Array<{
    sku: string;
    name: string;
    quantity: number;
    /** The unit `quantity` is in (kg, crate), when it has one. */
    unit?: string | null;
    unitPrice: number;
    totalPrice: number;
  }>;
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
  replyTo?: string;
  fromOverride?: string;
}

export interface EmailSendResult {
  messageId: string;
  provider: string;
}

export interface EmailPort {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}
