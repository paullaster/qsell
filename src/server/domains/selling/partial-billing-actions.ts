'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import type { PlannedBilling } from './domain/partial-billing';
import { BillingError, type OrderBillingView } from './partial-billing-service';

const ORDER_ID = /^[A-Za-z0-9_-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

const readAsks = (raw: unknown): { ok: true; asks: { orderItemId: string; quantity: number }[]; rest: boolean } | { ok: false; error: string } => {
  const input = obj(raw);
  if (input.rest === true) return { ok: true, asks: [], rest: true };
  if (!Array.isArray(input.asks) || input.asks.length === 0 || input.asks.length > 200) return { ok: false, error: 'Choose what to invoice.' };
  const asks: { orderItemId: string; quantity: number }[] = [];
  for (const entry of input.asks) {
    const e = obj(entry);
    if (typeof e.orderItemId !== 'string' || !UUID.test(e.orderItemId) || typeof e.quantity !== 'number' || !Number.isFinite(e.quantity) || e.quantity <= 0 || e.quantity > 1_000_000) return { ok: false, error: 'One of the quantities could not be read.' };
    asks.push({ orderItemId: e.orderItemId, quantity: e.quantity });
  }
  return { ok: true, asks, rest: false };
};

/** Staff: an order as the billing screen shows it (lines with what is invoiced and left, its part invoices, what may be done next). */
export async function orderBillingViewAction(orderId: unknown): Promise<{ ok: true; data: OrderBillingView | null } | { ok: false; error: string }> {
  await requirePermission('sales_invoices:read');
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return { ok: true, data: null };
  try {
    const c = getContainer();
    return { ok: true, data: await c.partialBilling.view((await c.companySettings.ensureSeeded()).id, orderId) };
  } catch (error) {
    console.error('[partial billing] view', error);
    return { ok: false, error: 'The invoices of this order could not be loaded.' };
  }
}

/** Staff: what a part invoice with these quantities would be (nothing is saved). */
export async function previewPartInvoiceAction(orderId: unknown, raw: unknown): Promise<{ ok: true; data: PlannedBilling } | { ok: false; error: string }> {
  await requirePermission('sales_invoices:create');
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return { ok: false, error: 'Choose the order.' };
  const read = readAsks(raw);
  if (!read.ok) return read;
  try {
    const c = getContainer();
    const planned = await c.partialBilling.preview((await c.companySettings.ensureSeeded()).id, orderId, { asks: read.asks, rest: read.rest });
    return planned.ok ? { ok: true, data: planned.plan } : { ok: false, error: planned.error };
  } catch (error) {
    console.error('[partial billing] preview', error);
    return { ok: false, error: 'The invoice could not be worked out just now. Please try again.' };
  }
}

/** Staff: raises a part invoice (some lines by quantity, or everything that is left): numbered from the tax invoice series and signed on its own. */
export async function issuePartInvoiceAction(orderId: unknown, raw: unknown): Promise<{ ok: true; data: { billingId: string; invoiceNumber: string; sequence: number; finishesOrder: boolean } } | { ok: false; error: string }> {
  const userId = await requirePermission('sales_invoices:create');
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return { ok: false, error: 'Choose the order.' };
  const read = readAsks(raw);
  if (!read.ok) return read;
  try {
    const c = getContainer();
    const made = await c.partialBilling.issue((await c.companySettings.ensureSeeded()).id, { userId }, orderId, { asks: read.asks, rest: read.rest });
    return made.ok ? { ok: true, data: { billingId: made.billingId, invoiceNumber: made.invoiceNumber, sequence: made.sequence, finishesOrder: made.finishesOrder } } : { ok: false, error: made.error };
  } catch (error) {
    console.error('[partial billing] issue', error);
    return { ok: false, error: 'The invoice could not be made just now. Nothing was invoiced. Please try again.' };
  }
}

/** Staff: the PDF of one part invoice, to print or download. */
export async function partInvoicePdfAction(billingId: unknown): Promise<{ ok: true; data: { filename: string; pdfBase64: string } } | { ok: false; error: string }> {
  await requirePermission('sales_invoices:send');
  if (typeof billingId !== 'string' || !UUID.test(billingId)) return { ok: false, error: 'That invoice could not be found.' };
  try {
    const made = await getContainer().invoices.generatePartPdf(billingId);
    return { ok: true, data: { filename: made.filename, pdfBase64: made.pdfBase64 } };
  } catch (error) {
    console.error('[partial billing] pdf', error);
    return { ok: false, error: 'The invoice could not be made into a document just now. Please try again.' };
  }
}

// ── The setting (its own permission) ─────────────────────────────────────

const friendly = (error: unknown): string | null => (error instanceof BillingError || error instanceof ReasonError ? error.message : null);
const reasonOf = (value: unknown): { code: string; text?: string } => {
  const r = obj(value);
  const code = typeof r.code === 'string' ? r.code : '';
  return typeof r.text === 'string' ? { code, text: r.text } : { code };
};

export interface PartialBillingScreen {
  enabled: boolean;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function partialBillingScreenAction() {
  return await runSetting('partial_billing:manage', async ({ companyId }): Promise<PartialBillingScreen> => await getContainer().partialBilling.settings(companyId), { friendly });
}

/** Switches invoicing in parts on or off, with a reason. Only for the permission that exists for this alone. */
export async function setPartialBillingAction(enabled: unknown, reason: unknown) {
  return await runSetting(
    'partial_billing:manage',
    async ({ companyId, userId }): Promise<PartialBillingScreen> => {
      if (typeof enabled !== 'boolean') throw new BillingError('Say whether invoicing in parts is on or off.');
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      await c.partialBilling.setEnabled(companyId, { type: 'user', id: userId }, enabled, reasonOf(reason));
      return await c.partialBilling.settings(companyId);
    },
    { paths: ['/admin/settings/partial-billing', '/admin/sales-orders', '/admin/sales-invoices'], friendly },
  );
}
