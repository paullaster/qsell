/** What a customer is told about a scheduled visit (an installation or a site job), in their words. Pure. */

export type CustomerVisitState = 'booked' | 'with_you' | 'done' | 'signed_off' | 'cancelled';

const STATES: Record<string, { state: CustomerVisitState; words: string }> = {
  scheduled: { state: 'booked', words: 'Booked. We will assign the crew before the visit.' },
  crew_assigned: { state: 'booked', words: 'Booked, and your crew is assigned.' },
  on_site: { state: 'with_you', words: 'The crew is with you now.' },
  completed: { state: 'done', words: 'The work is done and waiting for your sign-off.' },
  signed_off: { state: 'signed_off', words: 'Signed off. Thank you.' },
  cancelled: { state: 'cancelled', words: 'Cancelled.' },
};

/** The state and words for a visit's status; a status this does not know reads as booked rather than as nothing. */
export function customerVisitWords(status: string): { state: CustomerVisitState; words: string } {
  return STATES[status] ?? { state: 'booked', words: 'Booked.' };
}
