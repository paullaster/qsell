import { AmountError } from './domain/amount';

/** Turns an amount-parsing failure into a message for the user; anything else is not ours. */
export function AmountErrorGuard(error: unknown): string | null {
  return error instanceof AmountError ? error.message : null;
}
