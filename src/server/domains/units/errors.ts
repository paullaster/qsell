import { SettingsError } from '@/server/domains/settings/errors';

/** A unit-of-measure rule that was not met; the message is safe to show. */
export class UnitError extends SettingsError {}

export const unitNotFound = () =>
  new UnitError('That unit of measure does not exist.', 'NOT_FOUND');
export const unitChangedByOther = () =>
  new UnitError(
    'Someone else changed this unit while you were editing it. Reload the list and try again.',
    'CONFLICT',
  );
