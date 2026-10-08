'use client';

import Link from 'next/link';
import type { RebateDto } from '@/server/domains/pricing/retrospective-actions';
import { Chip, EmptyState, PageHeader, cardClass, primaryButtonClass } from '../approvals/shared';
import { money } from './DiscountsClient';

export function rebateChip(r: Pick<RebateDto, 'status' | 'validTo'>) {
  if (r.status === 'active') {
    if (r.validTo && new Date(r.validTo) < new Date()) return <Chip tone="grey">Ended</Chip>;
    return <Chip tone="green">In force</Chip>;
  }
  if (r.status === 'paused') return <Chip tone="amber">Paused</Chip>;
  if (r.status === 'retired') return <Chip tone="grey">Retired</Chip>;
  return <Chip tone="sky">Draft</Chip>;
}

export function RebatesClient({
  programs,
  canManage,
}: {
  programs: RebateDto[];
  canManage: boolean;
}) {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Rebates"
        actions={
          canManage ? (
            <Link href="/admin/pricing/rebates/new" className={primaryButtonClass}>
              New rebate programme
            </Link>
          ) : null
        }
      >
        Money given back after the fact: 2% of what a distributor buys in a quarter once they pass
        5,000,000. The sale is not discounted. Each order adds to the customer&apos;s running total,
        and when the period has ended the total decides the rate. Paying a rebate is a credit to the
        customer&apos;s account and goes through approval.
      </PageHeader>
      {programs.length === 0 ? (
        <EmptyState title="No rebate programmes yet">
          Make one for the customers or products you reward, put it in force, and orders start
          counting at once.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {programs.map((p) => (
            <li key={p.id} className={cardClass}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    href={`/admin/pricing/rebates/${p.id}`}
                    className="inline-flex min-h-10 items-center font-semibold text-indigo-700 hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
                  >
                    {p.name}
                  </Link>{' '}
                  <span className="text-xs text-fg-muted">{p.code}</span> {rebateChip(p)}
                  <p className="mt-1 text-sm text-fg">{p.summary}</p>
                </div>
                <p className="text-right text-xs text-fg-muted">
                  {p.current.label}
                  <br />
                  {p.current.customers.toLocaleString()} customer
                  {p.current.customers === 1 ? '' : 's'} counted, {money(p.current.basis)} bought
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
