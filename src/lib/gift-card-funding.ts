/**
 * How gift cards came to exist, as the issue form asks it. Pure: the form collects a choice; the server checks that the
 * payment method is real and that the books know where the money came from.
 */
export type FundingKind = 'sold' | 'complimentary';

export type Funding = { kind: 'sold'; paymentMethodId: string } | { kind: 'complimentary' };

export const FUNDING_CHOICES: readonly { id: FundingKind; label: string; hint: string }[] = [
  { id: 'sold', label: 'Sold for money', hint: 'The money came in through a payment method; the cards are what the business now owes.' },
  { id: 'complimentary', label: 'Given free', hint: 'A promotion or goodwill; the value of the cards is a cost to the business.' },
];

/** What is wrong with the choice made, or null. */
export function fundingProblem(kind: FundingKind | null, methodId: string | null): string | null {
  if (kind === null) return 'Say how the cards were paid for: sold for money, or given free.';
  if (kind === 'sold' && methodId === null) return 'Choose the payment method the money came in through.';
  return null;
}

/** What is sent: a method only for cards that were sold. */
export function fundingInput(kind: FundingKind | null, methodId: string | null): Funding | undefined {
  if (kind === 'complimentary') return { kind };
  return kind === 'sold' && methodId !== null ? { kind, paymentMethodId: methodId } : undefined;
}
