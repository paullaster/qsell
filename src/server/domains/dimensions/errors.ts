import { SettingsError } from '@/server/domains/settings/errors';

/** A dimension rule that was not met; the message is safe to show. */
export class DimensionError extends SettingsError {}

export const dimensionNotFound = () => new DimensionError('That dimension does not exist.', 'NOT_FOUND');
