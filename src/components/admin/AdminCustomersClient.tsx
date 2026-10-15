'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { Plus, Users } from 'lucide-react';
import type { CustomerLedgerEntryRow, CustomerRow } from '@/server/db/drizzle/schema';
import {
  type customerFieldsAction,
  customerLedgerAction,
  customersPageAction,
  deleteCustomerAction,
  profileLabelAction,
  profilesPageAction,
  receivePaymentAction,
  saveCustomerAction,
} from '@/server/domains/customers/manage-actions';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { usePagedList } from '@/components/ui/usePagedList';
import { useDebouncedValue } from '@/components/ui/useDebouncedValue';
import { attempt, buttonClass, Field, fieldClass, LoadFailed, Message, primaryClass, type Notice } from '@/components/ui/screen-kit';
import { accountTypeOf, blockOf, labelOfAccountType, labelOfBlock } from '@/lib/customer-forms';
import { cardFrom, emptyCard, money, profileChoice, selectedToProjection, withAccountType, withProfile, type CardField, type CardForm } from '@/lib/customer-card';
import { CUSTOMER_SHORTCUT_CREATED, type CustomerShortcutDetail } from '@/components/admin/customer-shortcuts';
import { has } from '@/lib/values';
import { DimensionFields } from './customers/DimensionFields';
import { ProfilesPanel } from './customers/ProfilesPanel';

type FirstPage = Extract<Awaited<ReturnType<typeof customersPageAction>>, { ok: true }>;

interface Props {
  fieldsPromise: ReturnType<typeof customerFieldsAction>;
  firstPage: ReturnType<typeof customersPageAction>;
}

export function AdminCustomersClient({ fieldsPromise, firstPage }: Props) {
  const fields = use(fieldsPromise);
  const first = use(firstPage);
  if (!fields.ok) return <LoadFailed error={fields.error} />;
  if (!first.ok) return <LoadFailed error={first.error} />;
  return <Customers initialFields={fields.data} first={first} />;
}

const numberOrZero = (text: string): number => (text.trim() === '' ? 0 : Number(text));

