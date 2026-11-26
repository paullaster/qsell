'use server';

import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { brandBlock, resolveRecordPrint, type BrandBlock } from '@/lib/print-branding';
import { toCompanyProfile } from '@/server/domains/company/repository';
import type { ShiftReport } from '../shifts/shift-service';
import { parseCashSale, parseCashSaleLines, parseCounterReturn } from './cash-sale-input';
import type { ReturnSummary } from './counter-return-service';
import type { SaleSummary } from './cash-sale-service';
import type { ReceiptDiscount, TillMode } from './till-rules';

export interface SaleRow {
  orderId: string;
  orderNumber: string;
  receiptNumber: string | null;
  total: number;
  customerName: string;
  at: string;
  paid: boolean;
}

export interface CashSalesScreen {
  /** The person's open shift (with its X report figures), or null: no sale can be rung up without one. */
  shift: ShiftReport | null;
  sales: { rows: SaleRow[]; next: string | null };
  can: { create: boolean; readAll: boolean; return: boolean };
  /** Returns started and not finished (a refund waiting for approval, or approved and still to be handed over). */
  returns: { returnId: string; orderNumber: string; amount: number; status: string }[];
  /** Whether tills may keep selling with no connection (the company's setting). */
  offlineEnabled: boolean;
  /** How the counter looks: inside the admin page, or as a full-screen till. */
  tillMode: TillMode;
  /** What the receipt says about discounts (the company's setting). */
  receiptDiscount: ReceiptDiscount;
  /** May change an item's price while selling. */
  canPrice: boolean;
  /** May offer a discount of their own while selling: they have the permission and the company allows it at their branch. Only then is the discount input shown. */
  canDiscount: boolean;
  /** The top of the printed receipt: the shop's name and whatever else the company chose to show under it. */
  receiptBrand: BrandBlock;
}

async function receiptBrand(c: ReturnType<typeof getContainer>): Promise<BrandBlock> {
  const company = await c.companySettings.ensureSeeded();
  return brandBlock(toCompanyProfile(company), resolveRecordPrint(company.uiConfig.recordPrint).cash_sale);
}

const cursorOf = (raw: unknown): { k: string; id: string } | null => {
  if (typeof raw !== 'string' || raw === '') return null;
  const at = raw.lastIndexOf('|');
  return at > 0 && at < raw.length - 1 ? { k: raw.slice(0, at), id: raw.slice(at + 1) } : null;
};
const encode = (next: { k: string; id: string } | null): string | null => (next === null ? null : `${next.k}|${next.id}`);

/** Prices typed at the till count only from someone who may change them; for anyone else they are dropped, so the price lists decide. */
async function mayPrice<T extends { unitPrice?: number }>(lines: T[]): Promise<T[]> {
  if (!lines.some((l) => l.unitPrice !== undefined) || (await canPermission('cash_sales:price'))) return lines;
  return lines.map(({ unitPrice: _dropped, ...rest }) => rest as T);
}

/** Whether this person may offer a discount now: the permission, and the company's setting for their branch (a person with no branch sells at the default branch). */
async function mayDiscount(companyId: string, userId: string): Promise<boolean> {
  if (!(await canPermission('cash_sales:discount'))) return false;
  const c = getContainer();
  const branchId = (await c.salesOrders.branchOf(userId)) ?? (await c.branches.getDefault(companyId))?.id ?? null;
  return await c.sellingSettings.manualDiscountOffered(companyId, 'pos_cash_sale', branchId);
}

/** A discount typed at the till is refused, in words, unless this person may offer one here: it is never dropped quietly, so nobody is charged a price they did not expect. */
async function checkDiscounts(companyId: string, userId: string, lines: { discount?: unknown }[]): Promise<string | null> {
  if (!lines.some((l) => l.discount !== undefined)) return null;
  return (await mayDiscount(companyId, userId)) ? null : 'You cannot offer a discount here. Remove the discount and try again.';
}

async function access(): Promise<{ userId: string; create: boolean; readAll: boolean } | null> {
  const [create, readAll] = await Promise.all([canPermission('cash_sales:create'), canPermission('cash_sales:read')]);
  if (!create && !readAll) return null;
  const userId = await requirePermission(create ? 'cash_sales:create' : 'cash_sales:read');
  return { userId, create, readAll };
}

/** The company's till settings the counter screen needs. */
async function till(c: ReturnType<typeof getContainer>, companyId: string): Promise<{ tillMode: TillMode; receiptDiscount: ReceiptDiscount }> {
  const { tillMode, receiptDiscount } = await c.tillSettings.get(companyId);
  return { tillMode, receiptDiscount };
}

