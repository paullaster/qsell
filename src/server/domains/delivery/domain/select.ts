import { scopesCanOverlap } from '@/server/domains/pricing/domain/rules';
import { scopeMismatch } from '@/server/domains/pricing/domain/resolve';
import { DEFAULT_WEIGHTS, SCOPE_DIMENSIONS, type PriceContext, type Scopes } from '@/server/domains/pricing/domain/types';

export type PolicyStatus = 'draft' | 'in_force' | 'retired';

/** What choosing a policy needs to know about it. */
export interface PolicyHeader {
  id: string;
  code: string;
  currency: string;
  status: PolicyStatus;
  priority: number;
  validFrom: Date;
  validTo: Date | null;
  scopes: Scopes;
}

/** What is known about the delivery being priced. A missing value simply does not match a scope. */
export interface ChargeContext {
  at: Date;
  currency: string;
  branchId?: string | null;
  channel?: string | null;
  customerId?: string | null;
  customerGroupId?: string | null;
  salesType?: string | null;
  country?: string | null;
}

export type Outcome = 'won' | 'lost' | 'not_applicable';

export interface Considered {
  id: string;
  code: string;
  outcome: Outcome;
  /** Why it did not win, in words. */
  why: string | null;
  specificity: number;
}

/** The sum of the weights of the dimensions the policy limits with "only", as price lists are ranked. */
export function scopeSpecificity(scopes: Scopes): number {
  let total = 0;
  for (const d of SCOPE_DIMENSIONS) {
    const rule = scopes[d];
    if (rule?.op === 'in' && rule.values.length > 0) total += DEFAULT_WEIGHTS[d];
  }
  return total;
}

const between = (at: Date, from: Date, to: Date | null): boolean => at.getTime() >= from.getTime() && (to === null || at.getTime() < to.getTime());

const asPriceContext = (ctx: ChargeContext): PriceContext => ({
  at: ctx.at,
  currency: ctx.currency,
  baseCurrency: ctx.currency,
  rateFromBase: 1,
  decimals: 2,
  customerId: ctx.customerId ?? null,
  customerGroupId: ctx.customerGroupId ?? null,
  branchId: ctx.branchId ?? null,
  channel: ctx.channel ?? null,
  salesType: ctx.salesType ?? null,
  country: ctx.country ?? null,
  route: null,
});

/** Most specific first, then higher priority, then newest start, then code, then id: one total order, so the answer never depends on the order they come in. */
function byPreference(a: { header: PolicyHeader; specificity: number }, b: { header: PolicyHeader; specificity: number }): number {
  if (a.specificity !== b.specificity) return b.specificity - a.specificity;
  if (a.header.priority !== b.header.priority) return b.header.priority - a.header.priority;
  const start = b.header.validFrom.getTime() - a.header.validFrom.getTime();
  if (start !== 0) return start;
  const code = a.header.code.localeCompare(b.header.code);
  return code !== 0 ? code : a.header.id.localeCompare(b.header.id);
}

/**
 * The policy that applies: among those in force whose scope and dates fit, the most specific, then the higher priority, then the
 * newest start, then the code. Also says what happened to every policy it looked at, so a screen can explain the choice.
 */
export function choosePolicy<H extends PolicyHeader>(headers: readonly H[], ctx: ChargeContext): { chosen: H | null; considered: Considered[] } {
  const eligible: { header: H; specificity: number }[] = [];
  const considered: Considered[] = [];
  const out = (h: H, outcome: Outcome, why: string | null, specificity: number): void => {
    considered.push({ id: h.id, code: h.code, outcome, why, specificity });
  };
  for (const header of headers) {
    const specificity = scopeSpecificity(header.scopes);
    if (header.status !== 'in_force') out(header, 'not_applicable', header.status === 'draft' ? 'Still a draft' : 'Retired', specificity);
    else if (header.currency !== ctx.currency) out(header, 'not_applicable', `Charges in ${header.currency}, not ${ctx.currency}`, specificity);
    else if (!between(ctx.at, header.validFrom, header.validTo)) out(header, 'not_applicable', ctx.at.getTime() < header.validFrom.getTime() ? 'Not started yet' : 'Ended', specificity);
    else {
      const mismatch = scopeMismatch(header.scopes, asPriceContext(ctx));
      if (mismatch === null) eligible.push({ header, specificity });
      else out(header, 'not_applicable', mismatch, specificity);
    }
  }
  eligible.sort(byPreference);
  const winner = eligible.at(0);
  for (const e of eligible) {
    if (e.header.id === winner?.header.id) out(e.header, 'won', null, e.specificity);
    else if (winner !== undefined && e.specificity !== winner.specificity) out(e.header, 'lost', `Less specific (${String(e.specificity)} against ${String(winner.specificity)})`, e.specificity);
    else if (winner !== undefined && e.header.priority !== winner.header.priority) out(e.header, 'lost', `Same specificity, lower priority (${String(e.header.priority)} against ${String(winner.header.priority)})`, e.specificity);
    else out(e.header, 'lost', 'Same priority, but an older policy', e.specificity);
  }
  return { chosen: winner?.header ?? null, considered };
}

/**
 * Could a delivery fall under both policies with nothing to choose between them? Same currency, same priority, same specificity, scopes that
 * can overlap and dates that overlap. Activation is refused for it, because the winner would be decided by the start date, which is rarely meant.
 */
export function wouldTie(a: PolicyHeader, b: PolicyHeader): boolean {
  const aEnd = a.validTo?.getTime() ?? Number.POSITIVE_INFINITY;
  const bEnd = b.validTo?.getTime() ?? Number.POSITIVE_INFINITY;
  return a.currency === b.currency && a.priority === b.priority && scopeSpecificity(a.scopes) === scopeSpecificity(b.scopes) && scopesCanOverlap(a.scopes, b.scopes) && a.validFrom.getTime() < bEnd && b.validFrom.getTime() < aEnd;
}
