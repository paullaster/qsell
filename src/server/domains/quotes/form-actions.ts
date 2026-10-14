'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import { requireQuoteAuthor } from './authoring';
import type { QuoteActionResult } from './action-result';
import { QuoteFormService } from './quote-form-service';
import type { QuoteTotals } from './totals';
import { runQuoteAction } from './run';
import type { QuoteInput, QuoteTemplateInput } from './service';

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

/** The quote template form after choosing its default customer, or clearing it with `null`. */
export async function chooseTemplateCustomerAction(
  input: unknown,
  customerId: string | null,
): Promise<QuoteActionResult<QuoteTemplateInput>> {
  return await runQuoteAction(async () => {
    await requireQuoteAuthor();
    await requirePermission('customers:read');
    if (customerId !== null && typeof customerId !== 'string') throw new Error('Invalid customer.');
    return await new QuoteFormService().chooseTemplateCustomer(input, customerId);
  });
}

/** The form for a new quote (the default template's, if there is one). */
export async function startNewQuoteAction(): Promise<QuoteActionResult<QuoteInput>> {
  return runQuoteAction(async () => {
    await requirePermission('quotes:create');
    return new QuoteFormService().startNew();
  });
}

/** The form for editing a saved quote. */
export async function getQuoteFormAction(
  id: string,
): Promise<QuoteActionResult<{ form: QuoteInput; quoteNumber: string }>> {
  return runQuoteAction(async () => {
    await requirePermission('quotes:update');
    if (typeof id !== 'string') throw new Error('Invalid quote.');
    return new QuoteFormService().formFor(id);
  });
}

/** What the quote being typed comes to. Read-only: nothing is saved. */
export async function previewQuoteTotalsAction(
  raw: unknown,
): Promise<QuoteActionResult<QuoteTotals>> {
  return runQuoteAction(async () => {
    await requireQuoteAuthor();
    return new QuoteFormService().previewTotals(raw);
  });
}
