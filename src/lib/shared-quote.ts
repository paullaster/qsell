/** What a customer's quote link shows, from the quote's status: it can be answered only while the quote is sent. */
export type SharedQuoteState = 'open' | 'accepted' | 'rejected' | 'expired' | 'closed';

export function sharedStateOf(status: string): SharedQuoteState {
  if (status === 'sent') return 'open';
  if (status === 'accepted' || status === 'converting' || status === 'converted') return 'accepted';
  if (status === 'rejected') return 'rejected';
  if (status === 'expired') return 'expired';
  return 'closed';
}
