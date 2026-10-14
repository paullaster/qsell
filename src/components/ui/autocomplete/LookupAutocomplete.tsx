'use client';

import { useCallback } from 'react';
import { searchLookupAction } from '@/server/domains/lookups/actions';
import { Autocomplete, type AutocompleteProps } from './Autocomplete';

export interface LookupAutocompleteProps extends Omit<AutocompleteProps, 'loadOptions'> {
  /** A list the server offers (see `lookups/sources.ts`). */
  source: string;
  /** Narrows the list, such as `{ status: 'active' }`; the server checks each one. */
  filters?: Record<string, string>;
}

/**
 * An Autocomplete over one of the server's lists. The search itself runs on the server, behind
 * that list's permission: the browser only names the list and sends the text.
 */
export function LookupAutocomplete({ source, filters, ...props }: LookupAutocompleteProps) {
  const filterKey = JSON.stringify(filters ?? {});
  const loadOptions = useCallback(
    async ({ query, cursor, limit }: { query: string; cursor: string | null; limit: number }) => {
      const result = await searchLookupAction({
        source,
        query,
        cursor,
        limit,
        filters: JSON.parse(filterKey) as Record<string, string>,
      });
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
    [source, filterKey],
  );
  return <Autocomplete {...props} loadOptions={loadOptions} />;
}
