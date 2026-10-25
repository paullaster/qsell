'use client';

import Link from 'next/link';
import { use } from 'react';
import { LoadFailed, PageHeader, buttonClass, cardClass } from '@/components/ui/screen-kit';

interface Certificate {
  id: string;
  number: string;
  status: 'issued' | 'cancelled';
  cancelReason: string | null;
  period: string;
  paidOn: string;
  codeName: string;
  ratePercent: string;
  baseAmount: string;
  amount: string;
  currency: string;
  issuedAt: string;
  withholdingAgent: { name: string; pin: string };
  vendor: { name: string; number: string | null; taxId: string | null };
}
type Result = { ok: true; data: Certificate } | { ok: false; error: string };

/** The certificate as it is shown and printed: who withheld, from whom, on what, how much. The same page for staff and for the vendor. */
export function CertificateDocument({ viewPromise, backHref }: { viewPromise: Promise<Result>; backHref: string }) {
  const res = use(viewPromise);
  if (!res.ok) return <LoadFailed error={res.error} />;
  const c = res.data;
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader title={`Withholding tax certificate ${c.number}`} intro={c.status === 'cancelled' ? `Cancelled: ${c.cancelReason ?? ''}` : `Issued ${new Date(c.issuedAt).toLocaleDateString()}`} actions={<><Link href={backHref} className={buttonClass}>Back</Link><button type="button" className={buttonClass} onClick={() => window.print()}>Print</button></>} />
      <section className={`${cardClass} space-y-3 print:border-0`} aria-label="Certificate">
        <p className="text-sm text-fg">This certifies that tax was withheld from a payment to the vendor named below.</p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-fg-muted">Withheld by</dt><dd className="font-medium text-fg-strong">{c.withholdingAgent.name}{c.withholdingAgent.pin === '' ? '' : ` (PIN ${c.withholdingAgent.pin})`}</dd></div>
          <div><dt className="text-xs text-fg-muted">Withheld from</dt><dd className="font-medium text-fg-strong">{c.vendor.name}{c.vendor.taxId === null || c.vendor.taxId === '' ? '' : ` (PIN ${c.vendor.taxId})`}</dd></div>
          <div><dt className="text-xs text-fg-muted">Kind of tax</dt><dd className="font-medium text-fg-strong">{c.codeName}</dd></div>
          <div><dt className="text-xs text-fg-muted">Rate</dt><dd className="font-medium text-fg-strong">{c.ratePercent}%</dd></div>
          <div><dt className="text-xs text-fg-muted">Paid on</dt><dd className="font-medium text-fg-strong">{c.paidOn} (period {c.period})</dd></div>
          <div><dt className="text-xs text-fg-muted">Amount the tax is taken on</dt><dd className="font-medium tabular-nums text-fg-strong">{c.baseAmount} {c.currency}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-fg-muted">Tax withheld</dt><dd className="text-lg font-bold tabular-nums text-fg-strong">{c.amount} {c.currency}</dd></div>
        </dl>
      </section>
    </div>
  );
}
