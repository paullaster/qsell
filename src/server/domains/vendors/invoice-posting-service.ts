import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  financeSettings,
  purchaseInvoices,
  purchaseOrderLines,
  purchaseOrders,
  rgnLines,
  supplierInvoiceLineRgn,
  supplierInvoiceLines,
  supplierInvoices,
  vendorPostingGroups,
  vendorSettings,
  vendors,
} from '@/server/db/drizzle/schema';
import { has } from '@/lib/values';
import { postingPlan, type PostingLine } from '@/lib/supplier-invoice';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { PostingEngine } from '@/server/domains/finance/engine';
import type { PostingSetupService } from '@/server/domains/finance/posting-setup-service';
import type { VendorLedgerService } from '@/server/domains/finance/payables/vendor-ledger-service';
import { fromCents, toCents } from '@/server/domains/finance/domain/receivables';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import { writeEvent } from './invoice-support';
import type { VendorNotifier } from './notifier';

const ENGINE = { canPostSoftClosed: false, canPostControlAccounts: true };

/**
 * Booking an approved supplier invoice (design doc §11.4 stage 4, §12.3). One transaction makes the booked invoice, the entry in
 * the vendor's ledger, the journal, and the invoiced quantities on the received goods and the order; if any part fails, none of
 * it happens. Stock lines clear the "received, not yet invoiced" account the receipt credited; other lines go to the account staff
 * chose; tax goes to the input tax account; the whole is owed to the vendor.
 */
