import { canPermission, requirePermission } from '@/server/domains/access-control/guard';

/**
 * For the actions behind the quote form, which serve both a new quote and an edit: the caller must
 * be allowed to create quotes or to update them. (Saving checks the one that applies again.)
 */
export async function requireQuoteAuthor(): Promise<void> {
  if (await canPermission('quotes:create')) return;
  await requirePermission('quotes:update');
}
