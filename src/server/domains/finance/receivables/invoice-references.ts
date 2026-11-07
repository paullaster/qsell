import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customerLedgerEntries, invoiceDocuments, orderItems, orders } from '@/server/db/drizzle/schema';
import type { InvoiceLineView, InvoiceReferenceView } from '@/lib/invoice-reference';
import type { Tx } from '../engine';

import { has } from '@/lib/values';

/**
 * For ledger invoice entries: the invoice number the customer was given, the order behind it and the lines sold.
 * Three batched reads whatever the number of entries, scoped to the company; an entry without an order simply has no lines.
 */
export async function loadInvoiceReferences(db: DrizzleDb | Tx, companyId: string, entryIds: string[]): Promise<Map<string, InvoiceReferenceView>> {
  const out = new Map<string, InvoiceReferenceView>();
  const ids = [...new Set(entryIds)];
  if (ids.length === 0) return out;
  const entries = await db
    .select({ id: customerLedgerEntries.id, orderId: customerLedgerEntries.orderId, documentNo: customerLedgerEntries.documentNo })
    .from(customerLedgerEntries)
    .where(and(eq(customerLedgerEntries.companyId, companyId), inArray(customerLedgerEntries.id, ids)));
  const orderIds = [...new Set(entries.map((e) => e.orderId).filter(has))];
  const [orderRows, docs, items] =
    orderIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(inArray(orders.id, orderIds)),
          db
            .select({ orderId: invoiceDocuments.orderId, invoiceNumber: invoiceDocuments.invoiceNumber })
            .from(invoiceDocuments)
            .where(and(inArray(invoiceDocuments.orderId, orderIds), eq(invoiceDocuments.documentType, 'tax_invoice')))
            .orderBy(asc(invoiceDocuments.createdAt)),
          db
            .select({ orderId: orderItems.orderId, name: orderItems.productName, sku: orderItems.sku, quantity: orderItems.quantity, unit: orderItems.unitCode, unitPrice: orderItems.unitPrice, total: orderItems.totalPrice, gift: orderItems.isGift })
            .from(orderItems)
            .where(inArray(orderItems.orderId, orderIds))
            .orderBy(asc(orderItems.orderId), asc(orderItems.productName), asc(orderItems.id)),
        ]);
  const orderNumber = new Map(orderRows.map((o) => [o.id, o.orderNumber]));
  const invoiceNo = new Map<string, string>();
  for (const d of docs) if (!invoiceNo.has(d.orderId)) invoiceNo.set(d.orderId, d.invoiceNumber);
  const lines = new Map<string, InvoiceLineView[]>();
  for (const i of items) {
    const list = lines.get(i.orderId) ?? [];
    list.push({ name: i.name, sku: i.sku, quantity: String(i.quantity), unit: i.unit, unitPrice: i.unitPrice, total: i.total, gift: i.gift });
    lines.set(i.orderId, list);
  }
  for (const e of entries) {
    out.set(e.id, {
      documentNo: e.documentNo,
      invoiceNo: has(e.orderId) ? (invoiceNo.get(e.orderId) ?? null) : null,
      orderNumber: has(e.orderId) ? (orderNumber.get(e.orderId) ?? null) : null,
      orderId: has(e.orderId) ? e.orderId : null,
      lines: has(e.orderId) ? (lines.get(e.orderId) ?? []) : [],
    });
  }
  return out;
}