export class SupplierInvoicePostingService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly engine: PostingEngine,
    private readonly setup: PostingSetupService,
    private readonly ledger: VendorLedgerService,
    private readonly notify?: VendorNotifier,
  ) {}

  async post(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string; registerId: string }> {
    const done = await this.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(supplierInvoices).where(and(eq(supplierInvoices.companyId, ctx.companyId), eq(supplierInvoices.id, id))).for('update');
      if (inv === undefined || inv.state === 'draft') throw new FinanceError('NOT_FOUND', 'That invoice does not exist.');
      if (inv.state === 'posted') throw new FinanceError('ALREADY_POSTED', 'This invoice has already been booked.');
      if (inv.state !== 'approved') throw new FinanceError('WRONG_STATE', 'Only an approved invoice can be booked.');
      if (inv.advanceBasis) throw new FinanceError('ADVANCE_INVOICE', 'An invoice for an advance is booked together with the payment of that advance, which comes with the payment vouchers. It stays approved until then.');

      const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, inv.vendorId));
      if (vendor === undefined || vendor.block === 'all') throw new FinanceError('VENDOR_BLOCKED', 'This vendor is blocked, so its invoice cannot be booked.');
      if (vendor.postingGroupId === null) throw new FinanceError('POSTING_GROUP', `${vendor.legalName} has no posting group. Choose one on the vendor’s financial settings first.`);
      const [group] = await tx.select().from(vendorPostingGroups).where(eq(vendorPostingGroups.id, vendor.postingGroupId));
      if (group?.payablesAccountId == null) throw new FinanceError('POSTING_GROUP', 'The vendor’s posting group has no payables account.');
      const [fs] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, ctx.companyId));
      if (fs === undefined) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
      if (inv.currency !== fs.baseCurrency) throw new FinanceError('FOREIGN_CURRENCY', `This invoice is in ${inv.currency}. Booking in another currency needs an exchange rate, which comes with the payment vouchers.`);

      const lines = await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, id)).orderBy(asc(supplierInvoiceLines.position));
      const links = await tx.select().from(supplierInvoiceLineRgn).where(inArray(supplierInvoiceLineRgn.invoiceLineId, lines.map((l) => l.id)));
      const orderLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, inv.poId));
      const poLine = new Map(orderLines.map((l) => [l.id, l]));

      const plan: PostingLine[] = lines.map((l) => {
        const stock = poLine.get(l.poLineId)?.productId != null;
        if (!stock && l.glAccountId === null) throw new FinanceError('ACCOUNT_MISSING', `Line ${String(l.position)} has no account to be booked to.`);
        return { kind: stock ? 'stock' : 'account', accountId: l.glAccountId, netCents: toCents(l.netAmount) };
      });
      const taxCents = toCents(inv.taxTotal);
      const built = postingPlan(plan, taxCents);
      if (built.payableCents !== toCents(inv.total)) throw new FinanceError('TOTAL_MISMATCH', 'The lines do not add up to the invoice total. Return the invoice to the vendor.');

      const date = businessDate(now);
      const [settings] = await tx.select().from(vendorSettings).where(eq(vendorSettings.companyId, ctx.companyId));
      if (taxCents > 0 && (settings?.inputTaxAccountId ?? null) === null) throw new FinanceError('TAX_ACCOUNT_MISSING', 'This invoice has tax and no input tax account is set. Choose one in the ordering rules.');
      if (built.debits.some((d) => d.purpose === 'inventory_clearing') && fs.inventoryGlGoLive === null) {
        throw new FinanceError('STOCK_NOT_LIVE', 'Stock is not in the books yet, so goods that were received cannot be cleared. Start stock accounting first.');
      }

      const journal: { accountId: string; debit: string; credit: string; description: string; sourceLedger?: string; sourceEntryId?: string }[] = [];
      for (const d of built.debits) {
        let accountId = d.accountId;
        if (d.purpose === 'inventory_clearing') {
          try {
            accountId = (await this.setup.resolveGeneral(ctx.companyId, fs.defaultBusinessGroup, fs.defaultProductGroup, 'inventory_clearing', date)).accountId;
          } catch (error) {
            throw new FinanceError('POSTING_SETUP_MISSING', error instanceof Error ? error.message : 'Posting setup is incomplete.');
          }
        }
        if (!has(accountId)) throw new FinanceError('ACCOUNT_MISSING', 'A line has no account to be booked to.');
        journal.push({ accountId, debit: fromCents(d.cents), credit: '0', description: d.purpose === 'inventory_clearing' ? 'Goods received, now invoiced' : 'Supplier invoice' });
      }
      if (taxCents > 0 && settings?.inputTaxAccountId != null) journal.push({ accountId: settings.inputTaxAccountId, debit: fromCents(taxCents), credit: '0', description: 'Input tax on supplier invoice' });
      journal.push({ accountId: group.payablesAccountId, debit: '0', credit: fromCents(built.payableCents), description: `${vendor.legalName}: ${inv.vendorInvoiceNo}`, sourceLedger: 'vendor', sourceEntryId: vendor.id });

      // The goods and the order are claimed first, so a race with another invoice stops here and rolls the whole booking back.
      for (const k of links) {
        const claimed = await tx
          .update(rgnLines)
          .set({ invoicedQuantity: sql`${rgnLines.invoicedQuantity} + ${k.quantity}::numeric` })
          .where(and(eq(rgnLines.id, k.rgnLineId), sql`${rgnLines.invoicedQuantity} + ${k.quantity}::numeric <= ${rgnLines.accepted}`))
          .returning({ id: rgnLines.id });
        if (claimed.length === 0) throw new FinanceError('ALREADY_INVOICED', 'Some of these goods were invoiced by another invoice in the meantime. Link them again.');
      }
      for (const l of lines) {
        await tx.update(purchaseOrderLines).set({ invoicedQuantity: sql`${purchaseOrderLines.invoicedQuantity} + ${l.quantity}::numeric` }).where(eq(purchaseOrderLines.id, l.poLineId));
      }
      const after = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, inv.poId));
      const allInvoiced = after.every((l) => Number(l.invoicedQuantity) >= Number(l.quantity) - Number(l.cancelledQuantity));
      const [po] = await tx.select({ status: purchaseOrders.status }).from(purchaseOrders).where(eq(purchaseOrders.id, inv.poId)).for('update');
      if (po !== undefined && !['closed', 'cancelled'].includes(po.status)) {
        let next: 'invoiced' | 'partially_invoiced' | null = null;
        if (allInvoiced) next = 'invoiced';
        else if (po.status === 'received') next = 'partially_invoiced';
        if (next !== null) await tx.update(purchaseOrders).set({ status: next, updatedAt: now }).where(eq(purchaseOrders.id, inv.poId));
      }

      const pinvId = randomUUID();
      const ledgerId = randomUUID();
      const { number } = await this.numbering.assign('purchase_invoice', { companyId: ctx.companyId, branchId: null, date, document: { kind: 'purchase_invoice', id: pinvId } }, tx);
      const { registerId } = await this.engine.post(
        {
          companyId: ctx.companyId,
          idempotencyKey: `supplier-invoice:${id}`,
          postingDate: date,
          documentDate: inv.invoiceDate,
          documentType: 'purchase_invoice',
          documentNo: number,
          description: `${vendor.legalName}: invoice ${inv.vendorInvoiceNo}`,
          currency: fs.baseCurrency,
          rate: '1',
          rateSource: 'base',
          lines: journal.map((j) => ({ ...j, sourceEntryId: j.sourceEntryId })),
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'supplier_invoice', id },
          postedBy: 'engine',
        },
        ENGINE,
        tx,
      );
      await this.ledger.addEntry(tx, {
        id: ledgerId,
        companyId: ctx.companyId,
        vendorId: vendor.id,
        documentType: 'invoice',
        documentNo: number,
        externalDocumentNo: inv.vendorInvoiceNo,
        documentId: pinvId,
        description: `Invoice ${inv.vendorInvoiceNo}`,
        amountCents: built.payableCents,
        currency: inv.currency,
        postingDate: date,
        documentDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        registerId,
        idempotencyKey: `supplier-invoice:${id}`,
        createdBy: ctx.actor.id,
      });
      await tx.insert(purchaseInvoices).values({ id: pinvId, companyId: ctx.companyId, number, supplierInvoiceId: id, vendorId: vendor.id, vendorInvoiceNo: inv.vendorInvoiceNo, currency: inv.currency, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, postingDate: date, subtotal: inv.subtotal, taxTotal: inv.taxTotal, total: inv.total, registerId, ledgerEntryId: ledgerId, postedBy: ctx.actor.id });
      await tx.update(supplierInvoices).set({ state: 'posted', purchaseInvoiceId: pinvId, postedAt: now, postedBy: ctx.actor.id, updatedAt: now }).where(eq(supplierInvoices.id, id));
      await writeEvent(tx, ctx.actor, id, 'posted', 'approved', 'posted', { data: { purchaseInvoice: number, registerId, total: inv.total } });
      return { number, registerId, inv };
    });
    await this.notify?.invoiceBooked(done.inv.vendorId, done.inv.number ?? '', done.inv.vendorInvoiceNo, done.inv.total, done.inv.currency);
    return { number: done.number, registerId: done.registerId };
  }
}
