'use server';

import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { paymentMethods, paymentProviderConfigs, providerOperations, type BillInvoiceStatus } from '@/server/db/drizzle/schema';
import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { DARAJA_OPERATIONS, validateOperationInput } from './daraja/catalog';
import { OperationRefused } from './daraja/operations';

const PAGE = '/admin/payments/bills';
const BILL_OPS = ['bill_optin', 'bill_update_optin', 'bill_invoice', 'bill_invoice_bulk', 'bill_cancel', 'bill_cancel_bulk', 'bill_acknowledge'];
const MAX_BATCH = 1000;
const COLUMNS = ['externalReference', 'billedFullName', 'billedPhoneNumber', 'billedPeriod', 'invoiceName', 'dueDate', 'accountReference', 'amount'] as const;

/** How many invoices a recorded request covers: its list of invoices or references, else one. */
function requestCount(input: Record<string, unknown>): number {
  if (Array.isArray(input.invoices)) return input.invoices.length;
  return Array.isArray(input.references) ? input.references.length : 1;
}

export async function billsOverviewAction() {
  return await run('payment_activity:read', { surface: 'payments/bills', action: 'view' }, async (ctx) => {
    const methods = await drizzleDb
      .select({ id: paymentMethods.id, name: paymentMethods.name, channel: paymentMethods.channelNumber, providerId: paymentMethods.providerId, provider: paymentProviderConfigs.displayName })
      .from(paymentMethods)
      .innerJoin(paymentProviderConfigs, eq(paymentProviderConfigs.id, paymentMethods.providerId))
      .where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentProviderConfigs.providerCode, 'mpesa_daraja'), eq(paymentMethods.channelKind, 'paybill'), isNotNull(paymentMethods.channelNumber)))
      // Only the first, to start the picker and to know there is one: the rest are searched on demand.
      .orderBy(asc(paymentMethods.name), asc(paymentMethods.id))
      .limit(1);
    const recent = await drizzleDb
      .select()
      .from(providerOperations)
      .where(and(eq(providerOperations.companyId, ctx.companyId), inArray(providerOperations.operation, BILL_OPS)))
      .orderBy(desc(providerOperations.createdAt))
      .limit(40);
    const notices = await getContainer().paymentEngine.activity.events(ctx.companyId, { limit: 200 });
    return {
      methods: methods.filter((m) => m.channel !== null && m.channel !== '').map((m) => ({ id: m.id, name: m.name, channel: m.channel, providerId: m.providerId, provider: m.provider })),
      recent: recent.map((o) => {
        const i = o.input;
        const count = requestCount(i);
        return { id: o.id, operation: o.operation, status: o.status, count, reference: typeof i.externalReference === 'string' ? i.externalReference : null, failureReason: o.failureReason, at: o.createdAt.toISOString() };
      }),
      notices: notices.filter((e) => e.ev.kind === 'bill').length,
      counts: await getContainer().paymentEngine.bills.counts(ctx.companyId),
      columns: [...COLUMNS],
      can: { run: await canPermission('payment_operations:run') },
    };
  });
}

const split = (line: string) => line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim().replace(/^"|"$/g, ''));

