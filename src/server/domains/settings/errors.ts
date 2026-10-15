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

/** True when the database refused a row because it duplicates one that must be unique. */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
