'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import type { RelatedDocuments } from './order-documents-service';

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** Staff: the documents before and after an order (the quote it came from, its invoices). A malformed or unknown id is answered with nothing. */
export async function orderDocumentsAction(orderId: unknown): Promise<{ ok: true; data: RelatedDocuments | null } | { ok: false; error: string }> {
  await requirePermission('orders:read');
  if (typeof orderId !== 'string' || !ID.test(orderId)) return { ok: true, data: null };
  try {
    const c = getContainer();
    return { ok: true, data: await c.orderDocuments.of((await c.companySettings.ensureSeeded()).id, orderId) };
  } catch (error) {
    console.error('[orders] related documents', error);
    return { ok: false, error: 'The related documents could not be loaded.' };
  }
}
