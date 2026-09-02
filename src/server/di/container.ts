import type { EmailPort, InvoicePdfPort } from '@/server/ports/communications';
import { PdfKitInvoiceAdapter } from '@/server/adapters/pdf/pdfkit-invoice.adapter';
import {
  ConsoleEmailAdapter,
  NodemailerSmtpAdapter,
} from '@/server/adapters/email/nodemailer.adapter';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { drizzleDb } from '@/server/db/drizzle/client';
import { CompanySettingsRepository } from '@/server/domains/company/repository';
import { InvoiceService } from '@/server/domains/invoices/service';

export interface AppContainer {
  db: DrizzleDb;
  invoicePdf: InvoicePdfPort;
  email: EmailPort;
  companySettings: CompanySettingsRepository;
  invoices: InvoiceService;
}

function createEmailPort(): EmailPort {
  const driver = (process.env.EMAIL_DRIVER || 'console').toLowerCase();
  if (driver === 'smtp') {
    return new NodemailerSmtpAdapter();
  }
  return new ConsoleEmailAdapter();
}

function createPdfPort(): InvoicePdfPort {
  const driver = (process.env.PDF_DRIVER || 'pdfkit').toLowerCase();
  if (driver === 'pdfkit') {
    return new PdfKitInvoiceAdapter();
  }
  // Default / fallback
  return new PdfKitInvoiceAdapter();
}

let container: AppContainer | null = null;

export function getContainer(): AppContainer {
  if (container) return container;

  const invoicePdf = createPdfPort();
  const email = createEmailPort();
  const companySettings = new CompanySettingsRepository(drizzleDb);
  const invoices = new InvoiceService({
    db: drizzleDb,
    companySettings,
    invoicePdf,
    email,
  });

  container = {
    db: drizzleDb,
    invoicePdf,
    email,
    companySettings,
    invoices,
  };

  return container;
}

/** Test helper — reset composition root between suites. */
export function resetContainer(): void {
  container = null;
}
