export const CREDIT_NOTE_REASONS = [
  'returned_goods',
  'damaged_goods',
  'pricing_error',
  'order_cancelled',
  'goodwill',
  'other',
] as const;
export type CreditNoteReason = (typeof CREDIT_NOTE_REASONS)[number];
