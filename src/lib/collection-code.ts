/**
 * The code a customer shows at the counter to collect an order. Six characters from an alphabet with nothing that looks like
 * something else (no 0, O, 1, I or L), shown as `ABC-DEF`. It is only ever checked against its own order, a few wrong tries lock it,
 * and it works once, so six characters are plenty and easy to read out over a noisy counter.
 */
export const COLLECTION_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const COLLECTION_CODE_LENGTH = 6;
/** Wrong tries at the counter before the code is locked and a manager has to give a new one. */
export const COLLECTION_ATTEMPT_LIMIT = 5;

const ALPHABET_SIZE = COLLECTION_CODE_ALPHABET.length;
/** The largest multiple of the alphabet that fits in a byte: bytes at or above it are skipped, so no character is likelier than another. */
const FAIR_LIMIT = Math.floor(256 / ALPHABET_SIZE) * ALPHABET_SIZE;

/** A new code from the given source of random bytes (the caller passes the system's; a test passes its own). */
export function generateCollectionCode(randomBytes: (count: number) => Uint8Array): string {
  let code = '';
  while (code.length < COLLECTION_CODE_LENGTH) {
    for (const byte of randomBytes(COLLECTION_CODE_LENGTH * 2)) {
      if (byte >= FAIR_LIMIT) continue;
      code += COLLECTION_CODE_ALPHABET.charAt(byte % ALPHABET_SIZE);
      if (code.length === COLLECTION_CODE_LENGTH) break;
    }
  }
  return code;
}

/** What was typed, made comparable: capitals, with spaces, hyphens and other separators taken out. */
export function normalizeCollectionCode(typed: string): string {
  return typed.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Whether this has the shape of a code, before anything is looked up. */
export function isWellFormedCollectionCode(normalized: string): boolean {
  return normalized.length === COLLECTION_CODE_LENGTH && normalized.split('').every((c) => COLLECTION_CODE_ALPHABET.includes(c));
}

/** `ABCDEF` as `ABC-DEF`, for showing. */
export function showCollectionCode(code: string): string {
  const half = COLLECTION_CODE_LENGTH / 2;
  return `${code.slice(0, half)}-${code.slice(half)}`;
}
