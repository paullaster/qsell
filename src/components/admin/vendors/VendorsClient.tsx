'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { listVendorsAction } from '@/server/domains/vendors/actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { VENDOR_STATUS, VENDOR_BLOCK } from '@/lib/vendor-forms';
import type { Choice } from '@/lib/payment-options';
import { Chip, Field, LoadFailed, Message, PageHeader, attempt, buttonClass, cardClass, fieldClass, primaryClass, type Notice } from '@/components/ui/screen-kit';

type Page = Extract<Awaited<ReturnType<typeof listVendorsAction>>, { ok: true }>['data'];
type Row = Page['rows'][number];

export function VendorsClient({ initialPromise }: { initialPromise: ReturnType<typeof listVendorsAction> }) {
  const res = use(initialPromise);
  return res.ok ? <VendorsView initial={res.data} /> : <LoadFailed error={res.error} />;
}

const statusOf = (s: string) => VENDOR_STATUS[s] ?? { label: s, tone: 'gray' as const };

function Chips({ row }: { row: Row }) {
  const state = statusOf(row.status);
  return (
    <>
      <Chip tone={state.tone}>{state.label}</Chip>
      {row.block === 'none' ? null : <Chip tone="red">{VENDOR_BLOCK[row.block] ?? row.block}</Chip>}
    </>
  );
}

function VendorsView({ initial }: { initial: Page }) {
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [next, setNext] = useState(initial.next);
  const [status, setStatus] = useState<Choice | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const query = (before?: NonNullable<Page['next']>) => attempt(listVendorsAction({ q, status: status?.id, before: before ?? null }));
  const apply = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    const res = await query();
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows(res.data.rows);
    setNext(res.data.next);
  };
  const more = async () => {
    if (next === null) return;
    setBusy(true);
    const res = await query(next);
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setRows((r) => [...r, ...res.data.rows]);
    setNext(res.data.next);
  };

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Vendors"
        intro="The businesses you buy from. A vendor registers itself in the vendor portal and is reviewed before it becomes active; you can also add one yourself."
        actions={initial.can.create ? <Link href="/admin/vendors/new" className={primaryClass}>Add a vendor</Link> : null}
      />
      <form onSubmit={(e) => void apply(e)} className={`${cardClass} grid grid-cols-1 gap-3 sm:grid-cols-3`} aria-label="Filter vendors">
        <Field id="vendors-q" label="Search" hint="Name, vendor number, email or tax ID.">
          <input id="vendors-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} className={fieldClass} autoComplete="off" />
        </Field>
        <ChoicePicker label="Status" source="vendor-statuses" choice={status} onChoice={setStatus} placeholder="All" />
        <div className="flex items-end"><button type="submit" className={buttonClass} disabled={busy}>Apply filter</button></div>
      </form>
      <Message notice={notice} />

      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No vendors match.</p>
      ) : (
        <>
          <ul className="space-y-2 md:hidden" aria-label="Vendors">
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/vendors/${r.id}`} className={`${cardClass} block min-h-10 hover:bg-hover`}>
                  <p className="text-sm font-bold text-fg-strong">{r.legalName}</p>
                  <p className="mt-0.5 text-xs text-fg-muted">{r.number ?? 'No number yet'} · {r.email}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><Chips row={r} /></div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Vendors, newest first</caption>
              <thead className="text-fg-muted">
                <tr><th scope="col" className="py-2 pr-3">Vendor</th><th scope="col" className="pr-3">Number</th><th scope="col" className="pr-3">Email</th><th scope="col" className="pr-3">Phone</th><th scope="col">Status</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-line">
                    <td className="py-2 pr-3 font-semibold"><Link href={`/admin/vendors/${r.id}`} className="text-indigo-600 hover:underline">{r.legalName}</Link></td>
                    <td className="pr-3">{r.number ?? '—'}</td>
                    <td className="pr-3">{r.email}</td>
                    <td className="pr-3">{r.phone ?? '—'}</td>
                    <td><span className="flex flex-wrap gap-1"><Chips row={r} /></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {next !== null ? <button type="button" className={buttonClass} onClick={() => void more()} disabled={busy}>Show older vendors</button> : null}
    </div>
  );
}
