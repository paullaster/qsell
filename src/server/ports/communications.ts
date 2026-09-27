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
  sku: string;
  name: string;
  quantity: number;
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
  notes?: string | null;
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
