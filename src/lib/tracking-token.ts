/**
 * The token in a customer's tracking link. 24 random bytes in base64url is 32 characters from this alphabet; anything else is not
 * one of ours, and is turned away before the database is asked. Pure; the random bytes are made on the server.
 */
export const TRACKING_TOKEN_LENGTH = 32;

export const isWellFormedTrackingToken = (value: unknown): value is string => typeof value === 'string' && value.length === TRACKING_TOKEN_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);

/** An address for a person to read in a list without showing all of it: the first letter of the name and the whole domain. */
export function maskEmail(address: string | null): string {
  if (address === null) return '';
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}
