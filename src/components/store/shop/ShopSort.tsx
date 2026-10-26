'use client';

import { useCallback } from 'react';
import { Autocomplete } from '@/components/ui/autocomplete/Autocomplete';
import { STOREFRONT_SORTS, STOREFRONT_SORT_LABELS, type StorefrontSort } from '@/lib/storefront-search';

const OPTIONS = STOREFRONT_SORTS.map((sort) => ({ id: sort, label: STOREFRONT_SORT_LABELS[sort] }));

/** The order of the shop, picked from its four fixed choices with the same picker used everywhere else. */
export function ShopSort({ value, onChange }: { value: StorefrontSort; onChange: (sort: StorefrontSort) => void }) {
  const loadOptions = useCallback(
    ({ query }: { query: string }) =>
      Promise.resolve({
        options: OPTIONS.filter((option) => option.label.toLowerCase().includes(query.trim().toLowerCase())),
        nextCursor: null,
      }),
    [],
  );
  return (
    <Autocomplete
      label="Sort by"
      hideLabel
      value={value}
      valueLabel={STOREFRONT_SORT_LABELS[value]}
      onChange={(option) => {
        const next = STOREFRONT_SORTS.find((sort) => sort === option?.id);
        if (next !== undefined) onChange(next);
      }}
      loadOptions={loadOptions}
      clearable={false}
      placeholder="Sort by"
      className="w-full sm:w-56"
    />
  );
}
