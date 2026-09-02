'use client';

import { useRouter } from 'next/navigation';
import { AdminTaxes } from '@/components/admin/AdminTaxes';
import type { TaxCategory } from '@/types/index';

export function AdminTaxesClient({ taxesPromise }: { taxesPromise: Promise<TaxCategory[]> }) {
  const router = useRouter();
  return <AdminTaxes taxesPromise={taxesPromise} onRefreshAll={() => router.refresh()} />;
}
