import { AccessDeniedError } from '@/server/domains/access-control/engine';
import type { QuoteActionResult } from './action-result';

/**
 * Failures come back as data (see QuoteActionResult). The service states why in a plain `Error`;
 * anything else (a database or library error) is logged and kept off the screen.
 */
export async function runQuoteAction<T>(fn: () => Promise<T>): Promise<QuoteActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      return { ok: false, error: 'You do not have permission to do that.' };
    }
    if (error instanceof Error && error.constructor === Error) {
      return { ok: false, error: error.message };
    }
    console.error('[quotes]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
