'use server';

import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { paymentMethods, paymentProviderConfigs, providerOperations } from '@/server/db/drizzle/schema';
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
      columns: [...COLUMNS],
      can: { run: await canPermission('payment_operations:run') },
    };
  });
}

const split = (line: string) => line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((x) => x.trim().replace(/^"|"$/g, ''));

/** One invoice per line: invoice number, customer, phone, period, what for, due date, account number, amount. */
export async function sendInvoicesAction(input: { methodId: string; text: string }) {
  return await run('payment_operations:run', { surface: 'payments/bills', action: 'send_invoices' }, async () => {
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
    const m = (await drizzleDb.select().from(paymentMethods).where(eq(paymentMethods.id, input.methodId))).at(0);
    if (m?.providerId == null) throw new FinanceError('METHOD_INVALID', 'Choose the paybill to send from.');
    try {
      const single = invoices.length === 1;
      const { op } = await getContainer().paymentEngine.daraja.start({ providerId: m.providerId, methodId: m.id, operation: single ? 'bill_invoice' : 'bill_invoice_bulk', input: single ? invoices[0] : { invoices } });
      return { id: op.id, status: op.status, count: invoices.length, failureReason: op.failureReason };
    } catch (error) {
      if (error instanceof OperationRefused) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }, [PAGE]);
}

export async function cancelInvoicesAction(input: { methodId: string; text: string }) {
  return await run('payment_operations:run', { surface: 'payments/bills', action: 'cancel_invoices' }, async () => {
    const references = [...new Set(input.text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
    if (references.length === 0) throw new FinanceError('NOTHING_TO_CANCEL', 'Enter at least one invoice number.');
    if (references.length > MAX_BATCH) throw new FinanceError('TOO_MANY', `Cancel at most ${MAX_BATCH} invoices at a time.`);
    if (references.some((r) => r.length > 40)) throw new FinanceError('INVALID_ROWS', 'An invoice number is longer than 40 characters.');
    const m = (await drizzleDb.select().from(paymentMethods).where(eq(paymentMethods.id, input.methodId))).at(0);
    if (m?.providerId == null) throw new FinanceError('METHOD_INVALID', 'Choose the paybill the invoices were sent from.');
    try {
      const single = references.length === 1;
      const { op } = await getContainer().paymentEngine.daraja.start({ providerId: m.providerId, methodId: m.id, operation: single ? 'bill_cancel' : 'bill_cancel_bulk', input: single ? { externalReference: references[0] } : { references } });
      return { id: op.id, status: op.status, count: references.length, failureReason: op.failureReason };
    } catch (error) {
      if (error instanceof OperationRefused) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }, [PAGE]);
}
