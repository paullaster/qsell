'use server';

import type { LookupResult } from '@/lib/lookup';
import { requirePermission } from '@/server/domains/access-control/guard';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { getContainer } from '@/server/di/container';
import { parseLookupRequest } from './request';
import { LookupFilterError } from './runner';
import { getLookupSource } from './sources';

/**
 * Searches one of the lists an Autocomplete offers. The request is untrusted: it is parsed and
 * capped, the source must be one the server defines, the caller must hold that source's
 * permission, and the search is always scoped to their company.
 */
export async function searchLookupAction(raw: unknown): Promise<LookupResult> {
  const parsed = parseLookupRequest(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { source: key, query, limit, after, filters } = parsed.value;
  const source = getLookupSource(key);
  if (source === undefined) return { ok: false, error: 'Unknown list.' };
  try {
    await requirePermission(source.permission);
    const companyId = (await getContainer().companySettings.ensureSeeded()).id;
    return { ok: true, data: await source.search({ companyId, query, limit, after, filters }) };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) {
      return { ok: false, error: 'You do not have permission to see this list.' };
    }
    if (error instanceof LookupFilterError) return { ok: false, error: error.message };
    console.error('[lookup]', key, error);
    return { ok: false, error: 'Could not load the list. Try again.' };
  }
}
