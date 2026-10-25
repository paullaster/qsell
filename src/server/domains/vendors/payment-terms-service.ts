import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  companySettings,
  glAccounts,
  vendorPostingGroups,
  vendorSettings,
  vendors,
  withholdingCertificates,
  withholdingCodes,
  type WithholdingCertificateRow,
} from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { VendorService } from './service';

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/;
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;

export interface AccountsForm {
  payables: string;
  prepayments: string;
  paymentDiscount: string;
  paymentTolerance: string;
  withholdingPayable: string;
}

/**
 * The rules of paying vendors that are data (design doc §12.1, §12.5): the codes tax is withheld by, what each vendor is withheld and
 * discounted by, the accounts payments post to, and the leftover that may be closed as tolerance. Plus the certificates that
 * withholding produces.
 */
export class PaymentTermsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly vendorService: VendorService,
  ) {}

  // ── withholding codes ────────────────────────────────────────────────────

  async codes(companyId: string) {
    return await this.db.select().from(withholdingCodes).where(eq(withholdingCodes.companyId, companyId)).orderBy(asc(withholdingCodes.code));
  }

  async saveCode(ctx: FinanceContext, id: string | null, input: { code: string; name: string; ratePercent: string; base: string; active: boolean }): Promise<{ id: string }> {
    const code = input.code.trim();
    const name = input.name.trim();
    if (!CODE.test(code)) throw new FinanceError('INVALID', 'The code is letters, digits, dots, dashes or underscores, up to 20 characters.');
    if (name === '' || name.length > 120) throw new FinanceError('INVALID', 'Give the code a name (120 characters at most).');
    if (!PERCENT.test(input.ratePercent.trim()) || Number(input.ratePercent) <= 0 || Number(input.ratePercent) > 100) throw new FinanceError('INVALID', 'The rate is a percentage above 0 and up to 100.');
    if (input.base !== 'net' && input.base !== 'gross') throw new FinanceError('INVALID', 'Choose what the tax is taken on.');
    const base: 'net' | 'gross' = input.base;
    const values = { code, name, ratePercent: Number(input.ratePercent).toFixed(2), base, active: input.active, updatedAt: new Date() };
    try {
      if (id === null) {
        const [made] = await this.db.insert(withholdingCodes).values({ companyId: ctx.companyId, ...values }).returning({ id: withholdingCodes.id });
        return { id: made?.id ?? '' };
      }
      const [row] = await this.db.update(withholdingCodes).set(values).where(and(eq(withholdingCodes.companyId, ctx.companyId), eq(withholdingCodes.id, id))).returning({ id: withholdingCodes.id });
      if (row === undefined) throw new FinanceError('NOT_FOUND', 'That code does not exist.');
      return { id: row.id };
    } catch (error) {
      if ((error as { code?: string; cause?: { code?: string } }).code === '23505' || (error as { cause?: { code?: string } }).cause?.code === '23505') throw new FinanceError('DUPLICATE', 'There is already a code with that name.');
      throw error;
    }
  }

  // ── what one vendor is paid under ────────────────────────────────────────

  async vendorTerms(companyId: string, vendorId: string) {
    const [v] = await this.db.select({ id: vendors.id, code: vendors.withholdingCodeId, percent: vendors.earlyDiscountPercent, days: vendors.earlyDiscountDays, group: vendors.postingGroupId }).from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.id, vendorId)));
    if (v === undefined) return null;
    const codes = await this.codes(companyId);
    return { withholdingCodeId: v.code ?? '', earlyDiscountPercent: v.percent, earlyDiscountDays: String(v.days), codes: codes.filter((c) => c.active || c.id === v.code).map((c) => ({ id: c.id, label: `${c.code} · ${c.name} (${c.ratePercent}% of ${c.base === 'net' ? 'the net amount' : 'what is paid'})` })) };
  }

  async saveVendorTerms(ctx: FinanceContext, vendorId: string, input: { withholdingCodeId: string; earlyDiscountPercent: string; earlyDiscountDays: string }): Promise<void> {
    const percent = input.earlyDiscountPercent.trim() === '' ? '0' : input.earlyDiscountPercent.trim();
    const days = input.earlyDiscountDays.trim() === '' ? '0' : input.earlyDiscountDays.trim();
    if (!PERCENT.test(percent) || Number(percent) >= 100) throw new FinanceError('INVALID', 'The discount is a percentage below 100.');
    if (!/^\d{1,3}$/.test(days) || Number(days) > 365) throw new FinanceError('INVALID', 'The days to pay for the discount are a whole number up to 365.');
    if (Number(percent) > 0 && Number(days) === 0) throw new FinanceError('INVALID', 'Say within how many days of the invoice date the discount is allowed.');
    let codeId: string | null = null;
    if (has(input.withholdingCodeId)) {
      const [c] = await this.db.select({ id: withholdingCodes.id }).from(withholdingCodes).where(and(eq(withholdingCodes.companyId, ctx.companyId), eq(withholdingCodes.id, input.withholdingCodeId), eq(withholdingCodes.active, true)));
      if (c === undefined) throw new FinanceError('INVALID', 'Choose a withholding code that is switched on.');
      codeId = c.id;
    }
    const done = await this.db.update(vendors).set({ withholdingCodeId: codeId, earlyDiscountPercent: Number(percent).toFixed(2), earlyDiscountDays: Number(days), updatedAt: new Date() }).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, vendorId))).returning({ id: vendors.id });
    if (done.length === 0) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
  }

  // ── the accounts payments post to, and the tolerance ─────────────────────

  async accounts(companyId: string) {
    const groupId = await this.vendorService.defaultPostingGroupId(companyId);
    const [g] = await this.db.select().from(vendorPostingGroups).where(eq(vendorPostingGroups.id, groupId));
    const ids = [g?.payablesAccountId, g?.prepaymentsAccountId, g?.paymentDiscountAccountId, g?.paymentToleranceAccountId, g?.withholdingPayableAccountId].filter((x): x is string => typeof x === 'string');
    const rows = ids.length === 0 ? [] : await this.db.select({ id: glAccounts.id, no: glAccounts.no, name: glAccounts.name }).from(glAccounts).where(inArray(glAccounts.id, ids));
    const label = (id: string | null | undefined): { id: string; label: string } | null => {
      if (typeof id !== 'string') return null;
      const r = rows.find((x) => x.id === id);
      return r === undefined ? null : { id, label: `${r.no} ${r.name}` };
    };
    const [s] = await this.db.select({ t: vendorSettings.paymentToleranceAmount }).from(vendorSettings).where(eq(vendorSettings.companyId, companyId));
    return {
      groupName: g?.name ?? 'Trade vendors',
      payables: label(g?.payablesAccountId),
      prepayments: label(g?.prepaymentsAccountId),
      paymentDiscount: label(g?.paymentDiscountAccountId),
      paymentTolerance: label(g?.paymentToleranceAccountId),
      withholdingPayable: label(g?.withholdingPayableAccountId),
      toleranceAmount: s?.t ?? '0.00',
    };
  }

  async saveAccounts(ctx: FinanceContext, input: AccountsForm & { toleranceAmount: string }): Promise<void> {
    const tolerance = input.toleranceAmount.trim() === '' ? '0' : input.toleranceAmount.trim();
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(tolerance)) throw new FinanceError('INVALID', 'The tolerance is an amount, like 5, or 0 to turn it off.');
    const wanted = [input.payables, input.prepayments, input.paymentDiscount, input.paymentTolerance, input.withholdingPayable].filter(has);
    const ok = wanted.length === 0 ? [] : await this.db.select({ id: glAccounts.id }).from(glAccounts).where(and(eq(glAccounts.companyId, ctx.companyId), inArray(glAccounts.id, wanted), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false)));
    if (ok.length !== new Set(wanted).size) throw new FinanceError('INVALID', 'Choose accounts that can be posted to (not blocked, not a heading).');
    const groupId = await this.vendorService.defaultPostingGroupId(ctx.companyId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(vendorPostingGroups)
        .set({ payablesAccountId: trimToNull(input.payables), prepaymentsAccountId: trimToNull(input.prepayments), paymentDiscountAccountId: trimToNull(input.paymentDiscount), paymentToleranceAccountId: trimToNull(input.paymentTolerance), withholdingPayableAccountId: trimToNull(input.withholdingPayable), updatedAt: new Date() })
        .where(eq(vendorPostingGroups.id, groupId));
      await tx.insert(vendorSettings).values({ companyId: ctx.companyId, paymentToleranceAmount: Number(tolerance).toFixed(2) }).onConflictDoUpdate({ target: vendorSettings.companyId, set: { paymentToleranceAmount: Number(tolerance).toFixed(2), updatedAt: new Date() } });
    });
  }

  // ── certificates ─────────────────────────────────────────────────────────

  async certificates(companyId: string, f: { period?: string; vendorId?: string; before?: { stamp: string; id: string } | null }, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const found = await this.db
      .select({ c: withholdingCertificates, vendorName: vendors.legalName, stamp: sql<string>`${withholdingCertificates.issuedAt}::text` })
      .from(withholdingCertificates)
      .innerJoin(vendors, eq(vendors.id, withholdingCertificates.vendorId))
      .where(and(
        eq(withholdingCertificates.companyId, companyId),
        has(f.period) ? eq(withholdingCertificates.period, f.period) : undefined,
        has(f.vendorId) ? eq(withholdingCertificates.vendorId, f.vendorId) : undefined,
        f.before === undefined || f.before === null ? undefined : sql`(${withholdingCertificates.issuedAt}::text, ${withholdingCertificates.id}::text) < (${f.before.stamp}, ${f.before.id})`,
      ))
      .orderBy(desc(withholdingCertificates.issuedAt), desc(withholdingCertificates.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const last = page.at(-1);
    const [total] = await this.db
      .select({ amount: sql<string>`COALESCE(SUM(${withholdingCertificates.amount}), 0)::text` })
      .from(withholdingCertificates)
      .where(and(eq(withholdingCertificates.companyId, companyId), eq(withholdingCertificates.status, 'issued'), has(f.period) ? eq(withholdingCertificates.period, f.period) : undefined, has(f.vendorId) ? eq(withholdingCertificates.vendorId, f.vendorId) : undefined));
    return {
      rows: page.map((x) => ({ id: x.c.id, number: x.c.number, vendorName: x.vendorName, status: x.c.status, period: x.c.period, paidOn: x.c.paidOn, amount: x.c.amount, currency: x.c.currency })),
      issuedTotal: total?.amount ?? '0',
      next: found.length > take && last !== undefined ? { stamp: last.stamp, id: last.c.id } : null,
    };
  }

  /** One certificate as it is printed: the company, the vendor, what was paid and what was withheld. `vendorId` limits it to one vendor's own. */
  async certificate(companyId: string, id: string, vendorId: string | null = null) {
    const [row] = await this.db
      .select({ c: withholdingCertificates, vendorName: vendors.legalName, taxId: vendors.taxId, vendorNumber: vendors.number })
      .from(withholdingCertificates)
      .innerJoin(vendors, eq(vendors.id, withholdingCertificates.vendorId))
      .where(and(eq(withholdingCertificates.companyId, companyId), eq(withholdingCertificates.id, id), vendorId === null ? undefined : eq(withholdingCertificates.vendorId, vendorId)));
    if (row === undefined) return null;
    const [company] = await this.db.select({ name: companySettings.legalName, pin: companySettings.kraPin }).from(companySettings).where(eq(companySettings.id, companyId));
    const c: WithholdingCertificateRow = row.c;
    return { id: c.id, number: c.number, status: c.status, cancelReason: c.cancelReason, period: c.period, paidOn: c.paidOn, codeName: c.codeName, ratePercent: c.ratePercent, baseAmount: c.baseAmount, amount: c.amount, currency: c.currency, issuedAt: c.issuedAt.toISOString(), withholdingAgent: { name: company?.name ?? '', pin: company?.pin ?? '' }, vendor: { name: row.vendorName, number: row.vendorNumber, taxId: row.taxId } };
  }

  async vendorCertificates(vendorId: string, before: { stamp: string; id: string } | null = null, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const found = await this.db
      .select({ c: withholdingCertificates, stamp: sql<string>`${withholdingCertificates.issuedAt}::text` })
      .from(withholdingCertificates)
      .where(and(eq(withholdingCertificates.vendorId, vendorId), before === null ? undefined : sql`(${withholdingCertificates.issuedAt}::text, ${withholdingCertificates.id}::text) < (${before.stamp}, ${before.id})`))
      .orderBy(desc(withholdingCertificates.issuedAt), desc(withholdingCertificates.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const last = page.at(-1);
    return {
      rows: page.map((x) => ({ id: x.c.id, number: x.c.number, status: x.c.status, period: x.c.period, paidOn: x.c.paidOn, amount: x.c.amount, currency: x.c.currency })),
      next: found.length > take && last !== undefined ? { stamp: last.stamp, id: last.c.id } : null,
    };
  }
}
