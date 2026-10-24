'use client';

import Link from 'next/link';
import { use } from 'react';
import type { reviewQueueAction } from '@/server/domains/vendors/admin-actions';
import { Chip, LoadFailed, PageHeader, cardClass } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof reviewQueueAction>>, { ok: true }>['data'];

export function ReviewQueueClient({ initialPromise }: { initialPromise: ReturnType<typeof reviewQueueAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ReviewQueueView page={res.data} /> : <LoadFailed error={res.error} />;
}

const state = (s: string) => (s === 'under_review' ? { tone: 'sky' as const, text: 'Being reviewed' } : { tone: 'amber' as const, text: 'Waiting for a reviewer' });

function ReviewQueueView({ page }: { page: Page }) {
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="Vendor review queue" intro="Vendors that sent their profile and are waiting for a decision, oldest first." actions={<Link href="/admin/vendors" className="text-sm font-semibold text-indigo-600 hover:underline">All vendors</Link>} />
      {page.rows.length === 0 ? <p className={`${cardClass} text-sm text-fg-muted`}>Nothing is waiting. New applications appear here when a vendor sends its profile.</p> : (
        <ul className="space-y-2" aria-label="Applications waiting">
          {page.rows.map((r) => {
            const s = state(r.status);
            return (
              <li key={r.id}>
                <Link href={`/admin/vendors/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                  <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.legalName}</span><span className="block text-xs text-fg-muted">{r.submittedAt === null ? 'Not sent' : `Sent ${new Date(r.submittedAt).toLocaleString()}`}</span></span>
                  <Chip tone={s.tone}>{s.text}</Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
