'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DiscountLookups } from '@/server/domains/pricing/discount-actions';
import { PageHeader } from '../approvals/shared';
import { RebateForm } from './RebateForm';

export function NewRebateClient({ lookups }: { lookups: DiscountLookups }) {
  const router = useRouter();
  return (
    <div className="space-y-5">
      <p className="text-xs">
        <Link
          href="/admin/pricing/rebates"
          className="inline-flex min-h-10 items-center text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
        >
          ← All rebates
        </Link>
      </p>
      <PageHeader title="New rebate programme">
        It is saved as a draft that counts nothing. Put it in force when the steps are right.
      </PageHeader>
      <RebateForm
        mode="create"
        lookups={lookups}
        names={{}}
        onCancel={() => router.push('/admin/pricing/rebates')}
        onSaved={(id) => router.push(`/admin/pricing/rebates/${id}`)}
      />
    </div>
  );
}
