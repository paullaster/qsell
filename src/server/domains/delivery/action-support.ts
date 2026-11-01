import { runSetting, SettingsError, type SettingsContext, type SettingsResult } from '@/server/domains/settings/action-runner';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { DeliveryError } from './errors';

/** The settings runner, with the delivery rules' own refusals shown in their words and carrying their code. */
export async function runDelivery<T>(permission: PermissionKey, fn: (ctx: SettingsContext) => Promise<T>, paths: string[] = []): Promise<SettingsResult<T>> {
  return await runSetting(
    permission,
    async (ctx) => {
      try {
        return await fn(ctx);
      } catch (error) {
        if (error instanceof DeliveryError) throw new SettingsError(error.message, error.code);
        throw error;
      }
    },
    { paths },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id from the browser: it is only ever looked up for this company, but a malformed one is refused early. */
export function idOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new DeliveryError(`That ${what} could not be found.`, 'NOT_FOUND');
  return value;
}

export const objectOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

export function versionOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new DeliveryError('Reload the page and try again.', 'BAD_INPUT');
  return value;
}
