'use server';

import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { has } from '@/lib/values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 200): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const optionalId = (value: unknown): string => (has(str(value, 40)) ? id(value) : '');
const PATHS = ['/admin/vendors/payment-rules'];

export async function paymentRulesAction() {
  return await run('vendor_payments:manage_terms', { surface: 'vendor_payments/rules', action: 'view' }, async (ctx) => {
    const container = getContainer();
    const [codes, accounts] = await Promise.all([container.paymentTerms.codes(ctx.companyId), container.paymentTerms.accounts(ctx.companyId)]);
    return { codes: codes.map((c) => ({ id: c.id, code: c.code, name: c.name, ratePercent: c.ratePercent, base: c.base, active: c.active })), accounts };
  });
}

export async function saveWithholdingCodeAction(codeId: string | null, input: unknown) {
  return await run('vendor_payments:manage_terms', { surface: 'vendor_payments/rules', action: 'save_code' }, async (ctx) => {
    const i = obj(input);
    return await getContainer().paymentTerms.saveCode(ctx, codeId === null ? null : id(codeId), { code: str(i.code, 30), name: str(i.name, 150), ratePercent: str(i.ratePercent, 8), base: str(i.base, 8), active: i.active !== false });
  }, PATHS);
}

export async function savePaymentAccountsAction(input: unknown) {
  return await run('vendor_payments:manage_terms', { surface: 'vendor_payments/rules', action: 'save_accounts' }, async (ctx) => {
    const i = obj(input);
    await getContainer().paymentTerms.saveAccounts(ctx, { payables: optionalId(i.payables), prepayments: optionalId(i.prepayments), paymentDiscount: optionalId(i.paymentDiscount), paymentTolerance: optionalId(i.paymentTolerance), withholdingPayable: optionalId(i.withholdingPayable), toleranceAmount: str(i.toleranceAmount, 20) });
  }, PATHS);
}

/** What one vendor is paid under: its withholding code and early-payment discount. Read with the vendor card. */
export async function vendorTermsAction(vendorId: string) {
  return await run('vendors:read', { surface: 'vendors/terms', action: 'view' }, async (ctx) => {
    const found = await getContainer().paymentTerms.vendorTerms(ctx.companyId, id(vendorId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    return found;
  });
}

export async function saveVendorTermsAction(vendorId: string, input: unknown) {
  return await run('vendor_payments:manage_terms', { surface: 'vendors/terms', action: 'save' }, async (ctx) => {
    const i = obj(input);
    await getContainer().paymentTerms.saveVendorTerms(ctx, id(vendorId), { withholdingCodeId: optionalId(i.withholdingCodeId), earlyDiscountPercent: str(i.earlyDiscountPercent, 8), earlyDiscountDays: str(i.earlyDiscountDays, 5) });
  }, ['/admin/vendors']);
}

export async function certificatesAction(filter: { period?: string; vendorId?: string; before?: { stamp: string; id: string } | null } = {}) {
  return await run('vendor_payments:read', { surface: 'vendor_payments/certificates', action: 'list' }, async (ctx) => {
    const before = filter.before !== undefined && filter.before !== null && UUID.test(filter.before.id) && filter.before.stamp.length <= 40 ? filter.before : null;
    const period = has(filter.period) && /^\d{4}-\d{2}$/.test(filter.period) ? filter.period : undefined;
    return await getContainer().paymentTerms.certificates(ctx.companyId, { period, vendorId: has(filter.vendorId) && UUID.test(filter.vendorId) ? filter.vendorId : undefined, before });
  });
}

export async function certificateAction(certificateId: string) {
  return await run('vendor_payments:read', { surface: 'vendor_payments/certificates', action: 'view' }, async (ctx) => {
    const found = await getContainer().paymentTerms.certificate(ctx.companyId, id(certificateId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That certificate does not exist.');
    return found;
  });
}
