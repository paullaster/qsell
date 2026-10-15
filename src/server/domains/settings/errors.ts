/** A failure whose words are meant for the person at the screen (never a database or system message). */
export class SettingsError extends Error {
  constructor(
    message: string,
    readonly code = 'INVALID',
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** What a screen is told when the address names a record that cannot exist (an id that is not an id at all). */
export const NO_SUCH_RECORD = { ok: false, error: 'That record does not exist.', code: 'NOT_FOUND' } as const;

/** True when the database refused a value because it is not the kind of id the column holds (a made-up address). */
export function isMalformedId(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '22P02' || e?.cause?.code === '22P02';
}

/** True when the database refused a row because it duplicates one that must be unique. */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
