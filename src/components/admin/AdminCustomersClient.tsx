'use client';

import React, { use, useEffect, useMemo, useState, useTransition } from 'react';
import { Plus, Users } from 'lucide-react';
import type {
  CustomerLedgerEntryRow,
  CustomerProfileRow,
  CustomerRow,
  DimensionCodesProjection,
} from '@/server/db/drizzle/schema';
import {
  deleteTradeCustomerAction,
  getTradeCustomerAction,
  receiveCustomerPaymentAction,
  saveCustomerProfileAction,
  saveTradeCustomerAction,
} from '@/server/domains/customers/master-actions';
import { accountTypeOf, blockOf } from '@/lib/customer-forms';
import { CatalogCreateShortcut, mergeById } from '@/components/admin/catalog-shortcuts';
import {
  CUSTOMER_SHORTCUT_CREATED,
  type CustomerShortcutDetail,
} from '@/components/admin/customer-shortcuts';

const fieldClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';

interface SetupField {
  fieldName: string;
  dimensionId: string;
  dimensionCode: string;
  kind: 'global' | 'shortcut';
  values: { code: string; name: string }[];
}

interface Setup {
  customers: CustomerRow[];
  profiles: CustomerProfileRow[];
  fields: SetupField[];
}


function money(value: string | number | null | undefined): string {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n)
    ? n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';
}

function fieldNumber(fieldName: string): string | null {
  const match = /^(?:global|shortcut)Dimension(\d+)Code$/.exec(fieldName);
  return match?.[1] ?? null;
}

function projectionToSelected(
  codes: DimensionCodesProjection | null | undefined,
  fields: SetupField[],
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const field of fields) {
    const n = fieldNumber(field.fieldName);
    if (!n) continue;
    selected[field.fieldName] =
      field.kind === 'global' ? (codes?.global?.[n] ?? '') : (codes?.shortcut?.[n] ?? '');
  }
  return selected;
}

function selectedToProjection(
  selected: Record<string, string>,
  fields: SetupField[],
): DimensionCodesProjection {
  const global: Record<string, string> = {};
  const shortcut: Record<string, string> = {};
  for (const field of fields) {
    const code = selected[field.fieldName];
    const n = fieldNumber(field.fieldName);
    if (!code || !n) continue;
    if (field.kind === 'global') global[n] = code;
    else shortcut[n] = code;
  }
  return { global, shortcut };
}

function dimensionValueHref(field: SetupField) {
  return `/admin/settings/dimensions/${field.dimensionId}/values/new?field=${encodeURIComponent(field.fieldName)}`;
}