function Customers({ initialFields, first }: { initialFields: CardField[]; first: FirstPage }) {
  const [tab, setTab] = useState<'customers' | 'profiles'>('customers');
  const [fields, setFields] = useState(initialFields);
  const [form, setForm] = useState<CardForm | null>(null);
  const [selected, setSelected] = useState<CustomerRow | null>(null);
  const [ledger, setLedger] = useState<CustomerLedgerEntryRow[]>([]);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [newProfile, setNewProfile] = useState(0);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const query = useDebouncedValue(search.trim());

  const list = usePagedList<CustomerRow, { query: string }>({
    load: (filters, cursor) => customersPageAction({ query: filters.query, cursor }),
    filters: { query },
    initialPage: first,
  });

  // A profile, dimension or dimension value made in a window over this screen comes back as a choice here.
  useEffect(() => {
    const onCreated = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as CustomerShortcutDetail | undefined;
      if (detail === undefined) return;
      if (detail.kind === 'profile') {
        const p = detail.profile;
        setForm((f) =>
          withProfile(f ?? emptyCard(fields), profileChoice(p), fields),
        );
        setTab('customers');
        return;
      }
      if (detail.kind === 'dimension') {
        const { values: _values, ...field } = detail.field;
        setFields((prev) => (prev.some((x) => x.fieldName === field.fieldName) ? prev : [...prev, field]));
        return;
      }
      setForm((f) => ({ ...(f ?? emptyCard(fields)), dimensions: { ...(f ?? emptyCard(fields)).dimensions, [detail.fieldName]: detail.value.code } }));
      setTab('customers');
    };
    window.addEventListener(CUSTOMER_SHORTCUT_CREATED, onCreated);
    return () => window.removeEventListener(CUSTOMER_SHORTCUT_CREATED, onCreated);
  }, [fields]);

  const set = <K extends keyof CardForm>(key: K, value: CardForm[K]) => setForm((f) => (f === null ? f : { ...f, [key]: value }));

  const openNewCustomer = async () => {
    setSelected(null);
    setLedger([]);
    setNotice(null);
    setForm(emptyCard(fields));
    // New customers start from the CASH profile when there is one.
    const found = await attempt(profilesPageAction({ query: 'CASH' }));
    const cash = found.ok ? found.data.rows.find((p) => p.code === 'CASH') : undefined;
    if (cash !== undefined) {
      setForm((f) => (f === null ? f : withProfile(f, profileChoice(cash), fields)));
    }
  };

  const openCustomer = async (row: CustomerRow) => {
    setSelected(row);
    setNotice(null);
    setForm(cardFrom(row, '', fields));
    const [res, label] = await Promise.all([attempt(customerLedgerAction(row.id)), has(row.profileId) ? attempt(profileLabelAction(row.profileId)) : Promise.resolve(null)]);
    setLedger(res.ok ? res.data : []);
    if (label?.ok === true) setForm((f) => (f === null ? f : { ...f, profileLabel: label.data }));
  };

  const save = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (form === null) return;
    const cash = form.accountType === 'cash';
    const orNull = (text: string) => (text.trim() === '' ? null : text.trim());
    setBusy(true);
    setNotice(null);
    const res = await attempt(
      saveCustomerAction({
        id: selected?.id,
        profileId: orNull(form.profileId),
        name: form.name,
        email: orNull(form.email),
        phone: orNull(form.phone),
        street: orNull(form.street),
        city: orNull(form.city),
        countyOrState: orNull(form.countyOrState),
        postalCode: orNull(form.postalCode),
        country: orNull(form.country),
        accountType: form.accountType,
        creditLimit: cash ? 0 : numberOrZero(form.creditLimit),
        paymentTermDays: cash ? 0 : numberOrZero(form.paymentTermDays),
        blocked: form.blocked,
        transmitInvoicesToKra: form.transmitInvoicesToKra,
        buyerKraPin: orNull(form.buyerKraPin),
        notes: orNull(form.notes),
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
    setSelected(null);
    setForm(null);
    list.reload();
  };

  const remove = useCallback(
    async (row: CustomerRow) => {
      setBusy(true);
      setNotice(null);
      const res = await attempt(deleteCustomerAction(row.id));
      setBusy(false);
      if (!res.ok) {
        setNotice({ kind: 'error', text: res.error });
        return;
      }
      setNotice({ kind: 'ok', text: `${row.name} deleted.` });
      if (selected?.id === row.id) {
        setSelected(null);
        setForm(null);
        setLedger([]);
      }
      list.reload();
    },
    [list, selected],
  );

  const receive = async () => {
    if (selected === null) return;
    setBusy(true);
    setNotice(null);
    const res = await attempt(receivePaymentAction(selected.id, Number(paymentAmount), paymentReference));
    setBusy(false);
    if (!res.ok) {
      setNotice({ kind: 'error', text: res.error });
      return;
    }
    setSelected(res.data);
    const fresh = await attempt(customerLedgerAction(res.data.id));
    setLedger(fresh.ok ? fresh.data : []);
    setPaymentAmount('');
    setPaymentReference('');
    setNotice({ kind: 'ok', text: 'Payment posted.' });
    list.reload();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-fg-strong">
            <Users className="h-5 w-5 text-indigo-600" aria-hidden="true" />
            <h2 className="text-xl font-semibold">Customers</h2>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Every customer is cash or credit from the start. Profiles copy payment terms, credit limit, default dimensions, and whether invoices are marked for KRA. Cash sales do not create a receivable. Credit sales post an open invoice up to the credit limit.
          </p>
        </div>
        <button type="button" onClick={tab === 'customers' ? () => void openNewCustomer() : () => setNewProfile((n) => n + 1)} className={`${primaryClass} gap-1.5`}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {tab === 'customers' ? 'New customer' : 'New profile'}
        </button>
      </div>

      <div role="tablist" aria-label="Customers and profiles" className="flex gap-2 border-b border-line">
        {(['customers', 'profiles'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              setNotice(null);
            }}
            className={`min-h-10 border-b-2 px-3 py-2 text-sm capitalize ${tab === key ? 'border-indigo-500 text-fg-strong' : 'border-transparent text-fg-muted'}`}
          >
            {key}
          </button>
        ))}
      </div>

      {tab === 'profiles' ? <ProfilesPanel fields={fields} openNew={newProfile} /> : null}

      {tab === 'customers' ? (
        <div className="space-y-4">
          <Message notice={notice} />
          {form === null ? null : (
            <form onSubmit={(e) => void save(e)} noValidate aria-label={selected === null ? 'New customer card' : 'Customer card'} className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <ChoicePicker
                    label="Profile"
                    source="customer-profiles"
                    choice={has(form.profileId) ? { id: form.profileId, label: form.profileLabel } : null}
                    onChoice={(c) => setForm((f) => (f === null ? f : withProfile(f, c, fields)))}
                    placeholder="No profile"
                    createHref="/admin/customer-profiles/new"
                    createLabel="+ New profile"
                  />
                </div>
                <Field id="card-name" label="Name">
                  <input id="card-name" className={fieldClass} value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="off" />
                </Field>
                <Field id="card-email" label="Email">
                  <input id="card-email" className={fieldClass} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} autoComplete="off" />
                </Field>
                <Field id="card-phone" label="Phone">
                  <input id="card-phone" className={fieldClass} type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="off" />
                </Field>
                <div className="sm:col-span-2">
                  <Field id="card-street" label="Street">
                    <input id="card-street" className={fieldClass} value={form.street} onChange={(e) => set('street', e.target.value)} autoComplete="off" />
                  </Field>
                </div>
                <Field id="card-city" label="City">
                  <input id="card-city" className={fieldClass} value={form.city} onChange={(e) => set('city', e.target.value)} autoComplete="off" />
                </Field>
                <Field id="card-county" label="County / region">
                  <input id="card-county" className={fieldClass} value={form.countyOrState} onChange={(e) => set('countyOrState', e.target.value)} autoComplete="off" />
                </Field>
                <Field id="card-postal" label="Postal code">
                  <input id="card-postal" className={fieldClass} value={form.postalCode} onChange={(e) => set('postalCode', e.target.value)} autoComplete="off" />
                </Field>
                <Field id="card-country" label="Country">
                  <input id="card-country" className={fieldClass} value={form.country} onChange={(e) => set('country', e.target.value)} autoComplete="off" />
                </Field>
                <ChoicePicker label="Account type" source="customer-account-types" choice={{ id: form.accountType, label: labelOfAccountType(form.accountType) }} onChoice={(c) => setForm((f) => (f === null ? f : withAccountType(f, accountTypeOf(c?.id))))} clearable={false} />
                <Field id="card-limit" label="Credit limit">
                  <input id="card-limit" className={fieldClass} type="number" min={0} inputMode="decimal" disabled={form.accountType === 'cash'} value={form.accountType === 'cash' ? '0' : form.creditLimit} onChange={(e) => set('creditLimit', e.target.value)} />
                </Field>
                <Field id="card-terms" label="Payment terms (days)">
                  <input id="card-terms" className={fieldClass} type="number" min={0} inputMode="numeric" disabled={form.accountType === 'cash'} value={form.accountType === 'cash' ? '0' : form.paymentTermDays} onChange={(e) => set('paymentTermDays', e.target.value)} />
                </Field>
                <ChoicePicker label="Blocked" source="customer-blocks" choice={{ id: form.blocked, label: labelOfBlock(form.blocked) }} onChoice={(c) => set('blocked', blockOf(c?.id))} clearable={false} />
                <Field id="card-pin" label="Tax PIN">
                  <input id="card-pin" className={`${fieldClass} font-mono`} value={form.buyerKraPin} onChange={(e) => set('buyerKraPin', e.target.value)} placeholder="e.g. P051234567X" autoComplete="off" />
                </Field>
                <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg sm:col-span-2">
                  <input type="checkbox" className="h-5 w-5" checked={form.transmitInvoicesToKra} onChange={(e) => set('transmitInvoicesToKra', e.target.checked)} />
                  Transmit this customer&apos;s invoices to KRA
                </label>
              </div>
              {form.accountType === 'credit' && Number(form.creditLimit) <= 0 ? <p className="text-xs text-amber-700">Credit limit is 0, so this customer cannot be invoiced until you set a limit.</p> : null}
              <DimensionFields fields={fields} selected={form.dimensions} onChange={(name, code) => setForm((f) => (f === null ? f : { ...f, dimensions: { ...f.dimensions, [name]: code } }))} />
              <div className="flex flex-wrap items-center gap-2">
                <button type="submit" disabled={busy} className={primaryClass}>
                  {busy ? 'Saving…' : 'Save customer'}
                </button>
                {selected === null ? null : <InlineConfirm label={`Delete ${selected.name}`} action="Delete" confirm="Delete for good" busy={busy} onConfirm={() => void remove(selected)} />}
                <button type="button" className={buttonClass} onClick={() => setForm(null)}>
                  Close
                </button>
              </div>
              {selected !== null && Number(selected.balance) > 0 ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
                  <Field id="pay-amount" label={`Receive payment against open balance ${money(selected.balance)}`}>
                    <input id="pay-amount" className={`${fieldClass} w-40`} type="number" min={0} inputMode="decimal" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} />
                  </Field>
                  <Field id="pay-reference" label="Transaction reference">
                    <input id="pay-reference" className={`${fieldClass} w-48`} value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder="Receipt or bank reference" autoComplete="off" />
                  </Field>
                  <button type="button" disabled={busy} onClick={() => void receive()} className={buttonClass}>
                    Post payment
                  </button>
                </div>
              ) : null}
              {ledger.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs text-fg">
                    <caption className="sr-only">Open items</caption>
                    <thead className="text-fg-muted">
                      <tr>
                        <th scope="col" className="py-1">Document</th>
                        <th scope="col">Type</th>
                        <th scope="col">Amount</th>
                        <th scope="col">Remaining</th>
                        <th scope="col">KRA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.map((entry) => (
                        <tr key={entry.id} className="border-t border-line">
                          <td className="py-1">{entry.documentNo}</td>
                          <td>{has(entry.description) ? entry.description : entry.documentType}</td>
                          <td>{money(entry.amount)}</td>
                          <td>{money(entry.remainingAmount)}</td>
                          <td>{entry.kraTransmissionStatus}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </form>
          )}

          <Field id="customer-search" label="Search customers">
            <input id="customer-search" type="search" className={`${fieldClass} sm:max-w-xs`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, number, email, phone or tax PIN" autoComplete="off" />
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
          {list.phase === 'idle' && list.rows.length === 0 ? <p className="text-sm text-fg-muted md:hidden">{query === '' ? 'No customers yet.' : `No customers match “${query}”.`}</p> : null}
          <ul aria-label="Customers" className="space-y-2 md:hidden">
            {list.rows.map((row) => (
              <li key={row.id} className="space-y-2 rounded-xl border border-line bg-surface-raised p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold break-words text-fg-strong">{row.name}</p>
                    <p className="font-mono text-xs text-fg-muted">{row.number}</p>
                  </div>
                  <span className="shrink-0 text-xs text-fg capitalize">{row.accountType}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-fg">
                  <div><dt className="text-fg-muted">Balance</dt><dd>{money(row.balance)}</dd></div>
                  <div><dt className="text-fg-muted">Limit</dt><dd>{money(row.creditLimit)}</dd></div>
                  <div><dt className="text-fg-muted">KRA</dt><dd>{row.transmitInvoicesToKra ? 'Transmit' : 'Skip'}</dd></div>
                  <div><dt className="text-fg-muted">Blocked</dt><dd className="capitalize">{row.blocked}</dd></div>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={buttonClass} aria-label={`Open ${row.name}`} onClick={() => void openCustomer(row)}>Open</button>
                  <InlineConfirm label={`Delete ${row.name}`} action="Delete" confirm="Delete for good" busy={busy} onConfirm={() => void remove(row)} />
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border border-line md:block">
            <table className="w-full text-left text-sm text-fg">
              <caption className="sr-only">Customers</caption>
              <thead className="bg-surface-raised text-xs text-fg-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">Number</th>
                  <th scope="col">Name</th>
                  <th scope="col">Tax PIN</th>
                  <th scope="col">Type</th>
                  <th scope="col">Balance</th>
                  <th scope="col">Limit</th>
                  <th scope="col">KRA</th>
                  <th scope="col">Blocked</th>
                  <th scope="col" className="px-3 py-2 text-right"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {list.phase === 'idle' && list.rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-fg-muted">
                      {query === '' ? 'No customers yet. A checkout with a new email creates a cash customer here, including the name, phone, address, and tax PIN entered at checkout.' : `No customers match “${query}”.`}
                    </td>
                  </tr>
                ) : null}
                {list.rows.map((row) => (
                  <tr key={row.id} className="border-t border-line">
                    <td className="px-3 py-2 font-mono text-xs">{row.number}</td>
                    <td>{row.name}</td>
                    <td className="font-mono text-xs">{has(row.buyerKraPin) ? row.buyerKraPin : '—'}</td>
                    <td className="capitalize">{row.accountType}</td>
                    <td>{money(row.balance)}</td>
                    <td>{money(row.creditLimit)}</td>
                    <td>{row.transmitInvoicesToKra ? 'Transmit' : 'Skip'}</td>
                    <td className="capitalize">{row.blocked}</td>
                    <td className="px-3 py-1 text-right">
                      <span className="inline-flex flex-wrap justify-end gap-2">
                        <button type="button" className={buttonClass} aria-label={`Open ${row.name}`} onClick={() => void openCustomer(row)}>
                          Open
                        </button>
                        <InlineConfirm label={`Delete ${row.name}`} action="Delete" confirm="Delete for good" busy={busy} onConfirm={() => void remove(row)} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.cursor === null ? null : (
            <button type="button" className={buttonClass} onClick={list.loadMore} disabled={list.phase === 'more'}>
              {list.phase === 'more' ? 'Loading…' : 'Show more customers'}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
