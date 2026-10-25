'use client';

import Link from 'next/link';
import { use, useId, useState } from 'react';
import { certificatesAction } from '@/server/domains/vendors/payment-terms-actions';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof certificatesAction>>, { ok: true }>['data'];

export function CertificatesClient({ initialPromise }: { initialPromise: ReturnType<typeof certificatesAction> }) {
  const res = use(initialPromise);
  return res.ok ? <ListView initial={res.data} /> : <LoadFailed error={res.error} />;
}

function ListView({ initial }: { initial: Page }) {
  const uid = useId();
  const [page, setPage] = useState(initial);
  const [period, setPeriod] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const load = async (p: string, before: Page['next'], append: boolean) => {
    setBusy(true);
    setNotice(null);
    const res = await attempt(certificatesAction({ period: p, before }));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setPage((cur) => ({ ...res.data, rows: append ? [...cur.rows, ...res.data.rows] : res.data.rows }));
  };
  return (
    <div className="max-w-4xl space-y-5">
      <PageHeader title="Withholding tax certificates" intro="Proof of the tax withheld from vendor payments, by month, for the tax return." actions={<Link href="/admin/vendors/payment-rules" className={buttonClass}>Payment rules</Link>} />
      <Message notice={notice} />
      <div className={`${cardClass} max-w-xs`}>
        <Field id={`${uid}-p`} label="Month" hint="Like 2026-10. Leave empty for all."><input id={`${uid}-p`} value={period} maxLength={7} onChange={(e) => { setPeriod(e.target.value); if (e.target.value === '' || /^\d{4}-\d{2}$/.test(e.target.value)) void load(e.target.value, null, false); }} className={fieldClass} autoComplete="off" placeholder="YYYY-MM" /></Field>
      </div>
      <p className="text-sm text-fg" aria-live="polite">Withheld{period === '' ? '' : ` in ${period}`}: <span className="font-semibold">{page.issuedTotal}</span>{busy ? ' · Loading…' : ''}</p>
      {page.rows.length === 0 ? <p className="text-sm text-fg-muted">No certificates here.</p> : (
        <ul className="space-y-2" aria-label="Certificates">
          {page.rows.map((r) => (
            <li key={r.id}>
              <Link href={`/admin/vendors/certificates/${r.id}`} className={`${cardClass} flex min-h-10 flex-wrap items-center justify-between gap-2 hover:bg-hover`}>
                <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{r.number} · {r.vendorName}</span><span className="block text-xs text-fg-muted">Paid {r.paidOn} · period {r.period} · {r.amount} {r.currency}</span></span>
                <Chip tone={r.status === 'issued' ? 'green' : 'gray'}>{r.status === 'issued' ? 'Issued' : 'Cancelled'}</Chip>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {page.next === null ? null : <button type="button" className={buttonClass} disabled={busy} onClick={() => void load(period, page.next, true)}>Show older certificates</button>}
    </div>
  );
}
