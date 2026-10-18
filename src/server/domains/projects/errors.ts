/** A failure whose words are meant for the person at the screen. */
export class ProjectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}
