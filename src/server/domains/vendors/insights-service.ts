import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  purchaseInvoices,
  purchaseOrderLines,
  purchaseOrders,
  rfqInvitations,
  rfqQuotes,
  rgnLines,
  rgns,
  supplierInvoiceLines,
  supplierInvoiceMatches,
  supplierInvoices,
  vendorBankAccounts,
  vendorPaymentVouchers,
  vendors,
} from '@/server/db/drizzle/schema';
import { toCents } from '@/lib/vendor-payment';
import { WATCH_DEFAULTS, daysBetween, percent, type WatchSettings } from '@/lib/vendor-insights';

/** Orders that are still a promise to buy: approved and not yet closed or cancelled. */
const OPEN_ORDERS = ['approved', 'sent', 'confirmed', 'amendment_pending', 'partially_received', 'received', 'partially_invoiced'] as const;

/**
 * Reports across vendors (design doc §12.8, §17.4): what we have committed to buy, how vendors perform, what was bought, and a
 * watch list of things worth a second look. Everything is read from the documents themselves, company-scoped, with the work done
 * in the database (one grouped query per report, no per-vendor queries).
 */
export class VendorInsightsService {
  constructor(private readonly db: DrizzleDb) {}

  /** Open orders per vendor: what was ordered, what has come in, what has been invoiced, and what is still a commitment. */
  async commitments(companyId: string) {
    const unit = sql`(${purchaseOrderLines.lineTotal} / ${purchaseOrderLines.quantity})`;
    const sum = (expr: ReturnType<typeof sql>) => sql<string>`COALESCE(SUM(${expr}), 0)::text`;
    const rows = await this.db
      .select({
        vendorId: vendors.id,
        number: vendors.number,
        name: vendors.legalName,
        currency: purchaseOrders.currency,
        orders: sql<number>`count(DISTINCT ${purchaseOrders.id})::int`,
        ordered: sum(sql`${purchaseOrderLines.lineTotal}`),
        cancelled: sum(sql`${purchaseOrderLines.cancelledQuantity} * ${unit}`),
        received: sum(sql`${purchaseOrderLines.receivedQuantity} * ${unit}`),
        invoiced: sum(sql`${purchaseOrderLines.invoicedQuantity} * ${unit}`),
        open: sum(sql`GREATEST(${purchaseOrderLines.quantity} - ${purchaseOrderLines.cancelledQuantity} - ${purchaseOrderLines.invoicedQuantity}, 0) * ${unit}`),
        notInvoiced: sum(sql`GREATEST(${purchaseOrderLines.receivedQuantity} - ${purchaseOrderLines.invoicedQuantity}, 0) * ${unit}`),
      })
      .from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(and(eq(purchaseOrders.companyId, companyId), inArray(purchaseOrders.status, [...OPEN_ORDERS])))
      .groupBy(vendors.id, vendors.number, vendors.legalName, purchaseOrders.currency)
      .orderBy(desc(sql`sum(GREATEST(${purchaseOrderLines.quantity} - ${purchaseOrderLines.cancelledQuantity} - ${purchaseOrderLines.invoicedQuantity}, 0) * ${unit})`), asc(vendors.legalName));
    const lines = rows.map((r) => ({
      vendorId: r.vendorId,
      number: r.number,
      name: r.name,
      currency: r.currency,
      orders: r.orders,
      orderedCents: toCents(r.ordered),
      cancelledCents: toCents(r.cancelled),
      receivedCents: toCents(r.received),
      invoicedCents: toCents(r.invoiced),
      openCents: toCents(r.open),
      receivedNotInvoicedCents: toCents(r.notInvoiced),
    }));
    const total = (k: 'orderedCents' | 'receivedCents' | 'invoicedCents' | 'openCents' | 'receivedNotInvoicedCents') => lines.reduce((s, l) => s + l[k], 0);
    return { lines, totals: { orderedCents: total('orderedCents'), receivedCents: total('receivedCents'), invoicedCents: total('invoicedCents'), openCents: total('openCents'), receivedNotInvoicedCents: total('receivedNotInvoicedCents') } };
  }

