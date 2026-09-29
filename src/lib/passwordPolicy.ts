/**
 * Password rules shared by the browser forms and the server actions, so both
 * reject the same inputs with the same message.
 */

export const PASSWORD_MIN_LENGTH = 8;

/** bcrypt silently ignores everything past 72 bytes, so longer input would not all count. */
export const PASSWORD_MAX_BYTES = 72;

const encoder = new TextEncoder();

/** Returns a user-facing reason the password is unacceptable, or null when it is fine. */
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Choose a password with at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (encoder.encode(password).length > PASSWORD_MAX_BYTES) {
    return 'That password is too long. Use at most 72 characters (fewer if it has emoji or accents).';
  }
  if (password.trim().length === 0) {
    return 'Your password cannot be only spaces.';
  }
  return null;
}