/** One invoice per line: invoice number, customer, phone, period, what for, due date, account number, amount. */
export async function sendInvoicesAction(input: { methodId: string; text: string }) {
  return await run('payment_operations:run', { surface: 'payments/bills', action: 'send_invoices' }, async (ctx) => {
    const lines = input.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && /^invoice/i.test(lines[0])) lines.shift();
    if (lines.length === 0) throw new FinanceError('NOTHING_TO_SEND', 'Paste at least one invoice.');
    if (lines.length > MAX_BATCH) throw new FinanceError('TOO_MANY', `Send at most ${MAX_BATCH} invoices at a time.`);
    const info = DARAJA_OPERATIONS.bill_invoice;
    const invoices: Record<string, unknown>[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    lines.forEach((line, i) => {
      const cells = split(line);
      if (cells.length < COLUMNS.length) return void problems.push(`Line ${i + 1}: expected ${COLUMNS.length} values, found ${cells.length}.`);
      const raw = Object.fromEntries(COLUMNS.map((c, k) => [c, cells[k]]));
      const v = validateOperationInput(info, raw);
      if (!v.ok) return void problems.push(`Line ${i + 1}: ${v.error}`);
      const ref = String(v.input.externalReference);
      if (seen.has(ref)) return void problems.push(`Line ${i + 1}: invoice ${ref} appears twice.`);
      seen.add(ref);
      invoices.push(v.input);
    });
    if (problems.length > 0) throw new FinanceError('INVALID_ROWS', problems.slice(0, 8).join(' ') + (problems.length > 8 ? ` …and ${problems.length - 8} more.` : ''));
    const m = (await drizzleDb.select().from(paymentMethods).where(and(eq(paymentMethods.id, input.methodId), eq(paymentMethods.companyId, ctx.companyId)))).at(0);
    if (m?.providerId == null) throw new FinanceError('METHOD_INVALID', 'Choose the paybill to send from.');
    const bills = getContainer().paymentEngine.bills;
    // An invoice number that is already out is not sent a second time; one that was refused may be tried again.
    const known = await bills.existing(m.providerId, invoices.map((i) => String(i.externalReference)));
    const taken = invoices.filter((i) => known.has(String(i.externalReference)) && known.get(String(i.externalReference)) !== 'failed');
    if (taken.length > 0) {
      throw new FinanceError('ALREADY_SENT', `${taken.slice(0, 5).map((i) => String(i.externalReference)).join(', ')}${taken.length > 5 ? ` and ${String(taken.length - 5)} more` : ''} ${taken.length === 1 ? 'has' : 'have'} already been sent. Use a new invoice number, or cancel the old one first.`);
    }
    await bills.record({
      companyId: ctx.companyId,
      providerId: m.providerId,
      methodId: m.id,
      requestedBy: ctx.actor.id ?? 'system',
      invoices: invoices.map((i) => ({ reference: String(i.externalReference), accountReference: String(i.accountReference), billedName: String(i.billedFullName), phone: String(i.billedPhoneNumber), invoiceName: String(i.invoiceName), period: String(i.billedPeriod), amount: Number(i.amount).toFixed(2), dueDate: String(i.dueDate).slice(0, 10) })),
    });
    const references = invoices.map((i) => String(i.externalReference));
    try {
      const single = invoices.length === 1;
      const { op } = await getContainer().paymentEngine.daraja.start({ providerId: m.providerId, methodId: m.id, operation: single ? 'bill_invoice' : 'bill_invoice_bulk', input: single ? invoices[0] : { invoices } });
      await bills.sent(m.providerId, references, op);
      return { id: op.id, status: op.status, count: invoices.length, failureReason: op.failureReason };
    } catch (error) {
      await bills.sent(m.providerId, references, { id: null, status: 'failed', failureReason: error instanceof Error ? error.message : 'The invoices could not be sent.' }).catch(() => undefined);
      if (error instanceof OperationRefused) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }, [PAGE]);
}

export async function cancelInvoicesAction(input: { methodId: string; text: string }) {
  return await run('payment_operations:run', { surface: 'payments/bills', action: 'cancel_invoices' }, async (ctx) => {
    const references = [...new Set(input.text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
    if (references.length === 0) throw new FinanceError('NOTHING_TO_CANCEL', 'Enter at least one invoice number.');
    if (references.length > MAX_BATCH) throw new FinanceError('TOO_MANY', `Cancel at most ${MAX_BATCH} invoices at a time.`);
    if (references.some((r) => r.length > 40)) throw new FinanceError('INVALID_ROWS', 'An invoice number is longer than 40 characters.');
    const m = (await drizzleDb.select().from(paymentMethods).where(and(eq(paymentMethods.id, input.methodId), eq(paymentMethods.companyId, ctx.companyId)))).at(0);
    if (m?.providerId == null) throw new FinanceError('METHOD_INVALID', 'Choose the paybill the invoices were sent from.');
    const bills = getContainer().paymentEngine.bills;
    const { ok, refused } = await bills.cancellable(m.providerId, references);
    if (refused.length > 0) throw new FinanceError('CANNOT_CANCEL', `${refused.slice(0, 5).map((r) => `${r.reference} ${r.why}`).join('; ')}${refused.length > 5 ? ` and ${String(refused.length - 5)} more` : ''}.`);
    try {
      const single = ok.length === 1;
      const { op } = await getContainer().paymentEngine.daraja.start({ providerId: m.providerId, methodId: m.id, operation: single ? 'bill_cancel' : 'bill_cancel_bulk', input: single ? { externalReference: ok[0] } : { references: ok } });
      await bills.cancelled(m.providerId, ok, op);
      return { id: op.id, status: op.status, count: ok.length, failureReason: op.failureReason };
    } catch (error) {
      if (error instanceof OperationRefused) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }, [PAGE]);
}

/** One page of the invoices sent through Bill Manager, newest first, and what became of each. */
export async function listBillInvoicesAction(filter: { status?: BillInvoiceStatus; q?: string; before?: string } = {}) {
  return await run('payment_activity:read', { surface: 'payments/bills', action: 'invoices' }, async (ctx) => {
    const page = await getContainer().paymentEngine.bills.list(ctx.companyId, filter);
    return {
      nextBefore: page.nextBefore,
      rows: page.rows.map((i) => ({
        id: i.id,
        reference: i.reference,
        accountReference: i.accountReference,
        billedName: i.billedName,
        phone: i.phoneMasked,
        invoiceName: i.invoiceName,
        amount: i.amount,
        paidAmount: i.paidAmount,
        dueDate: i.dueDate,
        status: i.status,
        failureReason: i.failureReason,
        acknowledged: i.acknowledgedAt !== null,
        ackError: i.ackError,
        paidAt: i.paidAt ? i.paidAt.toISOString() : null,
        createdAt: i.createdAt.toISOString(),
      })),
    };
  });
}
