'use client';

import { LookupAutocomplete } from '@/components/ui/autocomplete/LookupAutocomplete';
import { CatalogCreateShortcut } from '@/components/admin/catalog-shortcuts';
import type { CardField } from '@/lib/customer-card';
import { has } from '@/lib/values';

const valueHref = (field: CardField) => `/admin/settings/dimensions/${field.dimensionId}/values/new?field=${encodeURIComponent(field.fieldName)}`;

/** One picker per default dimension: its values are searched on the server a page at a time, never loaded whole. */
export function DimensionFields({ fields, selected, onChange }: { fields: CardField[]; selected: Record<string, string>; onChange: (fieldName: string, code: string) => void }) {
  if (fields.length === 0) {
    return (
      <p className="text-xs text-fg-muted">
        No default or shortcut dimensions are configured. <CatalogCreateShortcut href="/admin/settings/dimensions/new">New</CatalogCreateShortcut>
      </p>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => {
        const code = selected[field.fieldName] ?? '';
        return (
          <div key={field.fieldName}>
            <LookupAutocomplete
              label={`${field.dimensionCode} (${field.kind})`}
              source="customer-dimension-values"
              filters={{ dimension: field.dimensionId }}
              value={has(code) ? code : null}
              valueLabel={has(code) ? code : null}
              placeholder="None"
              onChange={(option) => onChange(field.fieldName, option?.id ?? '')}
              createHref={valueHref(field)}
              createLabel="+ New value"
            />
          </div>
        );
      })}
    </div>
  );
}