/** Staff: the till: the open shift with its takings so far, and the sales rung up in it (all of the company's for someone who may read them, otherwise their own shift's). */
export async function cashSalesScreenAction(): Promise<{ ok: true; data: CashSalesScreen } | { ok: false; error: string }> {
  const who = await access();
  if (who === null) return { ok: false, error: 'You do not have permission to use the counter.' };
  try {
    const c = getContainer();
    const companyId = (await c.companySettings.ensureSeeded()).id;
    const mine = await c.shifts.openShiftOf(who.userId);
    const shift = mine === null ? null : await c.shifts.report(companyId, mine);
    const listed = await c.cashSales.list(companyId, who.readAll ? {} : { userId: who.userId });
    const canReturn = await canPermission('cash_sales:return');
    return { ok: true, data: { shift, sales: { rows: listed.rows, next: encode(listed.next) }, can: { create: who.create, readAll: who.readAll, return: canReturn }, returns: canReturn ? await c.counterReturns.unfinished(companyId, who.readAll ? {} : { userId: who.userId }) : [], offlineEnabled: (await c.offlineSales.settings(companyId)).enabled, ...await till(c, companyId), canPrice: await canPermission('cash_sales:price'), canDiscount: await mayDiscount(companyId, who.userId), receiptBrand: await receiptBrand(c) } };
  } catch (error) {
    console.error('[cash sales] screen', error);
    return { ok: false, error: 'The counter could not be loaded. Please try again.' };
  }
}

/** Staff: more of the sales list. */
export async function cashSalesMoreAction(raw: unknown): Promise<{ ok: true; data: { rows: SaleRow[]; next: string | null } } | { ok: false; error: string }> {
  const who = await access();
  if (who === null) return { ok: false, error: 'You do not have permission to use the counter.' };
  try {
    const c = getContainer();
    const listed = await c.cashSales.list((await c.companySettings.ensureSeeded()).id, { ...(who.readAll ? {} : { userId: who.userId }), cursor: cursorOf(typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).cursor : null) });
    return { ok: true, data: { rows: listed.rows, next: encode(listed.next) } };
  } catch (error) {
    console.error('[cash sales] more', error);
    return { ok: false, error: 'The sales could not be loaded. Please try again.' };
  }
}

/** Staff: what the lines would total, priced as the sale will be (nothing is held or saved). */
export async function priceCashSaleAction(raw: unknown): Promise<{ ok: true; data: { subtotal: number; tax: number; total: number; lines: { productId: string; quantity: number; unitPrice: number; lineTotal: number }[] } } | { ok: false; error: string }> {
  const userId = await requirePermission('cash_sales:create');
  const read = parseCashSaleLines(raw);
  if (!read.ok) return { ok: false, error: read.error };
  try {
    const c = getContainer();
    const refused = await checkDiscounts((await c.companySettings.ensureSeeded()).id, userId, read.lines);
    if (refused !== null) return { ok: false, error: refused };
    const priced = await c.cashSales.price((await c.companySettings.ensureSeeded()).id, { userId, branchId: await c.salesOrders.branchOf(userId) }, { customerId: read.customerId, lines: await mayPrice(read.lines) });
    return priced.ok ? { ok: true, data: { subtotal: priced.subtotal, tax: priced.tax, total: priced.total, lines: priced.lines } } : { ok: false, error: priced.error };
  } catch (error) {
    console.error('[cash sales] price', error);
    return { ok: false, error: 'The total could not be worked out just now. Please try again.' };
  }
}

/** Staff: completes a counter sale in the person's own open shift: places it, records how it was paid, and gives the receipt. The same key finishes a sale that was left half done and never counts one twice. */
export async function completeCashSaleAction(raw: unknown): Promise<{ ok: true; data: SaleSummary } | { ok: false; error: string; unfinished?: { orderId: string; orderNumber: string } }> {
  const userId = await requirePermission('cash_sales:create');
  const read = parseCashSale(raw);
  if (!read.ok) return { ok: false, error: read.error };
  try {
    const c = getContainer();
    const companyId = (await c.companySettings.ensureSeeded()).id;
    const refused = await checkDiscounts(companyId, userId, read.sale.lines);
    if (refused !== null) return { ok: false, error: refused };
    const done = await c.cashSales.complete(companyId, { userId, branchId: await c.salesOrders.branchOf(userId) }, { ...read.sale, lines: await mayPrice(read.sale.lines) });
    return done.ok ? { ok: true, data: done.sale } : { ok: false, error: done.error, ...(done.unfinished === undefined ? {} : { unfinished: done.unfinished }) };
  } catch (error) {
    console.error('[cash sales] complete', error);
    return { ok: false, error: 'The sale could not be completed just now. If you pressed Complete before, check the sales list before trying again.' };
  }
}

