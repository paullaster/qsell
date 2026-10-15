'use client';

import type { CustomerProfileRow } from '@/server/db/drizzle/schema';

export const CUSTOMER_SHORTCUT_CREATED = 'qsell:customer-shortcut-created';

export interface CustomerShortcutField {
  fieldName: string;
  dimensionId: string;
  dimensionCode: string;
  kind: 'global' | 'shortcut';
  values: { code: string; name: string }[];
}

export type CustomerShortcutDetail =
  | { kind: 'profile'; profile: CustomerProfileRow }
  | {
      kind: 'dimensionValue';
      fieldName: string;
      value: { code: string; name: string };
    }
  | { kind: 'dimension'; field: CustomerShortcutField };

export function publishCustomerShortcut(detail: CustomerShortcutDetail) {
  window.dispatchEvent(
    new CustomEvent<CustomerShortcutDetail>(CUSTOMER_SHORTCUT_CREATED, { detail }),
  );
}
