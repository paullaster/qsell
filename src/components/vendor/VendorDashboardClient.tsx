'use client';

import { use } from 'react';
import type { portalOverviewAction } from '@/server/domains/vendors/portal-actions';
import { VENDOR_BLOCK, VENDOR_STATUS } from '@/lib/vendor-forms';
import { Chip, LoadFailed, PageHeader, cardClass } from '@/components/ui/screen-kit';

const SECTIONS = ['Vendor profile', 'Business information', 'Financial information', 'Contact persons', 'Attachments'] as const;

const NEXT_STEP: Record<string, string> = {
  registered: 'Your account is created. Completing your business profile comes next; it opens in the next release of the portal.',
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
        <h2 className="text-sm font-bold text-fg-strong">Your profile</h2>
        <p className="mt-1 text-xs text-fg-muted">Five sections make up your business profile. You will fill them in once the profile opens.</p>
        <ol className="mt-3 divide-y divide-line text-sm">
          {SECTIONS.map((name) => (
            <li key={name} className="flex items-center justify-between gap-2 py-2">
              <span className="font-medium text-fg-strong">{name}</span>
              <Chip tone="gray">Not started</Chip>
            </li>
          ))}
        </ol>
      </section>
      <p className="text-xs text-fg-muted">Signed in as {v.yourName} ({v.yourRole}).</p>
    </div>
  );
}
