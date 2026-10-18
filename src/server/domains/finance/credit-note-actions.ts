'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { postingPermissions, run } from './action-runner';
import { fromCents, toCents } from './domain/receivables';

import { has } from '@/lib/values';

const fin = () => getContainer().finance;
const PATH = '/admin/finance/receivables/credit-note-excess';

export async function creditNoteExcessWorklistAction() {
  return await run('credit_note_excess:read', { surface: 'finance/credit-note-excess', action: 'view' }, async (ctx) => {
    const rows = await fin().creditNoteAccounting.worklist(ctx.companyId);
    const walletPolicy = await fin().creditPolicy.companyPolicy(getContainer().db, ctx.companyId);
    return {
      walletLabel: walletPolicy.label,
      walletEnabled: walletPolicy.walletEnabled,
      rows: rows.map((r) => ({
        creditNoteId: r.a.creditNoteId,
        creditNoteNo: r.creditNoteNo,
        order: r.sourceRef,
        reason: r.reasonCode,
        customerId: r.a.customerId,
        customer: r.customerName,
        customerNumber: r.customerNumber,
        currency: r.a.currency,
        credited: r.a.gross,
        takenOffInvoice: r.a.applied,
        open: fromCents(r.openCents),
        issuedAt: r.issuedAt.toISOString(),
      })),
      can: { resolve: await canPermission('credit_notes:resolve_excess'), giveUp: await canPermission('credit_adjustments:request') },
    };
  });
}

export async function creditNoteOpenInvoicesAction(creditNoteId: string) {
  return await run('credit_notes:resolve_excess', { surface: 'finance/credit-note-excess', action: 'open_invoices' }, async (ctx) =>
    (await fin().creditNoteAccounting.openInvoicesFor(ctx.companyId, creditNoteId)).map((i) => ({ entryId: i.id, documentNo: i.documentNo, remaining: i.remainingAmount, dueDate: i.dueDate ? i.dueDate.toISOString().slice(0, 10) : null })),
  );
}

export async function creditNoteExcessToWalletAction(creditNoteId: string, amount?: string) {
  return await run('credit_notes:resolve_excess', { surface: 'finance/credit-note-excess', action: 'to_wallet' }, async (ctx) => {
    await fin().creditNoteAccounting.resolveToWallet(ctx, creditNoteId, { cents: has(amount) ? toCents(amount) : undefined, permissions: await postingPermissions() });
  }, [PATH]);
}

export async function creditNoteExcessApplyAction(creditNoteId: string, applications: { entryId: string; amount: string }[] | 'oldest_first') {
  return await run('credit_notes:resolve_excess', { surface: 'finance/credit-note-excess', action: 'apply_to_invoices' }, async (ctx) => {
    const planned = applications === 'oldest_first' ? 'oldest_first' : applications.map((a) => ({ entryId: a.entryId, amountCents: toCents(a.amount) }));
    const out = await fin().creditNoteAccounting.applyExcess(ctx, creditNoteId, planned);
    return { applied: fromCents(out.appliedCents) };
  }, [PATH]);
}