function DimensionFields({
  fields,
  selected,
  onChange,
}: {
  fields: SetupField[];
  selected: Record<string, string>;
  onChange: (fieldName: string, code: string) => void;
}) {
  if (fields.length === 0) {
    return (
      <p className="text-xs text-fg-subtle">
        No default or shortcut dimensions are configured.{' '}
        <CatalogCreateShortcut href="/admin/settings/dimensions/new">New</CatalogCreateShortcut>
      </p>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => (
        <div key={field.fieldName}>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs text-fg-muted">
            <span>
              {field.dimensionCode}
              <span className="ml-1 text-fg-faint">{field.kind}</span>
            </span>
            {field.values.length > 0 ? (
              <CatalogCreateShortcut href={dimensionValueHref(field)}>New</CatalogCreateShortcut>
            ) : null}
          </div>
          <select
            className={fieldClass}
            value={selected[field.fieldName] ?? ''}
            onChange={(event) => onChange(field.fieldName, event.target.value)}
            disabled={field.values.length === 0}
          >
            <option value="">None</option>
            {field.values.map((value) => (
              <option key={value.code} value={value.code}>
                {value.code} — {value.name}
              </option>
            ))}
          </select>
          {field.values.length === 0 ? (
            <p className="mt-1 text-[11px] text-amber-700">
              No values yet.{' '}
              <CatalogCreateShortcut href={dimensionValueHref(field)}>New</CatalogCreateShortcut>
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function AdminCustomersClient({ setupPromise }: { setupPromise: Promise<Setup> }) {
  const setup = use(setupPromise);
  const [tab, setTab] = useState<'customers' | 'profiles'>('customers');
  const [customers, setCustomers] = useState(setup.customers);
  const [profiles, setProfiles] = useState(setup.profiles);
  const [fields, setFields] = useState(setup.fields);
  const [editingCustomerId, setEditingCustomerId] = useState<string | null>(null);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ledger, setLedger] = useState<CustomerLedgerEntryRow[]>([]);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [pending, startTransition] = useTransition();

  const emptyCustomer = useMemo(
    () => ({
      profileId: '',
      name: '',
      email: '',
      phone: '',
      street: '',
      city: '',
      countyOrState: '',
      postalCode: '',
      country: '',
      accountType: accountTypeOf('cash'),
      creditLimit: '0',
      paymentTermDays: '0',
      blocked: blockOf('none'),
      transmitInvoicesToKra: true,
      buyerKraPin: '',
      notes: '',
      isActive: true,
      dimensions: projectionToSelected(undefined, fields),
    }),
    [fields],
  );
  const [customerForm, setCustomerForm] = useState(emptyCustomer);

  const emptyProfile = useMemo(
    () => ({
      code: '',
      name: '',
      description: '',
      accountType: accountTypeOf('cash'),
      creditLimit: '0',
      paymentTermDays: '0',
      transmitInvoicesToKra: true,
      isActive: true,
      dimensions: projectionToSelected(undefined, fields),
    }),
    [fields],
  );
  const [profileForm, setProfileForm] = useState(emptyProfile);

  useEffect(() => {
    const onCreated = (event: Event) => {
      const detail = (event as CustomEvent<CustomerShortcutDetail>).detail;
      if (!detail) return;
      if (detail.kind === 'profile') {
        const profile = detail.profile;
        const cash = profile.accountType === 'cash';
        const hasDimensions =
          Object.keys(profile.dimensionCodes?.global ?? {}).length +
            Object.keys(profile.dimensionCodes?.shortcut ?? {}).length >
          0;
        setProfiles((prev) => mergeById(prev, [profile]));
        setCustomerForm((current) => ({
          ...current,
          profileId: profile.id,
          accountType: cash ? 'cash' : 'credit',
          creditLimit: cash ? '0' : String(profile.creditLimit),
          paymentTermDays: cash ? '0' : String(profile.paymentTermDays),
          transmitInvoicesToKra: profile.transmitInvoicesToKra,
          dimensions: hasDimensions
            ? projectionToSelected(profile.dimensionCodes, fields)
            : current.dimensions,
        }));
        setShowCustomerForm(true);
        setTab('customers');
        return;
      }
      if (detail.kind === 'dimension') {
        setFields((prev) =>
          prev.some((field) => field.fieldName === detail.field.fieldName)
            ? prev
            : [...prev, detail.field],
        );
        if (tab !== 'profiles') {
          setShowCustomerForm(true);
          setTab('customers');
        }
        return;
      }
      if (!detail.fieldName) return;
      setFields((prev) =>
        prev.map((field) =>
          field.fieldName === detail.fieldName
            ? {
                ...field,
                values: field.values.some((value) => value.code === detail.value.code)
                  ? field.values
                  : [...field.values, detail.value].sort((a, b) => a.code.localeCompare(b.code)),
              }
            : field,
        ),
      );
      if (tab === 'profiles') {
        setProfileForm((current) => ({
          ...current,
          dimensions: { ...current.dimensions, [detail.fieldName]: detail.value.code },
        }));
        return;
      }
      setCustomerForm((current) => ({
        ...current,
        dimensions: { ...current.dimensions, [detail.fieldName]: detail.value.code },
      }));
      setShowCustomerForm(true);
      setTab('customers');
    };
    window.addEventListener(CUSTOMER_SHORTCUT_CREATED, onCreated);
    return () => window.removeEventListener(CUSTOMER_SHORTCUT_CREATED, onCreated);
  }, [fields, tab]);

  const applyProfile = (profileId: string) => {
    const profile = profiles.find((row) => row.id === profileId);
    setCustomerForm((current) => {
      if (!profile) return { ...current, profileId };
      const cash = profile.accountType === 'cash';
      return {
        ...current,
        profileId,
        accountType: cash ? 'cash' : 'credit',
        creditLimit: cash ? '0' : String(profile.creditLimit),
        paymentTermDays: cash ? '0' : String(profile.paymentTermDays),
        transmitInvoicesToKra: profile.transmitInvoicesToKra,
        dimensions: projectionToSelected(profile.dimensionCodes, fields),
      };
    });
  };

  const openNewCustomer = () => {
    setEditingCustomerId(null);
    setLedger([]);
    setCustomerForm(emptyCustomer);
    setShowCustomerForm(true);
    setError(null);
    const cash = profiles.find((row) => row.code === 'CASH');
    if (cash) applyProfile(cash.id);
  };

  const openCustomer = (row: CustomerRow) => {
    setEditingCustomerId(row.id);
    setShowCustomerForm(true);
    setError(null);
    setCustomerForm({
      profileId: row.profileId ?? '',
      name: row.name,
      email: row.email ?? '',
      phone: row.phone ?? '',
      street: row.street ?? '',
      city: row.city ?? '',
      countyOrState: row.countyOrState ?? '',
      postalCode: row.postalCode ?? '',
      country: row.country ?? '',
      accountType: accountTypeOf(row.accountType),
      creditLimit: String(row.creditLimit),
      paymentTermDays: String(row.paymentTermDays),
      blocked: blockOf(row.blocked),
      transmitInvoicesToKra: row.transmitInvoicesToKra,
      buyerKraPin: row.buyerKraPin ?? '',
      notes: row.notes ?? '',
      isActive: row.isActive,
      dimensions: projectionToSelected(row.dimensionCodes, fields),
    });
    startTransition(async () => {
      const detail = await getTradeCustomerAction(row.id);
      setLedger(detail?.ledger ?? []);
    });
  };

  const saveCustomer = () => {
    startTransition(async () => {
      try {
        setError(null);
        const cash = customerForm.accountType === 'cash';
        const saved = await saveTradeCustomerAction({
          id: editingCustomerId ?? undefined,
          profileId: customerForm.profileId || null,
          name: customerForm.name,
          email: customerForm.email || null,
          phone: customerForm.phone || null,
          street: customerForm.street || null,
          city: customerForm.city || null,
          countyOrState: customerForm.countyOrState || null,
          postalCode: customerForm.postalCode || null,
          country: customerForm.country || null,
          accountType: customerForm.accountType,
          creditLimit: cash ? 0 : Number(customerForm.creditLimit),
          paymentTermDays: cash ? 0 : Number(customerForm.paymentTermDays),
          blocked: customerForm.blocked,
          transmitInvoicesToKra: customerForm.transmitInvoicesToKra,
          buyerKraPin: customerForm.buyerKraPin || null,
          notes: customerForm.notes || null,
          isActive: customerForm.isActive,
          dimensionCodes: selectedToProjection(customerForm.dimensions, fields),
        });
        setCustomers((prev) => {
          const next = prev.some((row) => row.id === saved.id)
            ? prev.map((row) => (row.id === saved.id ? saved : row))
            : [saved, ...prev];
          return next;
        });
        setEditingCustomerId(saved.id);
        setShowCustomerForm(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save customer');
      }
    });
  };

  const receivePayment = () => {
    if (!editingCustomerId) return;
    startTransition(async () => {
      try {
        setError(null);
        const updated = await receiveCustomerPaymentAction(
          editingCustomerId,
          Number(paymentAmount),
          paymentReference,
        );
        setCustomers((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
        const detail = await getTradeCustomerAction(updated.id);
        setLedger(detail?.ledger ?? []);
        setPaymentAmount('');
        setPaymentReference('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to post payment');
      }
    });
  };

  const deleteCustomer = (row: CustomerRow) => {
    const open =
      Number(row.balance) > 0 ? ` Open balance ${money(row.balance)} will be removed.` : '';
    if (
      !window.confirm(
        `Delete ${row.name} (${row.number})?${open} Past orders stay, but they will no longer point at this card.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      try {
        setError(null);
        await deleteTradeCustomerAction(row.id);
        setCustomers((prev) => prev.filter((item) => item.id !== row.id));
        if (editingCustomerId === row.id) {
          setEditingCustomerId(null);
          setShowCustomerForm(false);
          setLedger([]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete customer');
      }
    });
  };

  const openNewProfile = () => {
    setEditingProfileId(null);
    setProfileForm(emptyProfile);
    setShowProfileForm(true);
    setError(null);
  };

  const openProfile = (row: CustomerProfileRow) => {
    setEditingProfileId(row.id);
    setShowProfileForm(true);
    setError(null);
    setProfileForm({
      code: row.code,
      name: row.name,
      description: row.description ?? '',
      accountType: accountTypeOf(row.accountType),
      creditLimit: String(row.creditLimit),
      paymentTermDays: String(row.paymentTermDays),
      transmitInvoicesToKra: row.transmitInvoicesToKra,
      isActive: row.isActive,
      dimensions: projectionToSelected(row.dimensionCodes, fields),
    });
  };

  const saveProfile = () => {
    startTransition(async () => {
      try {
        setError(null);
        const cash = profileForm.accountType === 'cash';
        const saved = await saveCustomerProfileAction({
          id: editingProfileId ?? undefined,
          code: profileForm.code,
          name: profileForm.name,
          description: profileForm.description || null,
          accountType: profileForm.accountType,
          creditLimit: cash ? 0 : Number(profileForm.creditLimit),
          paymentTermDays: cash ? 0 : Number(profileForm.paymentTermDays),
          transmitInvoicesToKra: profileForm.transmitInvoicesToKra,
          isActive: profileForm.isActive,
          dimensionCodes: selectedToProjection(profileForm.dimensions, fields),
        });
        setProfiles((prev) => {
          const next = prev.some((row) => row.id === saved.id)
            ? prev.map((row) => (row.id === saved.id ? saved : row))
            : [...prev, saved].sort((a, b) => a.code.localeCompare(b.code));
          return next;
        });
        setShowProfileForm(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save profile');
      }
    });
  };

  const selectedCustomer = customers.find((row) => row.id === editingCustomerId) ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-fg-strong">
            <Users className="h-5 w-5 text-indigo-400" />
            <h1 className="text-xl font-semibold">Customers</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-fg-muted">
            Every customer is cash or credit from the start. Profiles copy payment terms, credit
            limit, default dimensions, and whether invoices are marked for KRA. Cash sales do not
            create a receivable. Credit sales post an open invoice up to the credit limit.
          </p>
        </div>
        <button
          type="button"
          onClick={tab === 'customers' ? openNewCustomer : openNewProfile}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" />
          {tab === 'customers' ? 'New customer' : 'New profile'}
        </button>
      </div>

      <div className="flex gap-2 border-b border-line">
        {(['customers', 'profiles'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setTab(key);
              setError(null);
            }}
            className={`border-b-2 px-3 py-2 text-sm capitalize ${
              tab === key ? 'border-indigo-500 text-fg-strong' : 'border-transparent text-fg-subtle'
            }`}
          >
            {key}
          </button>
        ))}
      </div>

      {error ? (
        <p className="rounded-lg border border-red-500/40 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      {tab === 'customers' ? (
        <div className="space-y-4">
          {showCustomerForm ? (
            <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs text-fg-muted">
                    <span>Profile</span>
                    {profiles.length > 0 ? (
                      <CatalogCreateShortcut href="/admin/customer-profiles/new">
                        New
                      </CatalogCreateShortcut>
                    ) : null}
                  </div>
                  <select
                    className={fieldClass}
                    value={customerForm.profileId}
                    onChange={(event) => applyProfile(event.target.value)}
                    disabled={profiles.length === 0}
                  >
                    <option value="">No profile</option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.code} — {profile.name}
                      </option>
                    ))}
                  </select>
                  {profiles.length === 0 ? (
                    <p className="mt-1 text-[11px] text-amber-700">
                      No profile yet.{' '}
                      <CatalogCreateShortcut href="/admin/customer-profiles/new">
                        New
                      </CatalogCreateShortcut>
                    </p>
                  ) : null}
                </div>
                <label className="block text-xs text-fg-muted">
                  Name
                  <input
                    className={`${fieldClass} mt-1`}
                    value={customerForm.name}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  Email
                  <input
                    className={`${fieldClass} mt-1`}
                    value={customerForm.email}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, email: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  Phone
                  <input
                    className={`${fieldClass} mt-1`}
                    value={customerForm.phone}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, phone: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted sm:col-span-2">
                  Street
                  <input
                    className={`${fieldClass} mt-1`}
                    value={customerForm.street}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, street: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  City
                  <input
                    className={`${fieldClass} mt-1`}
                    value={customerForm.city}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, city: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  County / region
                  <input
                    className={`${fieldClass} mt-1`}
                    value={customerForm.countyOrState}
                    onChange={(e) =>
                      setCustomerForm((f) => ({ ...f, countyOrState: e.target.value }))
                    }
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  Postal code
                  <input
                    className={`${fieldClass} mt-1`}
                    value={customerForm.postalCode}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, postalCode: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  Country
                  <input
                    className={`${fieldClass} mt-1`}
                    value={customerForm.country}
                    onChange={(e) => setCustomerForm((f) => ({ ...f, country: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  Account type
                  <select
                    className={`${fieldClass} mt-1`}
                    value={customerForm.accountType}
                    onChange={(e) => {
                      const accountType = accountTypeOf(e.target.value);
                      setCustomerForm((f) => ({
                        ...f,
                        accountType,
                        creditLimit: accountType === 'cash' ? '0' : f.creditLimit,
                        paymentTermDays: accountType === 'cash' ? '0' : f.paymentTermDays,
                      }));
                    }}
                  >
                    <option value="cash">Cash</option>
                    <option value="credit">Credit</option>
                  </select>
                </label>
                <label className="block text-xs text-fg-muted">
                  Credit limit
                  <input
                    className={`${fieldClass} mt-1`}
                    type="number"
                    min={0}
                    disabled={customerForm.accountType === 'cash'}
                    value={customerForm.accountType === 'cash' ? '0' : customerForm.creditLimit}
                    onChange={(e) =>
                      setCustomerForm((f) => ({ ...f, creditLimit: e.target.value }))
                    }
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  Payment terms (days)
                  <input
                    className={`${fieldClass} mt-1`}
                    type="number"
                    min={0}
                    disabled={customerForm.accountType === 'cash'}
                    value={customerForm.accountType === 'cash' ? '0' : customerForm.paymentTermDays}
                    onChange={(e) =>
                      setCustomerForm((f) => ({ ...f, paymentTermDays: e.target.value }))
                    }
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  Blocked
                  <select
                    className={`${fieldClass} mt-1`}
                    value={customerForm.blocked}
                    onChange={(e) =>
                      setCustomerForm((f) => ({ ...f, blocked: blockOf(e.target.value) }))
                    }
                  >
                    <option value="none">None</option>
                    <option value="ship">Ship</option>
                    <option value="invoice">Invoice</option>
                    <option value="all">All</option>
                  </select>
                </label>
                <label className="block text-xs text-fg-muted">
                  Tax PIN
                  <input
                    className={`${fieldClass} mt-1`}
                    value={customerForm.buyerKraPin}
                    onChange={(e) =>
                      setCustomerForm((f) => ({ ...f, buyerKraPin: e.target.value }))
                    }
                    placeholder="e.g. P051234567X"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-fg sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={customerForm.transmitInvoicesToKra}
                    onChange={(e) =>
                      setCustomerForm((f) => ({ ...f, transmitInvoicesToKra: e.target.checked }))
                    }
                  />
                  Transmit this customer&apos;s invoices to KRA
                </label>
              </div>
              {customerForm.accountType === 'credit' && Number(customerForm.creditLimit) <= 0 ? (
                <p className="text-xs text-amber-700">
                  Credit limit is 0, so this customer cannot be invoiced until you set a limit.
                </p>
              ) : null}
              <DimensionFields
                fields={fields}
                selected={customerForm.dimensions}
                onChange={(fieldName, code) =>
                  setCustomerForm((f) => ({
                    ...f,
                    dimensions: { ...f.dimensions, [fieldName]: code },
                  }))
                }
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={saveCustomer}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  Save customer
                </button>
                {editingCustomerId ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      const row = customers.find((item) => item.id === editingCustomerId);
                      if (row) deleteCustomer(row);
                    }}
                    className="rounded-lg border border-red-800 px-3 py-2 text-sm text-red-700 disabled:opacity-50"
                  >
                    Delete
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setShowCustomerForm(false)}
                  className="rounded-lg border border-line-strong px-3 py-2 text-sm text-fg"
                >
                  Close
                </button>
              </div>
              {selectedCustomer && Number(selectedCustomer.balance) > 0 ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
                  <label className="text-xs text-fg-muted">
                    Receive payment against open balance {money(selectedCustomer.balance)}
                    <input
                      className={`${fieldClass} mt-1 w-40`}
                      type="number"
                      min={0}
                      value={paymentAmount}
                      onChange={(e) => setPaymentAmount(e.target.value)}
                    />
                  </label>
                  <label className="text-xs text-fg-muted">
                    Transaction reference
                    <input
                      className={`${fieldClass} mt-1 w-48`}
                      value={paymentReference}
                      onChange={(e) => setPaymentReference(e.target.value)}
                      placeholder="Receipt or bank reference"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={receivePayment}
                    className="rounded-lg border border-emerald-700 px-3 py-2 text-sm text-emerald-800"
                  >
                    Post payment
                  </button>
                </div>
              ) : null}
              {ledger.length > 0 ? (
                <table className="w-full text-left text-xs text-fg">
                  <thead className="text-fg-subtle">
                    <tr>
                      <th className="py-1">Document</th>
                      <th>Type</th>
                      <th>Amount</th>
                      <th>Remaining</th>
                      <th>KRA</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((entry) => (
                      <tr key={entry.id} className="border-t border-line">
                        <td className="py-1">{entry.documentNo}</td>
                        <td>{entry.description || entry.documentType}</td>
                        <td>{money(entry.amount)}</td>
                        <td>{money(entry.remainingAmount)}</td>
                        <td>{entry.kraTransmissionStatus}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </section>
          ) : null}

          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full text-left text-sm text-fg">
              <thead className="bg-surface-raised text-xs text-fg-subtle">
                <tr>
                  <th className="px-3 py-2">Number</th>
                  <th>Name</th>
                  <th>Tax PIN</th>
                  <th>Type</th>
                  <th>Balance</th>
                  <th>Limit</th>
                  <th>KRA</th>
                  <th>Blocked</th>
                  <th className="px-3 py-2 text-right"> </th>
                </tr>
              </thead>
              <tbody>
                {customers.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-fg-subtle">
                      No customers yet. A checkout with a new email creates a cash customer here,
                      including the name, phone, address, and tax PIN entered at checkout.
                    </td>
                  </tr>
                ) : (
                  customers.map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer border-t border-line hover:bg-hover"
                      onClick={() => openCustomer(row)}
                    >
                      <td className="px-3 py-2 font-mono text-xs">{row.number}</td>
                      <td>{row.name}</td>
                      <td className="font-mono text-xs">{row.buyerKraPin || '—'}</td>
                      <td className="capitalize">{row.accountType}</td>
                      <td>{money(row.balance)}</td>
                      <td>{money(row.creditLimit)}</td>
                      <td>{row.transmitInvoicesToKra ? 'Transmit' : 'Skip'}</td>
                      <td className="capitalize">{row.blocked}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className="text-xs text-red-700 hover:text-red-800"
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteCustomer(row);
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {showProfileForm ? (
            <section className="space-y-4 rounded-xl border border-line bg-surface-sunken/60 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-fg-muted">
                  Code
                  <input
                    className={`${fieldClass} mt-1`}
                    value={profileForm.code}
                    onChange={(e) => setProfileForm((f) => ({ ...f, code: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  Name
                  <input
                    className={`${fieldClass} mt-1`}
                    value={profileForm.name}
                    onChange={(e) => setProfileForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted sm:col-span-2">
                  Description
                  <input
                    className={`${fieldClass} mt-1`}
                    value={profileForm.description}
                    onChange={(e) => setProfileForm((f) => ({ ...f, description: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  Account type
                  <select
                    className={`${fieldClass} mt-1`}
                    value={profileForm.accountType}
                    onChange={(e) => {
                      const accountType = accountTypeOf(e.target.value);
                      setProfileForm((f) => ({
                        ...f,
                        accountType,
                        creditLimit: accountType === 'cash' ? '0' : f.creditLimit,
                        paymentTermDays: accountType === 'cash' ? '0' : f.paymentTermDays || '30',
                      }));
                    }}
                  >
                    <option value="cash">Cash</option>
                    <option value="credit">Credit</option>
                  </select>
                </label>
                <label className="block text-xs text-fg-muted">
                  Credit limit
                  <input
                    className={`${fieldClass} mt-1`}
                    type="number"
                    min={0}
                    disabled={profileForm.accountType === 'cash'}
                    value={profileForm.accountType === 'cash' ? '0' : profileForm.creditLimit}
                    onChange={(e) => setProfileForm((f) => ({ ...f, creditLimit: e.target.value }))}
                  />
                </label>
                <label className="block text-xs text-fg-muted">
                  Payment terms (days)
                  <input
                    className={`${fieldClass} mt-1`}
                    type="number"
                    min={0}
                    disabled={profileForm.accountType === 'cash'}
                    value={profileForm.accountType === 'cash' ? '0' : profileForm.paymentTermDays}
                    onChange={(e) =>
                      setProfileForm((f) => ({ ...f, paymentTermDays: e.target.value }))
                    }
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={profileForm.transmitInvoicesToKra}
                    onChange={(e) =>
                      setProfileForm((f) => ({ ...f, transmitInvoicesToKra: e.target.checked }))
                    }
                  />
                  Mark invoices for KRA
                </label>
              </div>
              <DimensionFields
                fields={fields}
                selected={profileForm.dimensions}
                onChange={(fieldName, code) =>
                  setProfileForm((f) => ({
                    ...f,
                    dimensions: { ...f.dimensions, [fieldName]: code },
                  }))
                }
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={saveProfile}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-50"
                >
                  Save profile
                </button>
                <button
                  type="button"
                  onClick={() => setShowProfileForm(false)}
                  className="rounded-lg border border-line-strong px-3 py-2 text-sm text-fg"
                >
                  Close
                </button>
              </div>
            </section>
          ) : null}
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full text-left text-sm text-fg">
              <thead className="bg-surface-raised text-xs text-fg-subtle">
                <tr>
                  <th className="px-3 py-2">Code</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Terms</th>
                  <th>KRA</th>
                </tr>
              </thead>
              <tbody>
                {profiles.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-fg-subtle">
                      No profiles yet. Create one when you want a reusable cash or credit setup.
                    </td>
                  </tr>
                ) : (
                  profiles.map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer border-t border-line hover:bg-hover"
                      onClick={() => openProfile(row)}
                    >
                      <td className="px-3 py-2 font-mono text-xs">{row.code}</td>
                      <td>{row.name}</td>
                      <td className="capitalize">{row.accountType}</td>
                      <td>
                        {row.accountType === 'cash'
                          ? 'Due on invoice'
                          : `${row.paymentTermDays} days`}
                      </td>
                      <td>{row.transmitInvoicesToKra ? 'Transmit' : 'Skip'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
