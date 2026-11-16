'use client';

import { use } from 'react';
import Link from 'next/link';
import { SignInPrompt } from '@/components/store/account/SignInPrompt';
import { LoadFailed } from '@/components/ui/screen-kit';
import type { myGroupsAction } from '@/server/domains/pricing/package-group-actions';
import type { MyGroup } from '@/server/domains/pricing/package-group-service';

const STATE: Record<MyGroup['state'], { label: string; tone: string }> = {
  open: { label: 'Taking choices', tone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  closed: { label: 'Closed', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  ordered: { label: 'Ordered', tone: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300' },
  cancelled: { label: 'Cancelled', tone: 'bg-red-500/15 text-red-700 dark:text-red-300' },
};

const people = (n: number): string => (n === 1 ? '1 person has chosen' : `${String(n)} people have chosen`);

/** The organiser's groups: what each is, where it stands, and a way back into the ones that can still be managed. */
export function MyGroupsClient({ groups }: { groups: ReturnType<typeof myGroupsAction> }) {
  const answer = use(groups);
  if (!answer.ok) {
    if ('signIn' in answer) return <SignInPrompt what="your group orders" />;
    return <LoadFailed error={answer.error} />;
  }
  if (answer.data.length === 0) {
    return (
      <p className="rounded-xl border border-line bg-surface-raised p-6 text-sm text-fg-muted" data-testid="groups-empty">
        You have not started a group order yet. Open a package in the shop and press <strong>Order for a group</strong>.
      </p>
    );
  }
  return (
    <ul className="space-y-3" aria-label="My group orders" data-testid="my-groups">
      {answer.data.map((g) => (
        <li key={g.id} className="space-y-2 rounded-xl border border-line bg-surface-raised p-4" data-testid="my-group">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold break-words text-fg-strong">{g.title === '' ? g.packageName : g.title}</p>
              <p className="text-sm break-words text-fg-muted">
                {g.title === '' ? '' : `${g.packageName} · `}
                {g.forDate === null ? 'No date' : `For ${g.forDate}`} · {people(g.people)}
              </p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATE[g.state].tone}`}>{STATE[g.state].label}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {g.orderId === null ? null : (
              <Link href={`/profile/orders/${g.orderId}`} className="font-semibold text-indigo-600 underline dark:text-indigo-300">
                Order {g.orderNumber ?? ''}
              </Link>
            )}
            {g.token === null ? (
              <span className="text-fg-muted">The link for this group was not kept.</span>
            ) : (
              <Link href={`/group/${g.token}`} className="inline-flex min-h-10 items-center rounded-lg border border-line-strong px-3 font-semibold text-fg-strong hover:bg-hover">
                Open this group
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
