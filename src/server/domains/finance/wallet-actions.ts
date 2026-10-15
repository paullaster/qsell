'use server';

import { businessDate } from '@/server/kernel/numbering/business-date';
import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { postingPermissions, run } from './action-runner';
import { fromCents, toCents } from './domain/receivables';
import type { PolicyInput } from './receivables/credit-policy-service';

import { has } from '@/lib/values';

const fin = () => getContainer().finance;
const CUSTOMER = (id: string) => `/admin/finance/receivables/customer/${id}`;

export async function customerWalletAction(customerId: string) {
  return await run('wallet:read', { surface: 'finance/customer-ledger', action: 'wallet_view' }, async (ctx) => {
    const [data, open] = await Promise.all([fin().wallets.forCustomer(ctx.companyId, customerId), fin().customerLedger.openItems(ctx.companyId, customerId)]);
    return {
      label: data.policy.label,
      walletEnabled: data.policy.walletEnabled,
      autoApply: data.policy.autoApply,
      wallets: data.wallets.map((w) => ({ id: w.id, currency: w.currency, status: w.status, balance: w.balance })),
      entries: data.entries.map((e) => ({
        id: e.id,
        type: e.entryType,
        amount: e.amount,
        currency: e.currency,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        reason: e.reasonCode,
        date: e.postingDate,
        by: e.actorId,
        at: e.createdAt.toISOString(),
      })),
      openInvoices: open.filter((i) => i.documentType === 'invoice' && Number(i.remainingAmount) > 0).map((i) => ({ entryId: i.id, documentNo: i.documentNo, remaining: i.remainingAmount, currency: i.currency ?? '', dueDate: i.dueDate ? i.dueDate.toISOString().slice(0, 10) : null })),
      can: {
        utilise: await canPermission('wallet:utilise'),
        reverse: await canPermission('wallet:reverse_use'),
        freeze: await canPermission('wallet:freeze'),
      },
    };
  });
}

export async function moveReceiptToWalletAction(receiptId: string, amount?: string) {
  return await run('wallet:move_receipt', { surface: 'finance/receipts/detail', action: 'move_to_wallet' }, async (ctx) => {
    const out = await fin().wallets.moveReceiptToWallet(ctx, receiptId, { cents: has(amount) ? toCents(amount) : undefined, permissions: await postingPermissions() });
    return { moved: fromCents(out.movedCents) };
  }, [`/admin/finance/receipts/${receiptId}`]);
}

export async function useWalletAction(customerId: string, currency: string, applications: { entryId: string; amount: string }[] | 'oldest_first', maxAmount?: string) {
  return await run('wallet:utilise', { surface: 'finance/customer-ledger', action: 'wallet_use' }, async (ctx) => {
    const planned = applications === 'oldest_first' ? 'oldest_first' : applications.map((a) => ({ entryId: a.entryId, amountCents: toCents(a.amount) }));
    const out = await fin().wallets.utilise(ctx, { customerId, currency, applications: planned, maxCents: has(maxAmount) ? toCents(maxAmount) : undefined });
    return { used: fromCents(out.usedCents) };
  }, [CUSTOMER(customerId)]);
}

export async function reverseWalletUseAction(customerId: string, entryId: number, reason: { code: string; text?: string }) {
  return await run('wallet:reverse_use', { surface: 'finance/customer-ledger', action: 'wallet_use_reverse' }, async (ctx) => {
    await fin().wallets.reverseUtilisation(ctx, entryId, reason, await postingPermissions());
  }, [CUSTOMER(customerId)]);
}

export async function freezeWalletAction(customerId: string, currency: string, frozen: boolean, reason?: string) {
  return await run('wallet:freeze', { surface: 'finance/customer-ledger', action: frozen ? 'wallet_freeze' : 'wallet_unfreeze' }, async (ctx) => {
    await fin().wallets.setFrozen(ctx, customerId, currency, frozen, reason);
  }, [CUSTOMER(customerId)]);
}

export async function walletReportAction() {
  return await run('wallet:read', { surface: 'finance/wallets', action: 'view' }, async (ctx) => {
    const [report, recon, policy] = await Promise.all([fin().wallets.report(ctx.companyId), fin().wallets.reconciliation(ctx.companyId), fin().creditPolicy.companyPolicy(getContainer().db, ctx.companyId)]);
    return {
      label: policy.label,
      walletEnabled: policy.walletEnabled,
      totals: report.totals.map((t) => ({ currency: t.currency, total: t.total, holders: t.holders })),
      top: report.top.map((r) => ({ customerId: r.w.customerId, name: r.name, number: r.number, currency: r.w.currency, balance: r.w.balance, status: r.w.status })),
      reconciliation: recon.map((r) => ({ accountNo: r.accountNo, accountName: r.accountName, gl: fromCents(r.glCents), wallets: fromCents(r.walletsCents), diff: fromCents(r.diffCents) })),
    };
  });
}

export async function creditPolicyAction() {
  return await run('wallet:read', { surface: 'finance/wallet-policy', action: 'view' }, async (ctx) => {
    const { rows, groups } = await fin().creditPolicy.list(ctx.companyId);
    return {
      today: businessDate(),
      groups,
      rows: rows.map((r) => ({
        groupCode: r.groupCode,
        effectiveFrom: r.effectiveFrom,
        walletEnabled: r.walletEnabled,
        allowDeposits: r.allowDeposits,
        overpaymentDefault: r.overpaymentDefault,
        autoApply: r.autoApply,
        creditNoteExcess: r.creditNoteExcessDefault,
        refundsEnabled: r.refundsEnabled,
        walletCashOut: r.walletCashOut,
        maxBalance: r.maxBalance,
        label: r.label,
      })),
      canEdit: await canPermission('customer_credit_policy:edit'),
    };
  });
}

export async function saveCreditPolicyAction(input: PolicyInput) {
  return await run('customer_credit_policy:edit', { surface: 'finance/wallet-policy', action: 'save' }, async (ctx) => {
    await fin().creditPolicy.save(ctx, input);
  }, ['/admin/finance/receivables/wallet-policy']);
}

/** For the receipt form: is there a wallet to take an advance, and what is it called. */
export async function walletFormOptionsAction() {
  return await run('receipts:create', { surface: 'finance/receipts/new', action: 'wallet_options' }, async (ctx) => {
    const p = await fin().creditPolicy.companyPolicy(getContainer().db, ctx.companyId);
    return { enabled: p.walletEnabled && p.allowDeposits, label: p.label, canDeposit: await canPermission('wallet:deposit') };
  });
}
