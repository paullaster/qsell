'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/domains/access-control/guard';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { getContainer } from '@/server/di/container';
import { CreditNoteError } from './service';
import { PostingError } from '@/server/domains/finance/engine';
import { FinanceError } from '@/server/domains/finance/errors';
import type { CreditNoteReason } from './reasons';
import type { CreditAsk } from '@/lib/credit-units';

import { has } from '@/lib/values';

/** `forbidden` lets the screen hide itself for people without the permission. */
export type CreditNoteActionResult<T> =
  { ok: true; data: T } | { ok: false; error: string; forbidden?: true };

async function run<T>(fn: () => Promise<T>): Promise<CreditNoteActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      return {
        ok: false,
        error: 'You do not have permission to manage credit notes.',
        forbidden: true,
      };
    }
    if (error instanceof CreditNoteError || error instanceof FinanceError || error instanceof PostingError) return { ok: false, error: error.message };
    console.error('[credit-notes]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

export interface CreditNoteView {
  id: string;
  creditNoteNo: string;
  totalAmount: number;
  currency: string;
  kraStatus: string;
  reasonCode: string;
  createdAt: string;
  /** What it did to the customer's account (absent for credit notes issued before this existed). */
  accounting?: { applied: number; excessOpen: number; toWallet: number; toInvoices: number };
  /** The goods expected back because of it. */
  returnReceipt?: { id: string; number: string; status: string };
}

/** Issues a credit note against an order's tax invoice. Signing happens afterwards, in the background. */
export type IssueCreditNoteOutcome =
  | { status: 'issued'; creditNote: CreditNoteView }
  /** A workflow asks for approval first; the credit note is issued when it is given. */
  | { status: 'pending_approval'; message: string };

export async function issueOrderCreditNoteAction(input: {
  orderId: string;
  lines: CreditAsk[];
  reasonCode: CreditNoteReason;
  reasonNote?: string;
  restock?: boolean;
}): Promise<CreditNoteActionResult<IssueCreditNoteOutcome>> {
  return run(async () => {
    const userId = await requirePermission('credit_notes:create');
    const outcome = await getContainer().creditNotes.issueForOrderGated({
      orderId: input.orderId,
      lines: input.lines,
      reason: { code: input.reasonCode, note: input.reasonNote },
      issuedBy: userId,
      restock: input.restock,
    });
    if (outcome.status === 'pending_approval') return outcome;
    // The orders page does not show credit notes (the panel loads its own), so it is not
    // revalidated: that would make this response wait for a full page re-render. Stock is.
    if (input.restock === true) revalidatePath('/admin/inventory');
    return { status: 'issued' as const, creditNote: toView(outcome.creditNote) };
  });
}

/** Signs a credit note again, e.g. after a gateway outage or once configuration is fixed. */
export async function retryCreditNoteSigningAction(
  creditNoteId: string,
): Promise<CreditNoteActionResult<{ outcome: string; reason: string }>> {
  return run(async () => {
    await requirePermission('credit_notes:create');
    const r = await getContainer().creditNotes.retrySigning(creditNoteId);
    return { outcome: r.outcome, reason: r.reason };
  });
}

export async function listOrderCreditNotesAction(
  orderId: string,
): Promise<CreditNoteActionResult<CreditNoteView[]>> {
  await requirePermission('credit_notes:create');
  return run(async () => {
    const c = getContainer();
    const notes = await c.creditNotes.listForSource('order', orderId);
    const ids = notes.map((n) => n.id);
    const companyId = notes[0]?.companyId;
    const [acc, returns] = await Promise.all([
      has(companyId) ? c.finance.creditNoteAccounting.summaries(companyId, ids) : Promise.resolve(undefined),
      has(companyId) ? c.returns.forCreditNotes(ids) : Promise.resolve(undefined),
    ]);
    return notes.map((n) => {
      const a = acc?.get(n.id);
      const r = returns?.get(n.id);
      return {
        ...toView(n),
        ...(a !== undefined
          ? {
              accounting: {
                applied: Number(a.applied),
                excessOpen: a.openCents / 100,
                toWallet: a.resolutions.filter((x) => x.kind === 'wallet').reduce((sum, x) => sum + Number(x.amount), 0),
                toInvoices: a.resolutions.filter((x) => x.kind === 'applied').reduce((sum, x) => sum + Number(x.amount), 0),
              },
            }
          : {}),
        ...(r !== undefined ? { returnReceipt: { id: r.id, number: r.number, status: r.status } } : {}),
      };
    });
  });
}

/** What the issue screen needs: per-line creditable quantities and whether restock applies. */
export async function getOrderCreditableAction(orderId: string) {
  return run(async () => {
    await requirePermission('credit_notes:create');
    return getContainer().creditNotes.creditableForOrder(orderId);
  });
}

function toView(cn: {
  id: string;
  creditNoteNo: string;
  totalAmount: string;
  currency: string;
  kraStatus: string;
  reasonCode: string;
  createdAt: Date;
}): CreditNoteView {
  return {
    id: cn.id,
    creditNoteNo: cn.creditNoteNo,
    totalAmount: Number(cn.totalAmount),
    currency: cn.currency,
    kraStatus: cn.kraStatus,
    reasonCode: cn.reasonCode,
    createdAt: cn.createdAt.toISOString(),
  };
}
