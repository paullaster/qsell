import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { rfqs, purchaseOrders, supplierInvoices, vendorAdvancePayments, vendorPaymentVouchers, vendors } from '@/server/db/drizzle/schema';
import type { DocumentHandler } from '@/server/kernel/approvals/engine';
import type { FinanceContext } from '@/server/domains/finance/errors';
import { vendorApprovals, type VendorApprovalKind } from './approval-gate';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const PAYS = { invoices: 'invoices', advance: 'an advance', on_account: 'on account' } as const;

const money = (amount: string, currency: string): string => `${currency} ${Number(amount).toLocaleString('en-KE', { minimumFractionDigits: 2 })}`;

/** The context an approval is carried out under: the person whose approval completed the workflow. Their own limits and four-eyes rules still apply. */
async function released(tx: Tx, kind: VendorApprovalKind, id: string, companyId: string, action: string): Promise<FinanceContext> {
  const by = await vendorApprovals.lastApprover(tx, kind, id);
  return { companyId, actor: { type: 'user', id: by ?? 'approvals' }, origin: { surface: 'approvals', action, permissionUsed: null } };
}

/**
 * How the approval engine holds, releases, refuses and reopens each vendor document. The services own the documents and their rules;
 * a release runs the same approval a person would run, so the separation of duties and every check still apply.
 */
