'use client';

import Link from 'next/link';
import { use } from 'react';
import type { portalOverviewAction } from '@/server/domains/vendors/portal-actions';
import { VENDOR_BLOCK, VENDOR_STATUS } from '@/lib/vendor-forms';
import { SECTIONS } from '@/lib/vendor-profile';
import { Chip, LoadFailed, PageHeader, buttonClass, cardClass } from '@/components/ui/screen-kit';

const TONE = { not_started: 'gray', draft: 'amber', complete: 'green' } as const;
const WORDS = { not_started: 'Not started', draft: 'In progress', complete: 'Complete' } as const;

const NEXT_STEP: Record<string, string> = {
  registered: 'Your account is created. Complete your business profile and send it for review.',
  profile_in_progress: 'Keep going: complete your business profile and send it for review.',
  profile_submitted: 'Your profile has been sent. We will review it soon.',
  under_review: 'Your profile is being reviewed.',
  revision_requested: 'We asked for changes to your profile. Open your profile to see what to fix.',
  active: 'Your business is active.',
  suspended: 'Your account is suspended. Contact the buyer for the reason and the way back.',
  rejected: 'Your application was not accepted. Contact the buyer if you believe this is a mistake.',
};

export function VendorDashboardClient({ overviewPromise }: { overviewPromise: ReturnType<typeof portalOverviewAction> }) {
  const res = use(overviewPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  const v = res.data;
  const state = VENDOR_STATUS[v.status] ?? { label: v.status, tone: 'gray' as const };
  return (
    <div className="space-y-5">
      <PageHeader
        title={v.legalName}
        intro={
          <span className="flex flex-wrap items-center gap-2">
            {v.number === null ? 'Vendor number given when approved' : `Vendor ${v.number}`}
            <Chip tone={state.tone}>{state.label}</Chip>
            {v.block === 'none' ? null : <Chip tone="red">{VENDOR_BLOCK[v.block] ?? v.block}</Chip>}
          </span>
        }
      />
      <p className="text-sm text-fg">{NEXT_STEP[v.status] ?? 'Your account is being reviewed.'}</p>
      <section aria-label="Your profile" className={cardClass}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-fg-strong">Your profile</h2>
          <Link href="/vendor/profile" className={buttonClass}>Open my profile</Link>
        </div>
        {v.sections === null ? null : (
          <ol className="mt-3 divide-y divide-line text-sm">
            {SECTIONS.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                <Link href={`/vendor/profile/${s.id}`} className="font-medium text-indigo-600 hover:underline">{s.label}</Link>
                <Chip tone={TONE[v.sections?.[s.id] ?? 'not_started']}>{WORDS[v.sections?.[s.id] ?? 'not_started']}</Chip>
              </li>
            ))}
          </ol>
        )}
      </section>
      {v.status === 'active' ? (
        <section aria-label="Prequalification" className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-fg-strong">Prequalification</h2>
            <Link href="/vendor/prequalification" className={buttonClass}>Open prequalification</Link>
          </div>
          <p className="mt-1 text-sm text-fg-muted">Apply to be qualified for the kinds of work you do, and follow your applications.</p>
        </section>
      ) : null}
      {v.status === 'active' ? (
        <section aria-label="Requests for quotation" className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-fg-strong">Requests for quotation</h2>
            <Link href="/vendor/rfqs" className={buttonClass}>Open my requests</Link>
          </div>
          <p className="mt-1 text-sm text-fg-muted">Requests you were invited to, your quotes, and the results.</p>
        </section>
      ) : null}
      {v.status === 'active' ? (
        <section aria-label="Purchase orders" className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-fg-strong">Purchase orders</h2>
            <Link href="/vendor/orders" className={buttonClass}>Open my orders</Link>
          </div>
          <p className="mt-1 text-sm text-fg-muted">Orders sent to you, to read and confirm.</p>
        </section>
      ) : null}
      {v.status === 'active' ? (
        <section aria-label="Invoices" className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-fg-strong">Invoices</h2>
            <Link href="/vendor/invoices" className={buttonClass}>Open my invoices</Link>
          </div>
          <p className="mt-1 text-sm text-fg-muted">Invoice us for what was delivered, and follow each invoice until it is paid.</p>
        </section>
      ) : null}
      {v.status === 'active' ? (
        <section aria-label="Credit notes" className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-fg-strong">Credit notes</h2>
            <Link href="/vendor/credits" className={buttonClass}>Open my credit notes</Link>
          </div>
          <p className="mt-1 text-sm text-fg-muted">If you billed too much on an invoice, send a credit note for it.</p>
        </section>
      ) : null}
      {v.status === 'active' ? (
        <section aria-label="Payments" className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-fg-strong">Payments</h2>
            <Link href="/vendor/payments" className={buttonClass}>Open my payments</Link>
          </div>
          <p className="mt-1 text-sm text-fg-muted">What we have paid you, with the invoices each payment covers.</p>
        </section>
      ) : null}
      {v.yourRole === 'owner' ? (
        <section aria-label="Your team" className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-fg-strong">Your team</h2>
            <Link href="/vendor/team" className={buttonClass}>Manage my team</Link>
          </div>
          <p className="mt-1 text-sm text-fg-muted">Invite colleagues in finance or sales and choose what each can do.</p>
        </section>
      ) : null}
      <p className="text-xs text-fg-muted">Signed in as {v.yourName} ({v.yourRole}).</p>
    </div>
  );
}
