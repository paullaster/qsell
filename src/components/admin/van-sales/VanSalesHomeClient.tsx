'use client';

import Link from 'next/link';
import { use } from 'react';
import type { vanSalesOverviewAction } from '@/server/domains/van-sales/actions';
import { Chip, LoadFailed, PageHeader, buttonClass, cardClass, primaryClass } from '@/components/ui/screen-kit';
import { vanSalesOn } from '@/lib/van-sales/settings';

type Loaded = Awaited<ReturnType<typeof vanSalesOverviewAction>>;

export function VanSalesHomeClient({ firstPromise }: { firstPromise: ReturnType<typeof vanSalesOverviewAction> }) {
  const res: Loaded = use(firstPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  const { settings, vans, reps, routes, days, canSettings } = res.data;
  const on = vanSalesOn(settings);
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Van sales" intro="Sell from a loaded van, take orders on a route, or both. Set up your vans and your sales reps here." />
      {on ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Chip tone={settings.vanSell ? 'green' : 'gray'}>Van sell {settings.vanSell ? 'on' : 'off'}</Chip>
          <Chip tone={settings.preSell ? 'green' : 'gray'}>Pre-sell {settings.preSell ? 'on' : 'off'}</Chip>
          {canSettings ? <Link href="/admin/settings/sales/van-sales" className="text-indigo-600 underline">Change these</Link> : null}
        </p>
      ) : (
        <section role="status" className={`${cardClass} space-y-2`} data-testid="van-sales-off">
          <h2 className="text-base font-bold text-fg-strong">Van sales is switched off</h2>
          <p className="text-sm text-fg-muted">Neither van selling nor pre-selling is on for this company, so reps cannot sell yet. You can still set up vans and reps now.</p>
          {canSettings ? <Link href="/admin/settings/sales/van-sales" className={primaryClass}>Switch it on in Settings</Link> : <p className="text-sm text-fg-muted">Ask an administrator to switch it on in Settings › Sales › Van sales.</p>}
        </section>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <section className={`${cardClass} space-y-3`} aria-label="Van days">
          <h2 className="text-base font-bold text-fg-strong">Van days</h2>
          <p className="text-sm text-fg-muted">{days.open === 0 ? 'No day is open.' : `${String(days.open)} open`}{days.today > 0 ? `, ${String(days.today)} today` : ''}.</p>
          <Link href="/admin/van-sales/days" className={buttonClass}>Open van days</Link>
        </section>
        <section className={`${cardClass} space-y-3`} aria-label="Routes">
          <h2 className="text-base font-bold text-fg-strong">Routes</h2>
          <p className="text-sm text-fg-muted">{routes.active === 0 ? 'No route in use yet.' : `${String(routes.active)} in use`}{routes.stopped > 0 ? `, ${String(routes.stopped)} stopped` : ''}.</p>
          <Link href="/admin/van-sales/routes" className={buttonClass}>Open routes</Link>
        </section>
        <section className={`${cardClass} space-y-3`} aria-label="Vans">
          <h2 className="text-base font-bold text-fg-strong">Vans</h2>
          <p className="text-sm text-fg-muted">{vans.active === 0 ? 'No van in use yet.' : `${String(vans.active)} in use`}{vans.stopped > 0 ? `, ${String(vans.stopped)} stopped` : ''}.</p>
          <Link href="/admin/van-sales/vans" className={buttonClass}>Open vans</Link>
        </section>
        <section className={`${cardClass} space-y-3`} aria-label="Sales reps">
          <h2 className="text-base font-bold text-fg-strong">Sales reps</h2>
          <p className="text-sm text-fg-muted">{reps.active === 0 ? 'No rep selling yet.' : `${String(reps.active)} selling`}{reps.paused > 0 ? `, ${String(reps.paused)} paused` : ''}{reps.ended > 0 ? `, ${String(reps.ended)} ended` : ''}.</p>
          <Link href="/admin/van-sales/reps" className={buttonClass}>Open sales reps</Link>
        </section>
      </div>
    </div>
  );
}
