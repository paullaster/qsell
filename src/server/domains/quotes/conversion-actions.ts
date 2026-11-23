'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import { orders } from '@/server/db/drizzle/schema';
import { MAX_TENDERS } from '@/server/domains/selling/cash-sales/tender-rules';
import { conversionChoices, isQuoteTarget, QUOTE_TARGETS, TARGET_PERMISSION, TARGET_WORDS, type ConversionChoice, type ConversionFacts, type KindSettings, type QuoteTarget } from '@/lib/quote-conversion';
import { has } from '@/lib/values';
import { runQuoteAction } from './run';
import { SalesQuoteService, type QuoteCashPayment, type QuoteConversion } from './service';

const KIND_OF = { sales_order: 'sales_order', sales_invoice: 'sales_invoice', credit_sale: 'credit_sale', cash_sale: 'pos_cash_sale' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORDS_OF_MODULE: Record<string, string> = { sales_invoice: 'Sales invoice', credit_sale: 'Credit sale', pos_cash_sale: 'Cash sale' };

export interface QuoteConversionView {
  quoteNumber: string;
  customerName: string;
  currency: string;
  total: number;
  choices: ConversionChoice[];
  /** The ways of paying at the person's till, for a cash sale (empty with no open shift). */
  cashMethods: { id: string; name: string; kind: 'cash' | 'mobile_money' | 'card'; requiresReference: boolean }[];
}

/** Gathers what the choices depend on: the quote, its customer, the company's settings for each kind, the person's rights and shift. */
async function factsFor(id: string, userId: string): Promise<{ facts: ConversionFacts; customerName: string } | null> {
  const c = getContainer();
  const quote = await new SalesQuoteService().get(id);
  if (!quote) return null;
  const company = await c.companySettings.ensureSeeded();

  let convertedTo: ConversionFacts['convertedTo'] = null;
  if (quote.convertedOrderId !== null) {
    const [made] = await drizzleDb.select({ number: orders.orderNumber, module: orders.salesModule }).from(orders).where(eq(orders.id, quote.convertedOrderId)).limit(1);
    if (made !== undefined) convertedTo = { label: WORDS_OF_MODULE[made.module] ?? 'Sales order', number: made.number };
  }

  const settings = {} as Record<QuoteTarget, KindSettings>;
  for (const target of QUOTE_TARGETS) {
    const s = await c.sellingSettings.get(company.id, KIND_OF[target]);
    settings[target] = { stockRelease: s.stockRelease, approval: s.approval, invoice: target === 'sales_invoice' ? 'with_document' : s.invoice, creditCheck: s.creditCheck, overLimit: s.overLimit, creditDays: s.creditDays, fixedDays: s.fixedDays };
  }

  const position = quote.customerId === null ? null : await c.salesOrders.creditPosition(company.id, quote.customerId, 'credit_sale');
  const can = {} as Record<QuoteTarget, boolean>;
  for (const target of QUOTE_TARGETS) can[target] = await canPermission(TARGET_PERMISSION[target] as PermissionKey);
  const shift = await c.shifts.openForSale(company.id, userId);
  const address = quote.deliveryAddress;

  return {
    customerName: quote.customerName,
    facts: {
      quoteNumber: quote.quoteNumber,
      status: quote.status,
      expired: quote.expired,
      convertedTo,
      addressComplete: has(address.street) && has(address.city) && has(address.countyOrState) && has(address.country),
      total: Number(quote.totalAmount),
      currency: quote.currency,
      deliveryFee: Number(quote.shippingFee),
      customer:
        position === null
          ? null
          : { name: position.name, hasCreditAccount: position.hasCreditAccount, blocked: position.blocked, creditLimit: position.creditLimit, available: position.creditLimitDisplay === 'running' ? position.available : null, termDays: position.termDays, overdue: position.overdue },
      settings,
      can,
      canApprove: await canPermission('quotes:approve'),
      shiftOpen: shift.ok,
    },
  };
}

/** What the quote can become, with what each will do and why one cannot be chosen. Read-only; the conversion decides again. */
export async function quoteConversionChoicesAction(id: string) {
  return await runQuoteAction(async (): Promise<QuoteConversionView> => {
    const userId = await requirePermission('quotes:read');
    const found = await factsFor(id, userId);
    if (found === null) throw new Error('Quote not found.');
    const c = getContainer();
    const companyId = (await c.companySettings.ensureSeeded()).id;
    const shift = await c.shifts.openForSale(companyId, userId);
    const cashMethods = shift.ok && found.facts.can.cash_sale ? await c.cashSales.tenderMethods(companyId, shift.branchId) : [];
    return { quoteNumber: found.facts.quoteNumber, customerName: found.customerName, currency: found.facts.currency, total: found.facts.total, choices: conversionChoices(found.facts), cashMethods };
  });
}

/** The tenders as entered, checked: the kinds and amounts are only counted here; the till's own rules decide what they add up to. */
function readPayment(raw: unknown): QuoteCashPayment {
  const rows = typeof raw === 'object' && raw !== null && 'tenders' in raw && Array.isArray((raw).tenders) ? (raw as { tenders: unknown[] }).tenders : [];
  if (rows.length === 0) throw new Error('Choose how the customer pays.');
  if (rows.length > MAX_TENDERS) throw new Error(`A sale can be paid in up to ${String(MAX_TENDERS)} ways.`);
  return {
    tenders: rows.map((row) => {
      const r = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
      const amount = typeof r.amount === 'number' ? r.amount : Number.NaN;
      if (typeof r.methodId !== 'string' || !UUID.test(r.methodId)) throw new Error('Choose how the customer pays.');
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) throw new Error('Enter how much the customer pays in each way.');
      return { methodId: r.methodId, amount: Math.round(amount * 100) / 100, reference: typeof r.reference === 'string' ? r.reference.trim().slice(0, 60) : '' };
    }),
  };
}

/** Converts the quote into what the person chose. The choice is checked again here, with the same rules the screen showed. */
export async function convertQuoteAction(id: string, target: string, payment?: unknown) {
  return await runQuoteAction(async (): Promise<QuoteConversion> => {
    const userId = await requirePermission('quotes:approve');
    if (!isQuoteTarget(target)) throw new Error('Choose what the quote becomes.');
    await requirePermission(TARGET_PERMISSION[target] as PermissionKey);
    const found = await factsFor(id, userId);
    if (found === null) throw new Error('Quote not found.');
    const choice = conversionChoices(found.facts).find((c) => c.target === target);
    if (choice?.available !== true) throw new Error(choice?.reason ?? `This quote cannot become ${TARGET_WORDS[target].label.toLowerCase()}.`);
    const result = await new SalesQuoteService().convert(userId, id, target, target === 'cash_sale' ? readPayment(payment) : undefined);
    for (const path of ['/admin/quotes', '/admin/orders', '/admin/sales-orders', '/admin/sales-invoices', '/admin/credit-sales', '/admin/cash-sales', '/admin/inventory']) revalidatePath(path);
    return result;
  });
}
