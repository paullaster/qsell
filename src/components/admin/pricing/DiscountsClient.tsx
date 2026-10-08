'use client';

import Link from 'next/link';
import type { DiscountRuleDto } from '@/server/domains/pricing/discount-actions';
import {
  Chip,
  EmptyState,
  PageHeader,
  When,
  cardClass,
  primaryButtonClass,
} from '../approvals/shared';
import { DiscountSimulator } from './DiscountSimulator';

export const money = (n: number) =>
  n.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function discountChip(r: Pick<DiscountRuleDto, 'status' | 'approvalStatus' | 'validTo'>) {
  if (r.approvalStatus === 'pending') return <Chip tone="amber">Waiting for approval</Chip>;
  if (r.status === 'active') {
    if (r.validTo && new Date(r.validTo) < new Date()) return <Chip tone="grey">Ended</Chip>;
    return <Chip tone="green">In force</Chip>;
  }
  if (r.status === 'paused') return <Chip tone="amber">Paused</Chip>;
  if (r.status === 'retired') return <Chip tone="grey">Retired</Chip>;
  return <Chip tone="sky">Draft</Chip>;
}

export function DiscountsClient({
  rules,
  canManage,
}: {
  rules: DiscountRuleDto[];
  canManage: boolean;
}) {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Discounts"
        actions={
          canManage ? (
            <Link href="/admin/pricing/discounts/new" className={primaryButtonClass}>
              New discount
            </Link>
          ) : null
        }
      >
        Reductions applied after the price list has set the price: a percentage or amount off a
        line, a threshold off the whole order, a coupon code. Rules that apply alone compete and the
        best wins; rules marked stackable combine. Nothing is ever taken below a product&apos;s
        price floor.
      </PageHeader>

      {rules.length === 0 ? (
        <EmptyState title="No discounts yet">
          Start with a simple one, such as 10% off a brand for a month, then try it below before it
          goes in force.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {rules.map((r) => (
            <li key={r.id} className={cardClass}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-fg-strong">
                    <Link
                      href={`/admin/pricing/discounts/${r.id}`}
                      className="inline-flex min-h-10 items-center hover:underline focus-visible:outline-2 focus-visible:outline-indigo-500"
                    >
                      {r.name}
                    </Link>{' '}
                    <span className="text-xs font-normal text-fg-muted">
                      {r.code} · {r.kind === 'line' ? 'line' : 'order'}
                      {r.requiresCoupon ? ' · coupon' : ''}
                    </span>
                  </p>
                  <p className="text-sm text-fg">{r.summary}</p>
                </div>
                <div className="text-right text-xs text-fg-muted">
                  <div className="mb-1">{discountChip(r)}</div>
                  <div>
                    Used {r.uses.toLocaleString()} time{r.uses === 1 ? '' : 's'}
                    {r.given > 0 ? ` · ${money(r.given)} given` : ''}
                    {r.limits.budget != null ? ` of ${money(r.limits.budget)}` : ''}
                  </div>
                  <div>
                    Changed <When iso={r.updatedAt} />
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <DiscountSimulator />
    </div>
  );
}
