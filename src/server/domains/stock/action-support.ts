import { runSetting, SettingsError, type SettingsContext, type SettingsResult } from '@/server/domains/settings/action-runner';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { StockError } from './errors';

/**
 * The settings runner, with the stock rules' own refusals shown in their words and carrying their code (so a screen can tell
 * "not found" from "not allowed now").
 */
export async function runStock<T>(permission: PermissionKey, fn: (ctx: SettingsContext) => Promise<T>, paths: string[] = []): Promise<SettingsResult<T>> {
  return await runSetting(
    permission,
    async (ctx) => {
      try {
        return await fn(ctx);
      } catch (error) {
        if (error instanceof StockError) throw new SettingsError(error.message, error.code);
        throw error;
      }
    },
    { paths },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id from the browser: it is only ever looked up for this company, but a malformed one is refused early. */
export function idOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new StockError(`That ${what} could not be found.`, 'NOT_FOUND');
  return value;
}

export const objectOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
