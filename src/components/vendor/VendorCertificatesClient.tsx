'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { vendorCertificatesAction } from '@/server/domains/vendors/payment-portal-actions';
import { Chip, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof vendorCertificatesAction>>, { ok: true }>['data'];

export function VendorCertificatesClient({ initialPromise }: { initialPromise: ReturnType<typeof vendorCertificatesAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ListView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function ListView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const more = async () => {
    if (next === null) return;
    setBusy(true);
    const res = await attempt(vendorCertificatesAction(next));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows((r) => [...r, ...res.data.rows]);
    setNext(res.data.next);
  };
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Withholding tax certificates" intro="When we withhold tax from a payment to you, this is your proof for your own tax return." actions={<Link href="/vendor/payments" className={buttonClass}>Payments</Link>} />
      <Message notice={notice} />
      {rows.length === 0 ? <p className="text-sm text-fg-muted">No tax has been withheld from your payments.</p> : (
        <ul className="space-y-2" aria-label="Certificates">
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/vendor/certificates/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number}</span><span className="block text-xs text-fg-muted">Paid {r.paidOn} · {r.amount} {r.currency} withheld</span></span>
                <Chip tone={r.status === 'issued' ? 'green' : 'gray'}>{r.status === 'issued' ? 'Issued' : 'Cancelled'}</Chip>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void more()}>Show older certificates</button>}
    </div>
  );
}
