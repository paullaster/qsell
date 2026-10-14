'use server';

import { requirePermission } from '@/server/domains/access-control/guard';
import type { QuoteInput } from './service';
import { runQuoteAction } from './run';
import { TemplateSwapService, type SwapSummary } from './template-swap-service';
import type { QuoteActionResult } from './action-result';

/**
 * What switching a template would do to the quote being edited. Read-only: nothing is saved here
 * (the quote is saved, and checked again, only when the person saves it). The form arrives from the
 * browser, so it is shape-checked before use and the templates are read for the caller's company.
 */
const swaps = () => new TemplateSwapService();

export async function planQuoteTemplateSwapAction(
  input: unknown,
  templateId: string | null,
): Promise<QuoteActionResult<SwapSummary>> {
  return await runQuoteAction(async () => {
    await requirePermission('quotes:update');
    if (templateId !== null && typeof templateId !== 'string') throw new Error('Invalid template.');
    return await swaps().planQuoteSwap(input, templateId);
  });
}

export async function planSectionTemplateSwapAction(
  input: unknown,
  sectionId: string,
  templateId: string | null,
): Promise<QuoteActionResult<SwapSummary>> {
  return await runQuoteAction(async () => {
    await requirePermission('quotes:update');
    if (typeof sectionId !== 'string') throw new Error('Invalid section.');
    if (templateId !== null && typeof templateId !== 'string') throw new Error('Invalid template.');
    return await swaps().planSectionSwap(input, sectionId, templateId);
  });
}

export async function addSectionFromTemplateAction(
  input: unknown,
  templateId: string,
): Promise<QuoteActionResult<QuoteInput>> {
  return await runQuoteAction(async () => {
    await requirePermission('quotes:update');
    if (typeof templateId !== 'string') throw new Error('Invalid template.');
    return await swaps().addSection(input, templateId);
  });
}

/** A new quote's form, started from a template (keeping any customer already chosen). */
export async function startQuoteFromTemplateAction(
  templateId: string,
  base?: unknown,
): Promise<QuoteActionResult<QuoteInput>> {
  return await runQuoteAction(async () => {
    await requirePermission('quotes:create');
    if (typeof templateId !== 'string') throw new Error('Invalid template.');
    return await swaps().draftFromTemplate(templateId, base);
  });
}

/** The company's default template as a new quote's form, or null when none is set. */
export async function getDefaultQuoteDraftAction(): Promise<QuoteActionResult<QuoteInput | null>> {
  return await runQuoteAction(async () => {
    await requirePermission('quotes:create');
    return await swaps().defaultDraft();
  });
}
