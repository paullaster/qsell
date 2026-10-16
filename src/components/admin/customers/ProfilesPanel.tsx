'use client';

import { useCallback, useState } from 'react';
import { profilesPageAction, saveProfileAction } from '@/server/domains/customers/manage-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { usePagedList } from '@/components/ui/usePagedList';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { attempt, buttonClass, Field, fieldClass, Message, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { accountTypeOf, labelOfAccountType } from '@/lib/customer-forms';
import { emptyProfileCard, profileCardFrom, selectedToProjection, withAccountType, type CardField, type ProfileCard } from '@/lib/customer-card';
import type { CustomerProfileRow } from '@/server/db/drizzle/schema';
import { DimensionFields } from './DimensionFields';

const numberOrZero = (text: string): number => (text.trim() === '' ? 0 : Number(text));

/** The profiles tab: a searchable, paged list and the form for one profile. */
export function ProfilesPanel({ fields, openNew }: { fields: CardField[]; openNew: number }) {
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search.trim());
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileCard | null>(null);
  const [lastNew, setLastNew] = useState(openNew);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const list = usePagedList<CustomerProfileRow, { query: string }>({
    load: (filters, cursor) => profilesPageAction({ query: filters.query, cursor }),
    filters: { query },
  });

  // "New profile" is pressed in the page header; each press opens an empty form.
  if (openNew !== lastNew) {
    setLastNew(openNew);
    setEditing(null);
    setForm(emptyProfileCard(fields));
  }

  const open = useCallback(
    (row: CustomerProfileRow) => {
      setEditing(row.id);
      setForm(profileCardFrom(row, fields));
      setNotice(null);
    },
    [fields],
  );

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (form === null) return;
    const cash = form.accountType === 'cash';
    setBusy(true);
    setNotice(null);
    const res = await attempt(
      saveProfileAction({
        id: editing ?? undefined,
        code: form.code,
        name: form.name,
        description: form.description.trim() === '' ? null : form.description.trim(),
        accountType: form.accountType,
        creditLimit: cash ? 0 : numberOrZero(form.creditLimit),
        paymentTermDays: cash ? 0 : numberOrZero(form.paymentTermDays),
        transmitInvoicesToKra: form.transmitInvoicesToKra,
        isActive: form.isActive,
        dimensionCodes: selectedToProjection(form.dimensions, fields),
      }),
    );
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setNotice({ kind: 'ok', text: `${res.data.name} saved.` });
    setForm(null);
    setEditing(null);
    list.reload();
  };

  const set = <K extends keyof ProfileCard>(key: K, value: ProfileCard[K]) => setForm((f) => (f === null ? f : { ...f, [key]: value }));

  return (
    <div className="space-y-4">
      <Message notice={notice} />
      {form === null ? null : (
        <form onSubmit={(e) => void save(e)} aria-label={editing === null ? 'New profile' : 'Edit profile'} noValidate className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="profile-code" label="Code">
              <input id="profile-code" className={fieldClass} value={form.code} onChange={(e) => set('code', e.target.value)} autoComplete="off" />
            </Field>
            <Field id="profile-name" label="Name">
              <input id="profile-name" className={fieldClass} value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="off" />
            </Field>
            <div className="sm:col-span-2">
              <Field id="profile-description" label="Description">
                <input id="profile-description" className={fieldClass} value={form.description} onChange={(e) => set('description', e.target.value)} autoComplete="off" />
              </Field>
            </div>
            <ChoicePicker label="Account type" source="customer-account-types" choice={{ id: form.accountType, label: labelOfAccountType(form.accountType) }} onChoice={(c) => setForm((f) => (f === null ? f : withAccountType(f, accountTypeOf(c?.id))))} clearable={false} />
            <Field id="profile-limit" label="Credit limit">
              <input id="profile-limit" className={fieldClass} type="number" min={0} inputMode="decimal" disabled={form.accountType === 'cash'} value={form.accountType === 'cash' ? '0' : form.creditLimit} onChange={(e) => set('creditLimit', e.target.value)} />
            </Field>
            <Field id="profile-terms" label="Payment terms (days)">
              <input id="profile-terms" className={fieldClass} type="number" min={0} inputMode="numeric" disabled={form.accountType === 'cash'} value={form.accountType === 'cash' ? '0' : form.paymentTermDays} onChange={(e) => set('paymentTermDays', e.target.value)} />
            </Field>
            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
              <input type="checkbox" className="h-5 w-5" checked={form.transmitInvoicesToKra} onChange={(e) => set('transmitInvoicesToKra', e.target.checked)} />
              Mark invoices for KRA
            </label>
          </div>
          <DimensionFields fields={fields} selected={form.dimensions} onChange={(name, code) => setForm((f) => (f === null ? f : { ...f, dimensions: { ...f.dimensions, [name]: code } }))} />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>
              {busy ? 'Saving…' : 'Save profile'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setForm(null)}>
              Close
            </button>
          </div>
        </form>
      )}

      <Field id="profile-search" label="Search profiles">
        <input id="profile-search" type="search" className={`${fieldClass} sm:max-w-xs`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code or name" autoComplete="off" />
      </Field>
      {list.phase === 'error' ? (
        <p role="alert" className="text-sm text-red-700">
          {list.error}{' '}
          <button type="button" className={buttonClass} onClick={list.retry}>
            Try again
          </button>
        </p>
      ) : null}
      {list.phase === 'loading' ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading…
        </p>
      ) : null}
      {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-muted md:hidden">{query === '' ? 'No profiles yet.' : `No profiles match “${query}”.`}</p> : null}
      <ul aria-label="Customer profiles" className="space-y-2 md:hidden">
        {list.rows.map((row) => (
          <li key={row.id} className="space-y-2 rounded-xl border border-line bg-surface-raised p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold break-words text-fg-strong">{row.name}</p>
                <p className="font-mono text-xs text-fg-muted">{row.code}</p>
              </div>
              <span className="shrink-0 text-xs text-fg capitalize">{row.accountType}</span>
            </div>
            <p className="text-xs text-fg">
              {row.accountType === 'cash' ? 'Due on invoice' : `${String(row.paymentTermDays)} days`} · KRA {row.transmitInvoicesToKra ? 'transmit' : 'skip'}
            </p>
            <button type="button" className={buttonClass} aria-label={`Open profile ${row.code}`} onClick={() => open(row)}>
              Open
            </button>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
        <table className="w-full text-left text-sm text-fg">
          <caption className="sr-only">Customer profiles</caption>
          <thead className="bg-surface-raised text-xs text-fg-muted">
            <tr>
              <th scope="col" className="px-3 py-2">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Terms</th>
              <th scope="col">KRA</th>
              <th scope="col" className="px-3 py-2 text-right"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody>
            {list.phase === 'idle' && list.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-fg-muted">
                  {query === '' ? 'No profiles yet. Create one when you want a reusable cash or credit setup.' : `No profiles match “${query}”.`}
                </td>
              </tr>
            ) : null}
            {list.rows.map((row) => (
              <tr key={row.id} className="border-t border-line">
                <td className="px-3 py-2 font-mono text-xs">{row.code}</td>
                <td>{row.name}</td>
                <td className="capitalize">{row.accountType}</td>
                <td>{row.accountType === 'cash' ? 'Due on invoice' : `${String(row.paymentTermDays)} days`}</td>
                <td>{row.transmitInvoicesToKra ? 'Transmit' : 'Skip'}</td>
                <td className="px-3 py-1 text-right">
                  <button type="button" className={buttonClass} aria-label={`Open profile ${row.code}`} onClick={() => open(row)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.cursor === null ? null : (
        <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
          {list.phase === 'more' ? 'Loading…' : 'Show more profiles'}
        </button>
      )}
    </div>
  );
}
