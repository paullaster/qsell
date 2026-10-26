import { and, asc, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { companySettings, purchaseOrderLines, purchaseOrders, vendors, type PurchaseOrderStatus } from '@/server/db/drizzle/schema';
import { buildUblOrder, parseUblInvoice } from '@/lib/ubl';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { FinanceError } from '@/server/domains/finance/errors';
import type { SupplierInvoicePortalService } from './invoice-portal-service';
import { ProfileError, type PortalActor } from './profile-service';

/** An order can be sent as a document from the moment it is approved; before that it is still being decided. */
const SENDABLE: PurchaseOrderStatus[] = ['approved', 'sent', 'confirmed', 'amendment_pending', 'partially_received', 'received', 'partially_invoiced', 'invoiced', 'closed'];

/**
 * Electronic documents in the standard UBL 2.1 format (design doc §23): a released order can be downloaded as a UBL Order, and a
 * vendor can start an invoice from a UBL Invoice instead of typing it. Reading an invoice never bypasses the invoice rules: it
 * starts the same draft a person would, with the quantities and prices the file gives, and the vendor still adds the delivery
 * note and its scan and declares it before it can be sent.
 */
export class EdiService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly invoices: SupplierInvoicePortalService,
  ) {}

  /** The order as UBL, for staff (any vendor) or, with `vendorId`, for that vendor only (anything else is "not found"). */
  async orderXml(companyId: string, poId: string, vendorId: string | null = null): Promise<{ fileName: string; xml: string }> {
    const [po] = await this.db.select().from(purchaseOrders).where(and(eq(purchaseOrders.companyId, companyId), eq(purchaseOrders.id, poId), ...(vendorId === null ? [] : [eq(purchaseOrders.vendorId, vendorId)])));
    if (po?.number == null) throw new FinanceError('NOT_FOUND', 'That order does not exist.');
    if (!SENDABLE.includes(po.status)) throw new FinanceError('NOT_RELEASED', 'An order can be downloaded once it is approved.');
    const [vendor] = await this.db.select({ name: vendors.legalName, taxId: vendors.taxId }).from(vendors).where(eq(vendors.id, po.vendorId));
    const [company] = await this.db.select({ name: companySettings.legalName, pin: companySettings.kraPin }).from(companySettings).where(eq(companySettings.id, companyId));
    const lines = await this.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)).orderBy(asc(purchaseOrderLines.position));
    const xml = buildUblOrder({
      number: po.number,
      issueDate: po.orderDate,
      currency: po.currency,
      note: po.notesToVendor ?? '',
      buyer: { name: company?.name ?? '', taxId: company?.pin ?? '' },
      seller: { name: vendor?.name ?? '', taxId: vendor?.taxId ?? '' },
      expectedDate: po.expectedDate ?? '',
      subtotal: po.subtotal,
      taxTotal: po.taxTotal,
      total: po.total,
      lines: lines.map((l) => ({ id: String(l.position + 1), description: l.description, quantity: String(Number(l.quantity)), unit: l.unit, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRate: l.taxRate, net: l.lineTotal })),
    });
    return { fileName: `${po.number}.xml`, xml };
  }

  /**
   * Starts an invoice draft from a UBL invoice for one of the vendor's own orders. Lines are matched to the order's lines by the
   * line number the file gives (our line numbers, as in the order we sent), or else by description; lines that match nothing
   * are listed, not guessed at. Returns the new draft and what was left out.
   */
  async startInvoice(actor: PortalActor, companyId: string, xml: string, now: Date = new Date()): Promise<{ id: string; warnings: string[] }> {
    const parsed = parseUblInvoice(xml);
    if (!parsed.ok) throw new ProfileError('INVALID', parsed.error);
    const inv = parsed.invoice;
    const today = businessDate(now);
    if (inv.issueDate > today) throw new ProfileError('INVALID', 'The invoice is dated in the future. Check the issue date in the file.');
    const [po] = await this.db.select().from(purchaseOrders).where(and(eq(purchaseOrders.companyId, companyId), eq(purchaseOrders.vendorId, actor.vendorId), eq(purchaseOrders.number, inv.orderNumber)));
    if (po === undefined) throw new ProfileError('NOT_FOUND', `We have no order ${inv.orderNumber} for you. Check the order number in the file.`);
    if (inv.currency !== '' && inv.currency !== po.currency) throw new ProfileError('INVALID', `The invoice is in ${inv.currency}, but order ${inv.orderNumber} is in ${po.currency}.`);
    const poLines = await this.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, po.id)).orderBy(asc(purchaseOrderLines.position));
    const warnings: string[] = [];
    const taken = new Set<string>();
    const wanted: { poLineId: string; quantity: string; unitPrice: string }[] = [];
    for (const [i, l] of inv.lines.entries()) {
      const byNumber = l.orderLineId === '' ? undefined : poLines.find((p) => String(p.position + 1) === l.orderLineId);
      const match = byNumber ?? poLines.find((p) => l.description !== '' && p.description.trim().toLowerCase() === l.description.trim().toLowerCase());
      if (match === undefined) warnings.push(`Line ${String(i + 1)} (${l.description === '' ? 'no description' : l.description}) is not a line of order ${inv.orderNumber}, so it was left out.`);
      else if (taken.has(match.id)) warnings.push(`Line ${String(i + 1)} is for an order line that is already on the invoice, so it was left out.`);
      else {
        taken.add(match.id);
        wanted.push({ poLineId: match.id, quantity: l.quantity, unitPrice: l.unitPrice });
      }
    }
    if (wanted.length === 0) throw new ProfileError('INVALID', `None of the invoice lines match a line of order ${inv.orderNumber}.`);
    const started = await this.invoices.start(actor, companyId, { poId: po.id, vendorInvoiceNo: inv.vendorInvoiceNo }, now);
    const loaded = await this.invoices.load(actor, started.id);
    const open = new Set(loaded.lines.map((l) => l.poLineId));
    const lines = wanted.filter((w) => {
      const keep = open.has(w.poLineId);
      if (!keep) warnings.push('A line was left out because no goods have been received for it yet.');
      return keep;
    });
    if (lines.length === 0) throw new ProfileError('NOTHING_TO_INVOICE', 'Nothing on the file can be invoiced yet: goods must be received first.');
    await this.invoices.save(actor, started.id, { header: { vendorInvoiceNo: inv.vendorInvoiceNo, invoiceDate: inv.issueDate, dueDate: inv.dueDate, notes: 'Started from a UBL invoice file.', declaration: false }, lines, deliveryNotes: [], invoiceFileId: '' }, now);
    return { id: started.id, warnings: [...new Set(warnings)] };
  }
}
