import { and, asc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { invoiceDocuments, orders, salesQuotes } from '@/server/db/drizzle/schema';

/** The documents before and after an order: the quote it was made from, and the invoices raised for it (deliveries and credit notes have their own panels). */
export interface RelatedDocuments {
  orderNumber: string;
  quote: { id: string; number: string; status: string; total: number; currency: string } | null;
  invoices: { number: string; type: string; total: number; currency: string; createdAt: string; emailed: boolean }[];
}

/** What belongs with an order, for the document flow shown on it. */
export class OrderDocumentsService {
  constructor(private readonly db: DrizzleDb) {}

  async of(companyId: string, orderId: string): Promise<RelatedDocuments | null> {
    const [order] = await this.db.select({ orderNumber: orders.orderNumber, sourceQuoteId: orders.sourceQuoteId }).from(orders).where(eq(orders.id, orderId)).limit(1);
    if (order === undefined) return null;
    const [quote] =
      order.sourceQuoteId === null
        ? []
        : await this.db
            .select({ id: salesQuotes.id, number: salesQuotes.quoteNumber, status: salesQuotes.status, total: salesQuotes.totalAmount, currency: salesQuotes.currency })
            .from(salesQuotes)
            .where(and(eq(salesQuotes.id, order.sourceQuoteId), eq(salesQuotes.companyId, companyId)))
            .limit(1);
    const invoices = await this.db
      .select({ number: invoiceDocuments.invoiceNumber, type: invoiceDocuments.documentType, total: invoiceDocuments.totalAmount, currency: invoiceDocuments.currency, createdAt: invoiceDocuments.createdAt, emailedAt: invoiceDocuments.emailedAt })
      .from(invoiceDocuments)
      .where(eq(invoiceDocuments.orderId, orderId))
      .orderBy(asc(invoiceDocuments.createdAt));
    return {
      orderNumber: order.orderNumber,
      quote: quote === undefined ? null : { id: quote.id, number: quote.number, status: quote.status, total: Number(quote.total), currency: quote.currency },
      invoices: invoices.map((i) => ({ number: i.number, type: i.type, total: Number(i.total), currency: i.currency, createdAt: i.createdAt.toISOString(), emailed: i.emailedAt !== null })),
    };
  }
}