export function vendorApprovalHandlers(db: DrizzleDb): Record<VendorApprovalKind, DocumentHandler> {
  const services = async () => (await import('@/server/di/container')).getContainer();
  const dropProposal = async (tx: Tx, id: string, why: string): Promise<void> => {
    const [r] = await tx.select({ companyId: rfqs.companyId }).from(rfqs).where(eq(rfqs.id, id));
    if (r === undefined) return;
    await (await services()).rfqEvaluation.dropProposal(tx, { companyId: r.companyId, actor: { type: 'system', id: null }, origin: { surface: 'approvals', action: 'drop_award' } }, id, why);
  };
  const vendorName = async (vendorId: string): Promise<string> => (await db.select({ n: vendors.legalName }).from(vendors).where(eq(vendors.id, vendorId)))[0]?.n ?? 'the vendor';
  return {
    rfq_award: {
      onReleased: async (id, tx) => {
        const [r] = await tx.select({ companyId: rfqs.companyId }).from(rfqs).where(eq(rfqs.id, id));
        if (r === undefined) return;
        const c = await services();
        const done = await c.rfqEvaluation.releaseAward(tx, await released(tx, 'rfq_award', id, r.companyId, 'approve_award'), id);
        await c.rfqEvaluation.tellReleased(done);
      },
      onRejected: async (id, tx, info) => await dropProposal(tx, id, info.comment),
      onReopened: async (id, tx) => await dropProposal(tx, id, 'The approval was reopened.'),
      onCanceled: async (id, tx) => await dropProposal(tx, id, 'The approval request was withdrawn.'),
      describe: async (id) => {
        const [r] = await db.select().from(rfqs).where(eq(rfqs.id, id));
        if (r === undefined) return null;
        return { title: `Award of request ${r.number ?? ''} ${r.title}.`, lines: [] };
      },
    },
    vendor_po: {
      onReleased: async (id, tx) => {
        const [po] = await tx.select({ companyId: purchaseOrders.companyId }).from(purchaseOrders).where(eq(purchaseOrders.id, id));
        if (po === undefined) return;
        await (await services()).purchaseOrders.approveIn(tx, await released(tx, 'vendor_po', id, po.companyId, 'release_po'), id);
      },
      onRejected: async (id, tx, info) => await (await services()).purchaseOrders.backFromWorkflow(tx, id, info.comment),
      onReopened: async (id, tx) => await (await services()).purchaseOrders.backFromWorkflow(tx, id, 'The approval was reopened.'),
      onCanceled: async (id, tx) => await (await services()).purchaseOrders.backFromWorkflow(tx, id, 'The approval request was withdrawn.'),
      describe: async (id) => {
        const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, id));
        if (po === undefined) return null;
        return { title: `Purchase order to ${await vendorName(po.vendorId)} for ${money(po.total, po.currency)}.`, lines: [po.noRfq ? 'Ordered without a request for quotation.' : '', po.qualificationOverrideReason === null ? '' : `Vendor not qualified in the category: ${po.qualificationOverrideReason}`].filter((l) => l !== '') };
      },
    },
    vendor_invoice: {
      onReleased: async (id, tx) => {
        const [inv] = await tx.select({ companyId: supplierInvoices.companyId }).from(supplierInvoices).where(eq(supplierInvoices.id, id));
        if (inv === undefined) return;
        await (await services()).supplierInvoices.approveIn(tx, await released(tx, 'vendor_invoice', id, inv.companyId, 'approve_invoice'), id);
      },
      onRejected: async (id, tx, info) => await (await services()).supplierInvoices.backFromWorkflow(tx, id, info.comment),
      onReopened: async (id, tx) => await (await services()).supplierInvoices.backFromWorkflow(tx, id, 'The approval was reopened.'),
      onCanceled: async (id, tx) => await (await services()).supplierInvoices.backFromWorkflow(tx, id, 'The approval request was withdrawn.'),
      describe: async (id) => {
        const [inv] = await db.select().from(supplierInvoices).where(eq(supplierInvoices.id, id));
        if (inv === undefined) return null;
        return { title: `Supplier invoice ${inv.vendorInvoiceNo} from ${await vendorName(inv.vendorId)} for ${money(inv.total, inv.currency)}.`, lines: [inv.matchOverrideReason === null ? '' : `The check found differences, accepted because: ${inv.matchOverrideReason}`].filter((l) => l !== '') };
      },
    },
    vendor_payment: {
      onReleased: async (id, tx) => {
        const [v] = await tx.select({ companyId: vendorPaymentVouchers.companyId }).from(vendorPaymentVouchers).where(eq(vendorPaymentVouchers.id, id));
        if (v === undefined) return;
        await (await services()).vendorPayments.approveIn(tx, await released(tx, 'vendor_payment', id, v.companyId, 'approve_payment'), id);
      },
      onRejected: async (id, tx, info) => await (await services()).vendorPayments.backFromWorkflow(tx, id, info.comment),
      onReopened: async (id, tx) => await (await services()).vendorPayments.backFromWorkflow(tx, id, 'The approval was reopened.'),
      onCanceled: async (id, tx) => await (await services()).vendorPayments.backFromWorkflow(tx, id, 'The approval request was withdrawn.'),
      describe: async (id) => {
        const [v] = await db.select().from(vendorPaymentVouchers).where(eq(vendorPaymentVouchers.id, id));
        if (v === undefined) return null;
        return { title: `Payment of ${money(v.amount, v.currency)} to ${await vendorName(v.vendorId)}.`, lines: [`Pays ${PAYS[v.kind]}.`] };
      },
    },
    vendor_advance: {
      onReleased: async (id, tx) => {
        const [a] = await tx.select({ companyId: vendorAdvancePayments.companyId }).from(vendorAdvancePayments).where(eq(vendorAdvancePayments.id, id));
        if (a === undefined) return;
        const c = await services();
        const done = await c.advances.approveIn(tx, await released(tx, 'vendor_advance', id, a.companyId, 'approve_advance'), id);
        await c.advances.tellApproved(done);
      },
      onRejected: async (id, tx, info) => await (await services()).advances.backFromWorkflow(tx, id, info.comment),
      onReopened: async (id, tx) => await (await services()).advances.backFromWorkflow(tx, id, 'The approval was reopened.'),
      onCanceled: async (id, tx) => await (await services()).advances.backFromWorkflow(tx, id, 'The approval request was withdrawn.'),
      describe: async (id) => {
        const [a] = await db.select().from(vendorAdvancePayments).where(eq(vendorAdvancePayments.id, id));
        if (a === undefined) return null;
        return { title: `Advance of ${money(a.amount, a.currency)} to ${await vendorName(a.vendorId)}.`, lines: [] };
      },
    },
  };
}
