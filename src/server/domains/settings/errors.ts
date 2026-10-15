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
