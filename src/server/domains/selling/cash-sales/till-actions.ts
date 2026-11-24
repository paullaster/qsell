'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { HeldSaleError, type HeldSaleRow, type RecalledSale } from './held-sale-service';
import { TillSettingsError } from './till-settings-service';
import type { CounterCategory, CounterTile } from './counter-catalogue-service';
import type { ReceiptDiscount, TillMode } from './till-rules';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown, max: number): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export interface TillStart {
  categories: CounterCategory[];
  recent: CounterTile[];
  tiles: CounterTile[];
  next: { name: string; id: string } | null;
  held: HeldSaleRow[];
  /** The ways of paying at this person's till (cash, M-Pesa, card), as buttons. */
  methods: { id: string; name: string; kind: 'cash' | 'mobile_money' | 'card'; requiresReference: boolean }[];
}

const SINCE_DAYS = 30;

/** Staff: what the counter opens with: the categories, what this person sells most, the first tiles and the sales on hold. */
export async function tillStartAction(): Promise<Result<TillStart>> {
  const userId = await requirePermission('cash_sales:create');
  try {
    const c = getContainer();
    const companyId = (await c.companySettings.ensureSeeded()).id;
    // The ways of paying are those of the branch the person's open shift is on.
    const shift = await c.shifts.openForSale(companyId, userId);
    const [categories, recent, first, held, methods] = await Promise.all([
      c.counterCatalogue.categories(),
      c.counterCatalogue.recent(userId, new Date(Date.now() - SINCE_DAYS * 86_400_000)),
      c.counterCatalogue.page({ categoryId: null, query: '', after: null }),
      c.heldSales.list(companyId, userId),
      shift.ok ? c.cashSales.tenderMethods(companyId, shift.branchId) : Promise.resolve([]),
    ]);
    return { ok: true, data: { categories, recent, tiles: first.tiles, next: first.next, held, methods } };
  } catch (error) {
    console.error('[till] start', error);
    return { ok: false, error: 'The products could not be loaded. Please try again.' };
  }
}

/** Staff: a page of tiles for a category and a search. */
export async function tillTilesAction(raw: unknown): Promise<Result<{ tiles: CounterTile[]; next: { name: string; id: string } | null }>> {
  await requirePermission('cash_sales:create');
  const r = obj(raw);
  const after = obj(r.after);
  const cursor = typeof after.name === 'string' && typeof after.id === 'string' ? { name: after.name.slice(0, 200), id: after.id.slice(0, 80) } : null;
  try {
    const page = await getContainer().counterCatalogue.page({ categoryId: text(r.categoryId, 80) === '' ? null : text(r.categoryId, 80), query: text(r.query, 80), after: cursor });
    return { ok: true, data: page };
  } catch (error) {
    console.error('[till] tiles', error);
    return { ok: false, error: 'The products could not be loaded. Please try again.' };
  }
}

/** Staff: a code typed or scanned and confirmed with Enter: the product with exactly that SKU, if the counter may sell it. */
export async function tillCodeAction(code: unknown): Promise<Result<CounterTile | null>> {
  await requirePermission('cash_sales:create');
  try {
    return { ok: true, data: await getContainer().counterCatalogue.byCode(text(code, 80)) };
  } catch (error) {
    console.error('[till] code', error);
    return { ok: false, error: 'That code could not be looked up. Please try again.' };
  }
}

const held = async <T>(fn: (companyId: string, userId: string) => Promise<T>, label: string): Promise<Result<T>> => {
  const userId = await requirePermission('cash_sales:create');
  try {
    return { ok: true, data: await fn((await getContainer().companySettings.ensureSeeded()).id, userId) };
  } catch (error) {
    if (error instanceof HeldSaleError) return { ok: false, error: error.message };
    console.error(`[till] ${label}`, error);
    return { ok: false, error: 'That could not be done just now. Please try again.' };
  }
};

/** Staff: sets the sale aside (its lines and customer; nothing is priced, held or paid). */
export async function holdSaleAction(raw: unknown): Promise<Result<HeldSaleRow>> {
  const r = obj(raw);
  return await held((companyId, userId) => getContainer().heldSales.hold(companyId, userId, { label: r.label, sale: r.sale }), 'hold');
}

/** Staff: brings a held sale back, once. */
export async function recallHeldSaleAction(id: unknown): Promise<Result<RecalledSale>> {
  return await held((companyId, userId) => getContainer().heldSales.recall(companyId, userId, text(id, 60)), 'recall');
}

/** Staff: gives a held sale up. */
export async function discardHeldSaleAction(id: unknown): Promise<Result<true>> {
  return await held(async (companyId, userId) => {
    await getContainer().heldSales.discard(companyId, userId, text(id, 60));
    return true as const;
  }, 'discard');
}

export interface TillSettingsView {
  tillMode: TillMode;
  receiptDiscount: ReceiptDiscount;
  updatedAt: string | null;
}

const friendly = (error: unknown): string | null => (error instanceof TillSettingsError ? error.message : null);

export async function tillSettingsScreenAction() {
  return await runSetting('selling_settings:manage', async ({ companyId }): Promise<TillSettingsView> => {
    const s = await getContainer().tillSettings.get(companyId);
    return { tillMode: s.tillMode, receiptDiscount: s.receiptDiscount, updatedAt: s.updatedAt };
  }, { friendly });
}

export async function saveTillSettingsAction(raw: unknown) {
  return await runSetting('selling_settings:manage', async ({ companyId, userId }): Promise<TillSettingsView> => {
    const saved = await getContainer().tillSettings.save(companyId, userId, raw);
    return { tillMode: saved.tillMode, receiptDiscount: saved.receiptDiscount, updatedAt: new Date().toISOString() };
  }, { paths: ['/admin/settings/sales/cash-sales', '/admin/cash-sales'], friendly });
}
