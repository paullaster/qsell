/** Where a quote the shopper asked for stands, in the words they read (quote statuses are the staff's). */
export type QuoteRequestState = 'preparing' | 'sent' | 'accepted' | 'declined' | 'expired' | 'cancelled';

export const QUOTE_REQUEST_STATE_WORDS: Record<QuoteRequestState, { label: string; hint: string }> = {
  preparing: { label: 'Being prepared', hint: 'We are checking your request and will email you the quote.' },
  sent: { label: 'Sent to you', hint: 'We emailed you the quote. Open the email to review and accept it.' },
  accepted: { label: 'Accepted', hint: 'You accepted this quote. We are preparing your order.' },
  declined: { label: 'Declined', hint: 'This quote was declined.' },
  expired: { label: 'Expired', hint: 'This quote is past its valid date. Ask for a new one.' },
  cancelled: { label: 'Cancelled', hint: 'This request was cancelled.' },
};

/** The shopper's word for a staff status; anything unknown reads as still being prepared (never as a promise). */
export function quoteRequestState(status: string): QuoteRequestState {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'accepted':
    case 'converted':
    case 'converting':
      return 'accepted';
    case 'rejected':
      return 'declined';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'preparing';
  }
}
