'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { use, useId, useState } from 'react';
import { type creditableInvoicesAction, startCreditAction } from '@/server/domains/vendors/credit-memo-portal-actions';
import { Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

export function CreditStartClient({ invoicesPromise }: { invoicesPromise: ReturnType<typeof creditableInvoicesAction> }) {
  const res = use(invoicesPromise);
  return res.ok ? <View invoices={res.data} /> : <LoadFailed error={res.error} />;
}

function View({ invoices }: { invoices: Extract<Awaited<ReturnType<typeof creditableInvoicesAction>>, { ok: true }>['data'] }) {
  const uid = useId();
  const router = useRouter();
  const [no, setNo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [problem, setProblem] = useState('');
  const start = async (invoiceId: string) => {
    setBusy(invoiceId);
    setNotice(null);
    setProblem('');
    const res = await attempt(startCreditAction(invoiceId, no));
    setBusy(null);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      setProblem('problems' in res ? (res.problems?.vendorCreditNo ?? '') : '');
      return;
    }
    router.push(`/vendor/credits/${res.data.id}`);
  };
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="New credit note" intro="Type the number printed on your credit note, then choose the invoice it corrects." actions={<Link href="/vendor/credits" className={buttonClass}>Cancel</Link>} />
      <Message notice={notice} />
      <div className={cardClass}>
        <Field id={`${uid}-no`} label="Your credit note number" hint={problem === '' ? 'As printed on your own credit note.' : problem}>
          <input id={`${uid}-no`} value={no} onChange={(e) => setNo(e.target.value)} maxLength={60} className={fieldClass} autoComplete="off" aria-invalid={problem !== ''} />
        </Field>
      </div>
      {invoices.length === 0 ? <p className="text-sm text-fg-muted">You have no booked invoice to credit yet.</p> : (
        <ul className="space-y-2" aria-label="Invoices you can credit">
          {invoices.map((i) => (
            <li key={i.id} className={`${cardClass} flex flex-wrap items-center justify-between gap-2`}>
              <span className="min-w-0"><span className="block text-sm font-bold text-fg-strong">{i.vendorInvoiceNo}</span><span className="block text-xs text-fg-muted">Our number {i.number} · {i.invoiceDate} · {i.total} {i.currency}</span></span>
              <button type="button" className={primaryClass} disabled={busy !== null || no.trim() === ''} onClick={() => void start(i.id)} aria-label={`Credit invoice ${i.vendorInvoiceNo}`}>{busy === i.id ? 'Starting…' : 'Credit this invoice'}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
