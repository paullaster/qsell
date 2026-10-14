'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import { requireQuoteAuthor } from './authoring';
import type { QuoteActionResult } from './action-result';
import { QuoteFormService } from './quote-form-service';
import { runQuoteAction } from './run';
import type { QuoteInput } from './service';

/** The quote form after choosing a trade customer, or clearing the choice with `null`. */
export async function chooseQuoteCustomerAction(
  input: unknown,
  customerId: string | null,
): Promise<QuoteActionResult<QuoteInput>> {
  return await runQuoteAction(async () => {
    await requireQuoteAuthor();
    await requirePermission('customers:read');
    if (customerId !== null && typeof customerId !== 'string') throw new Error('Invalid customer.');
    return await new QuoteFormService().chooseCustomer(input, customerId);
  });
}
