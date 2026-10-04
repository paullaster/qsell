/** A problem the user can fix (bad file, asset in use…). Its message is safe to show. */
export class MediaError extends Error {}

/**
 * Media storage is not set up (or set up wrongly) on this server. An operator problem,
 * not the user's: the message names settings, so it is logged and never shown to users.
 */
export class MediaConfigError extends Error {}
