'use client';

import Link from 'next/link';
import { use, type ReactNode } from 'react';
import type { vendorDetailAction } from '@/server/domains/vendors/actions';
import { VENDOR_BLOCK, VENDOR_STATUS, VENDOR_TYPES } from '@/lib/vendor-forms';
import { VendorPeoplePanel } from './VendorPeoplePanel';
import { VendorStandingPanel } from './VendorStandingPanel';
import { Chip, LoadFailed, PageHeader, buttonClass, cardClass, money } from '@/components/ui/screen-kit';

type View = Extract<Awaited<ReturnType<typeof vendorDetailAction>>, { ok: true }>['data'];

export function VendorDetailClient({ viewPromise, reviewSlot, termsSlot }: { viewPromise: ReturnType<typeof vendorDetailAction>; reviewSlot: ReactNode; termsSlot: ReactNode }) {
  const res = use(viewPromise);
  return res.ok ? <VendorDetailView view={res.data} reviewSlot={reviewSlot} termsSlot={termsSlot} /> : <LoadFailed error={res.error} />;
}

const dash = (v: string | number | null): string => (v === null || v === '' ? '—' : String(v));

function VendorDetailView({ view, reviewSlot, termsSlot }: { view: View; reviewSlot: ReactNode; termsSlot: ReactNode }) {
  const v = view.vendor;
  const state = VENDOR_STATUS[v.status] ?? { label: v.status, tone: 'gray' as const };
  const type = VENDOR_TYPES.find((t) => t.id === v.vendorType)?.label ?? v.vendorType;
  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader
        title={v.legalName}
        intro={
          <span className="flex flex-wrap items-center gap-2">
            {v.number === null ? 'No vendor number yet' : `Vendor ${v.number}`} · {type}
            <Chip tone={state.tone}>{state.label}</Chip>
            {v.block === 'none' ? null : <Chip tone="red">{VENDOR_BLOCK[v.block] ?? v.block}</Chip>}
            {v.createdByStaff ? <Chip tone="gray">Added by staff</Chip> : null}
          </span>
        }
        actions={<Link href="/admin/vendors" className={buttonClass}>All vendors</Link>}
      />

      <section aria-label="Vendor details" className={`${cardClass} grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2`}>
        {([
          ['Trading name', dash(v.tradingName)],
          ['Tax ID', dash(v.taxId)],
          ['Email', v.email],
          ['Phone', dash(v.phone)],
          ['Country', dash(v.country)],
          ['Payment terms', `${String(v.paymentTermDays)} days`],
          ['Currency', dash(v.currency)],
          ['Posting group', dash(view.postingGroup)],
          ['Invoice without an order', v.approvedExpenseVendor ? 'Allowed (approved expense vendor)' : 'Not allowed'],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label}><dt className="text-xs text-fg-muted">{label}</dt><dd className="font-medium text-fg-strong">{value}</dd></div>
        ))}
        {v.notes === null ? null : <div className="sm:col-span-2"><dt className="text-xs text-fg-muted">Notes</dt><dd className="whitespace-pre-line">{v.notes}</dd></div>}
      </section>

      {reviewSlot}

      {view.canSeeLedger ? (
        <section aria-label="What we owe" className={cardClass}>
          <h3 className="text-sm font-bold text-fg-strong">What we owe this vendor</h3>
          {view.balances.length === 0 ? <p className="mt-1 text-sm text-fg-muted">Nothing is owed: no invoices have been posted for this vendor yet.</p> : (
            <ul className="mt-2 space-y-1 text-sm">{view.balances.map((b) => <li key={b.currency} className="tabular-nums"><span className="font-semibold">{b.currency} {money(b.owed)}</span></li>)}</ul>
          )}
        </section>
      ) : null}

      {termsSlot}

      <VendorStandingPanel vendorId={v.id} status={v.status} block={v.block} standing={view.standing} can={view.can} />

      <VendorPeoplePanel vendorId={v.id} people={view.portalUsers} canInvite={view.can.invite} archived={v.status === 'archived'} />

      <section aria-label="History" className={cardClass}>
        <h3 className="text-sm font-bold text-fg-strong">History</h3>
        <ol className="mt-2 space-y-2 text-xs">
          {view.events.map((e) => (
            <li key={e.id} className="border-t border-line pt-2 first:border-0 first:pt-0">
              <p className="font-semibold text-fg-strong">{e.event.replace(/_/g, ' ')}{e.toStatus !== null && e.fromStatus !== e.toStatus ? ` · ${e.fromStatus ?? 'new'} → ${e.toStatus}` : ''}</p>
              <p className="text-fg-muted">{new Date(e.at).toLocaleString()} · {e.actorType}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
