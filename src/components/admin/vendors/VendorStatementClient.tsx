'use client';

import Link from 'next/link';
import { use } from 'react';
import type { statementAction } from '@/server/domains/vendors/payment-actions';
import { LoadFailed, PageHeader, buttonClass, cardClass } from '@/components/ui/screen-kit';

const TYPE_WORDS: Record<string, string> = { invoice: 'Invoice', payment: 'Payment', advance: 'Advance', credit_memo: 'Credit memo', refund: 'Refund' };

export function VendorStatementClient({ viewPromise }: { viewPromise: ReturnType<typeof statementAction> }) {
  const res = use(viewPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  const s = res.data;
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title={`Statement: ${s.vendor.name}`} intro={`Vendor ${s.vendor.number ?? '(no number yet)'} · we owe ${s.balance}`} actions={<Link href="/admin/vendors/payables" className={buttonClass}>What we owe</Link>} />
      {s.entries.length === 0 ? <p className="text-sm text-fg-muted">There is nothing on this vendor’s account yet.</p> : (
        <ul className="space-y-2" aria-label="Account entries">
          {s.entries.map((e) => (
            <li key={e.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-2`}>
              <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{TYPE_WORDS[e.documentType] ?? e.documentType} {e.documentNo}{e.externalNo === null ? '' : ` (their ${e.externalNo})`}</span><span className="block text-xs text-fg-muted">{e.postingDate}{e.dueDate === null ? '' : ` · due ${e.dueDate}`}</span></span>
              <span className="text-right text-sm"><span className="block font-semibold tabular-nums">{e.amount} {e.currency}</span><span className="block text-xs text-fg-muted">open {e.remaining}</span></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
