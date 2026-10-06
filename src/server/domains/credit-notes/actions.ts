'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/domains/access-control/guard';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { getContainer } from '@/server/di/container';
import { CreditNoteError } from './service';
import type { CreditNoteReason } from './reasons';

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
    if (error instanceof CreditNoteError) return { ok: false, error: error.message };
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
}

/** Issues a credit note against an order's tax invoice. Signing happens afterwards, in the background. */
export async function issueOrderCreditNoteAction(input: {
  orderId: string;
  lines: { productId: string; quantity: number }[];
  reasonCode: CreditNoteReason;
  reasonNote?: string;
  restock?: boolean;
}): Promise<CreditNoteActionResult<CreditNoteView>> {
  return run(async () => {
    const userId = await requirePermission('credit_notes:create');
    const cn = await getContainer().creditNotes.issueForOrder({
      orderId: input.orderId,
      lines: input.lines,
      reason: { code: input.reasonCode, note: input.reasonNote },
      issuedBy: userId,
      restock: input.restock,
    });
    // The orders page does not show credit notes (the panel loads its own), so it is not
    // revalidated: that would make this response wait for a full page re-render. Stock is.
    if (input.restock) revalidatePath('/admin/inventory');
    return toView(cn);
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
  return run(async () =>
    (await getContainer().creditNotes.listForSource('order', orderId)).map(toView),
  );
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
