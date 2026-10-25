'use client';

import { use, useState } from 'react';
import { MapPin } from 'lucide-react';
import {
  Chip,
  Field,
  LoadFailed,
  fieldClass,
  buttonClass,
  primaryClass,
} from '@/components/ui/screen-kit';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import {
  makeMyAddressDefaultAction,
  removeMyAddressAction,
  saveMyAddressAction,
  type AccountResult,
} from '@/server/domains/customers/actions';
import { blankAddress, readAddress, type AddressFields } from '@/lib/storefront-account';
import type { CustomerAddress } from '@/types/index';
import { SignInPrompt } from './SignInPrompt';

const fieldsOf = (a: CustomerAddress): AddressFields => ({
  label: a.label,
  recipientName: a.recipientName,
  recipientPhone: a.recipientPhone,
  street: a.street,
  city: a.city,
  countyOrState: a.countyOrState,
  postalCode: a.postalCode ?? '',
  country: a.country,
  isDefault: a.isDefault,
});

const TEXT_FIELDS: {
  key: Exclude<keyof AddressFields, 'isDefault'>;
  label: string;
  type?: string;
  autoComplete: string;
}[] = [
  { key: 'label', label: 'Name this address', autoComplete: 'off' },
  { key: 'recipientName', label: 'Recipient', autoComplete: 'name' },
  { key: 'recipientPhone', label: 'Recipient phone', type: 'tel', autoComplete: 'tel' },
  { key: 'street', label: 'Street or building', autoComplete: 'street-address' },
  { key: 'city', label: 'Town or city', autoComplete: 'address-level2' },
  { key: 'countyOrState', label: 'County or state', autoComplete: 'address-level1' },
  { key: 'postalCode', label: 'Postal code (optional)', autoComplete: 'postal-code' },
  { key: 'country', label: 'Country', autoComplete: 'country-name' },
];

export function AddressesClient({ first }: { first: Promise<AccountResult<CustomerAddress[]>> }) {
  const answer = use(first);
  if (!answer.ok) {
    return answer.code === 'SIGN_IN' ? (
      <SignInPrompt what="your addresses" />
    ) : (
      <LoadFailed error={answer.error} />
    );
  }
  return <AddressBook start={answer.data} />;
}

function AddressBook({ start }: { start: CustomerAddress[] }) {
  const [addresses, setAddresses] = useState(start);
  const [editing, setEditing] = useState<{ id: string | null; fields: AddressFields } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const run = async (
    call: () => Promise<AccountResult<CustomerAddress[]>>,
    done: string,
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await call();
      if (!result.ok) {
        setError(result.error);
        return false;
      }
      setAddresses(result.data);
      setSaved(done);
      return true;
    } catch {
      setError('Something went wrong. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (editing === null) return;
    const check = readAddress(editing.fields);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    if (
      await run(
        () => saveMyAddressAction({ id: editing.id, address: check.address }),
        'Address saved.',
      )
    )
      setEditing(null);
  };

  return (
    <div className="space-y-4">
      <div aria-live="polite" role="status" className="text-sm text-emerald-700">
        {saved}
      </div>
      {error === null ? null : <LoadFailed error={error} />}

      {editing === null ? (
        <button
          type="button"
          className={primaryClass}
          onClick={() => {
            setError(null);
            setSaved(null);
            setEditing({
              id: null,
              fields: { ...blankAddress, isDefault: addresses.length === 0 },
            });
          }}
        >
          Add an address
        </button>
      ) : (
        <form
          onSubmit={(event) => void submit(event)}
          className="space-y-4 rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
          aria-label={editing.id === null ? 'New address' : 'Change address'}
        >
          <h2 className="text-lg font-semibold text-fg-strong">
            {editing.id === null ? 'New address' : 'Change address'}
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {TEXT_FIELDS.map(({ key, label, type, autoComplete }) => (
              <Field key={key} id={`address-${key}`} label={label}>
                <input
                  id={`address-${key}`}
                  type={type ?? 'text'}
                  autoComplete={autoComplete}
                  value={editing.fields[key]}
                  onChange={(event) =>
                    setEditing({
                      ...editing,
                      fields: { ...editing.fields, [key]: event.target.value },
                    })
                  }
                  className={fieldClass}
                />
              </Field>
            ))}
          </div>
          <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="size-4"
              checked={editing.fields.isDefault}
              onChange={(event) =>
                setEditing({
                  ...editing,
                  fields: { ...editing.fields, isDefault: event.target.checked },
                })
              }
            />
            Use this as my delivery address
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryClass} disabled={busy}>
              {busy ? 'Saving…' : 'Save address'}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {addresses.length === 0 && editing === null ? (
        <div className="rounded-xl border border-line bg-surface-raised p-8 text-center">
          <MapPin className="mx-auto h-10 w-10 text-fg-subtle" aria-hidden="true" />
          <p className="mt-3 font-medium text-fg-strong">You have not saved an address yet.</p>
          <p className="mt-1 text-sm text-fg-muted">
            Add one and checkout can use it for your deliveries.
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Your addresses">
          {addresses.map((address) => (
            <li
              key={address.id}
              className="space-y-3 rounded-xl border border-line bg-surface-raised p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold text-fg-strong">{address.label}</p>
                {address.isDefault ? <Chip tone="green">Delivery address</Chip> : null}
              </div>
              <p className="text-sm break-words text-fg">
                {address.recipientName} · {address.recipientPhone}
                <br />
                {[
                  address.street,
                  address.city,
                  address.countyOrState,
                  address.postalCode,
                  address.country,
                ]
                  .filter((p) => p !== undefined && p !== '')
                  .join(', ')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setSaved(null);
                    setEditing({ id: address.id, fields: fieldsOf(address) });
                  }}
                >
                  Change
                </button>
                {address.isDefault ? null : (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => makeMyAddressDefaultAction(address.id),
                        'Delivery address updated.',
                      )
                    }
                  >
                    Use for delivery
                  </button>
                )}
                {addresses.length > 1 ? (
                  <InlineConfirm
                    label={`Remove address ${address.label}`}
                    action="Remove"
                    confirm="Yes, remove it"
                    busy={busy}
                    onConfirm={() =>
                      void run(() => removeMyAddressAction(address.id), 'Address removed.')
                    }
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {addresses.length === 1 ? (
        <p className="text-xs text-fg-muted">
          Keep at least one address; add another before removing this one.
        </p>
      ) : null}
    </div>
  );
}
