'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DiscountLookups } from '@/server/domains/pricing/discount-actions';
import { PageHeader } from '../approvals/shared';
import { DiscountForm } from './DiscountForm';

export function NewDiscountClient({ lookups }: { lookups: DiscountLookups }) {
  const router = useRouter();
  return (
    <div className="space-y-5">
      <p className="text-xs">
        <Link
          href="/admin/pricing/discounts"
          className="inline-flex min-h-10 items-center text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          ← All discounts
        </Link>
      </p>
      <PageHeader title="New discount">
        It is saved as a draft that reduces nothing. Try it on a sale, then put it in force.
      </PageHeader>
      <DiscountForm
        mode="create"
        lookups={lookups}
        productNames={{}}
        onCancel={() => router.push('/admin/pricing/discounts')}
        onSaved={(id) => router.push(`/admin/pricing/discounts/${id}`)}
      />
    </div>
  );
}