/** Staff: a sale's receipt again (a reprint). A person who may not read everyone's sees only their own shifts' sales. */
export async function cashSaleReceiptAction(orderId: unknown): Promise<{ ok: true; data: SaleSummary | null } | { ok: false; error: string }> {
  const who = await access();
  if (who === null) return { ok: false, error: 'You do not have permission to use the counter.' };
  if (typeof orderId !== 'string' || orderId === '' || orderId.length > 100) return { ok: true, data: null };
  try {
    const c = getContainer();
    const companyId = (await c.companySettings.ensureSeeded()).id;
    const visible = await c.cashSales.list(companyId, { ...(who.readAll ? {} : { userId: who.userId }), orderId });
    if (visible.rows.length === 0) return { ok: true, data: null };
    return { ok: true, data: await c.cashSales.summary(orderId) };
  } catch (error) {
    console.error('[cash sales] receipt', error);
    return { ok: false, error: 'The receipt could not be loaded. Please try again.' };
  }
}

/** Staff: the builder for a package product at the counter: every option can be chosen, the package need not be on the web shop. */
export async function cashSalePackageBuilderAction(productId: unknown) {
  await requirePermission('cash_sales:create');
  if (typeof productId !== 'string' || productId.length === 0 || productId.length > 100) return { ok: true as const, data: null };
  try {
    const c = getContainer();
    return { ok: true as const, data: await c.packageShop.staffBuilder((await c.companySettings.ensureSeeded()).id, productId) };
  } catch (error) {
    console.error('[cash sales] package builder', error);
    return { ok: false as const, error: 'Could not open the package. Please try again.' };
  }
}

/** Staff: what of a counter sale can still be returned (the lines not yet credited), and the returns already made on it. */
export async function returnableSaleAction(orderId: unknown): Promise<{ ok: true; data: { orderNumber: string; customerName: string; lines: { productId: string; description: string; unitPrice: number; soldQuantity: number; remainingQuantity: number }[]; made: ReturnSummary[] } | null; message?: string } | { ok: false; error: string }> {
  await requirePermission('cash_sales:return');
  if (typeof orderId !== 'string' || orderId === '' || orderId.length > 100) return { ok: true, data: null, message: 'That sale could not be found.' };
  try {
    const c = getContainer();
    const companyId = (await c.companySettings.ensureSeeded()).id;
    const made = await c.counterReturns.ofSale(companyId, orderId);
    const open = await c.counterReturns.returnable(companyId, orderId);
    if (!open.ok) return { ok: true, data: null, message: open.error };
    return { ok: true, data: { orderNumber: open.orderNumber, customerName: open.customerName, lines: open.lines, made } };
  } catch (error) {
    console.error('[cash sales] returnable', error);
    return { ok: false, error: 'The sale could not be loaded. Please try again.' };
  }
}

/** Staff: returns goods from a counter sale: a credit note, the goods back into stock when fit to sell, and the money back (cash from the open shift). The same key finishes a return left half done and never does a step twice. */
export async function returnSaleAction(raw: unknown): Promise<{ ok: true; data: ReturnSummary } | { ok: false; error: string; unfinished?: { returnId: string } }> {
  const userId = await requirePermission('cash_sales:return');
  const read = parseCounterReturn(raw);
  if (!read.ok) return { ok: false, error: read.error };
  try {
    const c = getContainer();
    const done = await c.counterReturns.run((await c.companySettings.ensureSeeded()).id, { userId }, read.input);
    return done.ok ? { ok: true, data: done.ret } : { ok: false, error: done.error, ...(done.unfinished === undefined ? {} : { unfinished: done.unfinished }) };
  } catch (error) {
    console.error('[cash sales] return', error);
    return { ok: false, error: 'The return could not be made just now. If you pressed the button before, check the sale before trying again.' };
  }
}

/** Staff: finishes a return that stopped part way (goods not yet counted in, the refund still to be asked for, or the cash still to be handed over). */
export async function finishReturnAction(returnId: unknown): Promise<{ ok: true; data: ReturnSummary } | { ok: false; error: string; unfinished?: { returnId: string } }> {
  const userId = await requirePermission('cash_sales:return');
  if (typeof returnId !== 'string' || !/^[0-9a-f-]{36}$/i.test(returnId)) return { ok: false, error: 'That return could not be found.' };
  try {
    const c = getContainer();
    const done = await c.counterReturns.finish((await c.companySettings.ensureSeeded()).id, userId, returnId);
    return done.ok ? { ok: true, data: done.ret } : { ok: false, error: done.error, ...(done.unfinished === undefined ? {} : { unfinished: done.unfinished }) };
  } catch (error) {
    console.error('[cash sales] finish return', error);
    return { ok: false, error: 'The return could not be finished just now. Please try again.' };
  }
}