  /** How each vendor did in the period: on-time delivery, rejected goods, invoices that matched, requests for quotation answered. */
  async performance(companyId: string, range: { from: string; to: string }) {
    const deliveries = await this.db
      .select({
        vendorId: rgns.vendorId,
        measured: sql<number>`count(DISTINCT ${rgns.id}) FILTER (WHERE COALESCE(${purchaseOrderLines.expectedDate}, ${purchaseOrders.expectedDate}) IS NOT NULL)::int`,
        onTime: sql<number>`count(DISTINCT ${rgns.id}) FILTER (WHERE COALESCE(${purchaseOrderLines.expectedDate}, ${purchaseOrders.expectedDate}) IS NOT NULL AND ${rgns.receivedDate} <= COALESCE(${purchaseOrderLines.expectedDate}, ${purchaseOrders.expectedDate}))::int`,
        notes: sql<number>`count(DISTINCT ${rgns.id})::int`,
        delivered: sql<string>`COALESCE(SUM(${rgnLines.delivered}), 0)::text`,
        rejected: sql<string>`COALESCE(SUM(${rgnLines.rejected}), 0)::text`,
      })
      .from(rgnLines)
      .innerJoin(rgns, eq(rgns.id, rgnLines.rgnId))
      .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, rgnLines.poLineId))
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, rgns.poId))
      .where(and(eq(rgns.companyId, companyId), eq(rgns.status, 'posted'), gte(rgns.receivedDate, range.from), lte(rgns.receivedDate, range.to)))
      .groupBy(rgns.vendorId);
    const accuracy = await this.db
      .select({
        vendorId: supplierInvoices.vendorId,
        lines: sql<number>`count(*)::int`,
        ok: sql<number>`count(*) FILTER (WHERE ${supplierInvoiceMatches.status} = 'ok')::int`,
      })
      .from(supplierInvoiceMatches)
      .innerJoin(supplierInvoiceLines, eq(supplierInvoiceLines.id, supplierInvoiceMatches.invoiceLineId))
      .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceLines.invoiceId))
      .where(and(eq(supplierInvoices.companyId, companyId), sql`${supplierInvoiceMatches.createdAt}::date BETWEEN ${range.from}::date AND ${range.to}::date`))
      .groupBy(supplierInvoices.vendorId);
    const responses = await this.db
      .select({
        vendorId: rfqInvitations.vendorId,
        invited: sql<number>`count(*)::int`,
        quoted: sql<number>`count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ${rfqQuotes} q WHERE q.rfq_id = ${rfqInvitations.rfqId} AND q.vendor_id = ${rfqInvitations.vendorId} AND q.status = 'submitted'))::int`,
        declined: sql<number>`count(*) FILTER (WHERE ${rfqInvitations.status} = 'declined')::int`,
      })
      .from(rfqInvitations)
      .innerJoin(vendors, eq(vendors.id, rfqInvitations.vendorId))
      .where(and(eq(vendors.companyId, companyId), sql`${rfqInvitations.invitedAt}::date BETWEEN ${range.from}::date AND ${range.to}::date`))
      .groupBy(rfqInvitations.vendorId);
    const ids = [...new Set([...deliveries.map((d) => d.vendorId), ...accuracy.map((a) => a.vendorId), ...responses.map((r) => r.vendorId)])];
    if (ids.length === 0) return { range, lines: [] };
    const names = await this.db.select({ id: vendors.id, name: vendors.legalName, number: vendors.number }).from(vendors).where(and(eq(vendors.companyId, companyId), inArray(vendors.id, ids)));
    const lines = names
      .map((v) => {
        const d = deliveries.find((x) => x.vendorId === v.id);
        const a = accuracy.find((x) => x.vendorId === v.id);
        const r = responses.find((x) => x.vendorId === v.id);
        const delivered = Number(d?.delivered ?? '0');
        return {
          vendorId: v.id,
          name: v.name,
          number: v.number,
          deliveries: d?.notes ?? 0,
          onTimePercent: percent(d?.onTime ?? 0, d?.measured ?? 0),
          rejectedPercent: delivered > 0 ? percent(Number(d?.rejected ?? '0'), delivered) : null,
          invoiceLines: a?.lines ?? 0,
          accuratePercent: percent(a?.ok ?? 0, a?.lines ?? 0),
          invited: r?.invited ?? 0,
          respondedPercent: percent((r?.quoted ?? 0) + (r?.declined ?? 0), r?.invited ?? 0),
        };
      })
      .sort((x, y) => x.name.localeCompare(y.name));
    return { range, lines };
  }

  /** What was bought in the period, from booked invoices, by vendor. */
  async purchases(companyId: string, range: { from: string; to: string }) {
    const rows = await this.db
      .select({
        vendorId: vendors.id,
        number: vendors.number,
        name: vendors.legalName,
        currency: purchaseInvoices.currency,
        invoices: sql<number>`count(*)::int`,
        subtotal: sql<string>`COALESCE(SUM(${purchaseInvoices.subtotal}), 0)::text`,
        tax: sql<string>`COALESCE(SUM(${purchaseInvoices.taxTotal}), 0)::text`,
        total: sql<string>`COALESCE(SUM(${purchaseInvoices.total}), 0)::text`,
      })
      .from(purchaseInvoices)
      .innerJoin(vendors, eq(vendors.id, purchaseInvoices.vendorId))
      .where(and(eq(purchaseInvoices.companyId, companyId), gte(purchaseInvoices.postingDate, range.from), lte(purchaseInvoices.postingDate, range.to)))
      .groupBy(vendors.id, vendors.number, vendors.legalName, purchaseInvoices.currency)
      .orderBy(desc(sql`sum(${purchaseInvoices.total})`), asc(vendors.legalName));
    const lines = rows.map((r) => ({ vendorId: r.vendorId, number: r.number, name: r.name, currency: r.currency, invoices: r.invoices, subtotalCents: toCents(r.subtotal), taxCents: toCents(r.tax), totalCents: toCents(r.total) }));
    return { range, lines, totalCents: lines.reduce((s, l) => s + l.totalCents, 0) };
  }

  /** Things worth a second look. It reports; it never blocks or changes anything. */
  async watchList(companyId: string, range: { from: string; to: string }, settings: WatchSettings = WATCH_DEFAULTS) {
    const duplicates = await this.db.execute<{ vendor: string; first: string; second: string; total: string; first_date: string; second_date: string }>(sql`
      SELECT v.legal_name AS vendor, a.number AS first, b.number AS second, a.total::text AS total, a.invoice_date::text AS first_date, b.invoice_date::text AS second_date
      FROM purchase_invoices a
      JOIN purchase_invoices b ON b.vendor_id = a.vendor_id AND b.total = a.total AND b.id > a.id AND abs(b.invoice_date - a.invoice_date) <= ${settings.duplicateWindowDays}
      JOIN vendors v ON v.id = a.vendor_id
      WHERE a.company_id = ${companyId} AND b.company_id = ${companyId} AND a.posting_date BETWEEN ${range.from}::date AND ${range.to}::date
      ORDER BY a.posting_date DESC LIMIT 100`);
    const sharedBanks = await this.db
      .select({ hash: vendorBankAccounts.accountHash, last4: sql<string>`max(${vendorBankAccounts.accountLast4})`, vendors: sql<string[]>`array_agg(DISTINCT ${vendors.legalName} ORDER BY ${vendors.legalName})` })
      .from(vendorBankAccounts)
      .innerJoin(vendors, eq(vendors.id, vendorBankAccounts.vendorId))
      .where(and(eq(vendors.companyId, companyId), sql`${vendorBankAccounts.status} IN ('active','pending_change')`))
      .groupBy(vendorBankAccounts.accountHash)
      .having(sql`count(DISTINCT ${vendors.id}) > 1`)
      .limit(100);
    const newVendors = await this.db
      .select({ number: vendorPaymentVouchers.number, vendor: vendors.legalName, amount: vendorPaymentVouchers.amount, paidOn: vendorPaymentVouchers.paidOn, vendorCreated: vendors.createdAt })
      .from(vendorPaymentVouchers)
      .innerJoin(vendors, eq(vendors.id, vendorPaymentVouchers.vendorId))
      .where(and(eq(vendorPaymentVouchers.companyId, companyId), eq(vendorPaymentVouchers.status, 'paid'), sql`${vendorPaymentVouchers.paidOn} BETWEEN ${range.from}::date AND ${range.to}::date`, sql`${vendorPaymentVouchers.amount} * 100 >= ${settings.newVendorAmountCents}`, sql`${vendorPaymentVouchers.paidOn} - ${vendors.createdAt}::date <= ${settings.newVendorDays}`))
      .orderBy(desc(vendorPaymentVouchers.paidOn))
      .limit(100);
    const overrides = await this.db
      .select({ number: purchaseOrders.number, vendor: vendors.legalName, total: purchaseOrders.total, noRfqReason: purchaseOrders.noRfqReason, qualificationOverrideReason: purchaseOrders.qualificationOverrideReason, orderDate: purchaseOrders.orderDate })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(vendors.id, purchaseOrders.vendorId))
      .where(and(eq(purchaseOrders.companyId, companyId), gte(purchaseOrders.orderDate, range.from), lte(purchaseOrders.orderDate, range.to), sql`(${purchaseOrders.noRfq} OR ${purchaseOrders.qualificationOverrideReason} IS NOT NULL)`, sql`${purchaseOrders.status} <> 'cancelled'`))
      .orderBy(desc(purchaseOrders.orderDate))
      .limit(100);
    return {
      range,
      settings,
      duplicateInvoices: [...duplicates].map((d) => ({ vendor: d.vendor, first: d.first, second: d.second, totalCents: toCents(d.total), firstDate: d.first_date, secondDate: d.second_date, daysApart: Math.abs(daysBetween(d.first_date, d.second_date)) })),
      sharedBankAccounts: sharedBanks.map((s) => ({ last4: s.last4, vendors: s.vendors })),
      newVendorPayments: newVendors.map((n) => ({ number: n.number, vendor: n.vendor, amountCents: toCents(n.amount), paidOn: n.paidOn, vendorAgeDays: n.paidOn === null ? 0 : daysBetween(n.vendorCreated.toISOString().slice(0, 10), n.paidOn) })),
      overriddenOrders: overrides.map((o) => ({ number: o.number, vendor: o.vendor, totalCents: toCents(o.total), orderDate: o.orderDate, reason: o.noRfqReason ?? o.qualificationOverrideReason ?? '' })),
    };
  }
}
