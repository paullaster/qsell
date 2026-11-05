/**
 * Proving a delivery at the door. The company chooses what a rider must show to mark a delivery delivered: nothing, the customer's
 * code, a photo, or either of the two. A failed attempt is never held up by proof: the rider says why and may add a photo. Pure:
 * the rules apart from the database and the phone.
 */

export const PROOF_RULES = ['none', 'code', 'photo', 'code_or_photo'] as const;
export type ProofRule = (typeof PROOF_RULES)[number];
export const isProofRule = (value: unknown): value is ProofRule => typeof value === 'string' && (PROOF_RULES as readonly string[]).includes(value);

export const PROOF_WORDS: Record<ProofRule, string> = {
  none: 'No proof needed',
  code: "The customer's code",
  photo: 'A photo',
  code_or_photo: "The customer's code or a photo",
};

export const PROOF_HELP: Record<ProofRule, string> = {
  none: 'The rider says who received it. Nothing else is asked.',
  code: 'The customer is sent a six-digit code when the delivery goes out and says it at the door. The rider types it in.',
  photo: 'The rider takes a photo of the goods at the door.',
  code_or_photo: 'The code if the customer has it, otherwise a photo (for example when their phone is off).',
};

/** Whether the customer is given a code for this rule. */
export const usesCode = (rule: ProofRule): boolean => rule === 'code' || rule === 'code_or_photo';

/** How many wrong codes are tried at one door before the rider is sent to the office: a code is six digits, so guessing is stopped. */
export const MAX_CODE_TRIES = 5;

/** A six-digit code from random bytes (the caller supplies them, so this stays pure). Leading zeros are kept. */
export function codeFromBytes(bytes: Uint8Array): string {
  let n = 0;
  for (let i = 0; i < 4; i += 1) n = n * 256 + (bytes[i] ?? 0);
  return String(n % 1_000_000).padStart(6, '0');
}

/** Spaces and dashes a person types between digits are ignored. */
export const normaliseCode = (typed: unknown): string => (typeof typed === 'string' ? typed.replace(/[\s-]/g, '') : '');

export const isHandoverCode = (value: string): boolean => /^\d{6}$/.test(value);

/** Same length, compared without stopping at the first difference. */
export function codesMatch(typed: unknown, actual: string | null): boolean {
  const a = normaliseCode(typed);
  if (actual === null || !isHandoverCode(actual) || a.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

/**
 * The rule that applies to one delivery. A delivery that went out before the company asked for codes has none to give, so a photo
 * stands in for the code rather than stranding the rider at the door.
 */
export const ruleFor = (rule: ProofRule, hasCode: boolean): ProofRule => (usesCode(rule) && !hasCode ? 'photo' : rule);

export interface ProofGiven {
  /** A code was typed and it is the customer's. */
  codeMatched: boolean;
  /** A photo of this rider's, not used before, came with it. */
  hasPhoto: boolean;
}

/** What is missing for the delivery to be marked delivered, in words for the rider; null when the rule is met. */
export function proofProblem(rule: ProofRule, given: ProofGiven): string | null {
  switch (rule) {
    case 'none':
      return null;
    case 'code':
      return given.codeMatched ? null : "Ask the customer for their six-digit code and type it in.";
    case 'photo':
      return given.hasPhoto ? null : 'Take a photo of the goods at the door.';
    case 'code_or_photo':
      return given.codeMatched || given.hasPhoto ? null : "Type the customer's six-digit code, or take a photo of the goods at the door.";
  }
}

/** The proofs that count for a delivered attempt, in the order they are kept. */
export function proofsKept(rule: ProofRule, given: ProofGiven): ('code' | 'photo')[] {
  const kept: ('code' | 'photo')[] = [];
  if (usesCode(rule) && given.codeMatched) kept.push('code');
  if (given.hasPhoto) kept.push('photo');
  return kept;
}

/** The longest a phone's clock may differ from the server's before the phone's time is not kept (it is only ever kept as a note). */
const MAX_SKEW_MS = 24 * 3_600_000;

/** The phone's own time, when it is a real time within a day of the server's; otherwise null. It never orders anything. */
export function usableClientTime(value: unknown, now: Date): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return Math.abs(at.getTime() - now.getTime()) <= MAX_SKEW_MS ? at : null;
}

export interface Place {
  lat: number;
  lng: number;
}

/** Where the phone says it is, only if both numbers are real coordinates. */
export function placeFrom(lat: unknown, lng: unknown): Place | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

/** A key the phone makes once per try, so a retry of the same try is the same try. */
export const isClientKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
