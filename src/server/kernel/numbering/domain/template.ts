import { isIsoDate } from './period';

import { has } from '@/lib/values';

export class TemplateError extends Error {
  constructor(
    readonly code: 'BRANCH_REQUIRED' | 'BAD_DATE',
    message: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}

export const TEMPLATE_TOKENS = ['YYYY', 'YY', 'MM', 'BRANCH'] as const;

/** Letters, digits and - _ / . plus the tokens above. Nothing a fiscal system could reject. */
const TEMPLATE_PATTERN = /^(?:[A-Za-z0-9\-_/.]|\{(?:YYYY|YY|MM|BRANCH)\})*$/;
const MAX_TEMPLATE_LENGTH = 24;

/** Null when the template is acceptable, otherwise a message an admin can act on. */
export function validateTemplate(template: string): string | null {
  if (template.length > MAX_TEMPLATE_LENGTH) {
    return `Use at most ${MAX_TEMPLATE_LENGTH} characters.`;
  }
  if (!TEMPLATE_PATTERN.test(template)) {
    return 'Use letters, digits and - _ / . only, plus the tokens {YYYY} {YY} {MM} {BRANCH}.';
  }
  return null;
}

export function usesBranchToken(template: string): boolean {
  return template.includes('{BRANCH}');
}

/** Does a line number each branch separately? */
export function numbersPerBranch(line: { prefix: string; suffix: string }): boolean {
  return usesBranchToken(line.prefix) || usesBranchToken(line.suffix);
}

export interface RenderContext {
  /** ISO business date, `YYYY-MM-DD`. */
  date: string;
  branchCode?: string | null;
}

/** Replaces tokens using the document's own date, so back-dated documents number correctly. */
export function renderTemplate(template: string, ctx: RenderContext): string {
  if (!isIsoDate(ctx.date))
    throw new TemplateError('BAD_DATE', `"${ctx.date}" is not a valid date.`);
  const yyyy = ctx.date.slice(0, 4);
  const mm = ctx.date.slice(5, 7);
  return template.replace(/\{(YYYY|YY|MM|BRANCH)\}/g, (_all, token: string) => {
    switch (token) {
      case 'YYYY':
        return yyyy;
      case 'YY':
        return yyyy.slice(2);
      case 'MM':
        return mm;
      default: {
        const branch = ctx.branchCode?.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (!has(branch)) {
          throw new TemplateError(
            'BRANCH_REQUIRED',
            'This series numbers by branch, but the document has none.',
          );
        }
        return branch;
      }
    }
  });
}
