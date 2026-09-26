'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, X } from 'lucide-react';
import { saveCustomerProfileAction } from '@/server/domains/customers/master-actions';
import { publishCustomerShortcut } from '@/components/admin/customer-shortcuts';

const fieldClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-strong placeholder:text-fg-faint focus:border-indigo-500 focus:outline-none';

export function CustomerProfileCreateModal({
  presentation,
}: {
  presentation: 'intercepted' | 'page';
}) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [accountType, setAccountType] = useState<'cash' | 'credit'>('cash');
  const [creditLimit, setCreditLimit] = useState('0');
  const [paymentTermDays, setPaymentTermDays] = useState('0');
  const [transmitInvoicesToKra, setTransmitInvoicesToKra] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const cash = accountType === 'cash';

  const close = () => {
    if (presentation === 'intercepted') router.back();
    else router.push('/admin/customers');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmitting(true);
      setFormError(null);
      const profile = await saveCustomerProfileAction({
        code,
        name,
        description: description || null,
        accountType,
        creditLimit: cash ? 0 : Number(creditLimit),
        paymentTermDays: cash ? 0 : Number(paymentTermDays),
        transmitInvoicesToKra,
      });
      if (presentation === 'intercepted') {
        publishCustomerShortcut({ kind: 'profile', profile });
        router.back();
      } else {
        router.push('/admin/customers');
        router.refresh();
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-backdrop/80 p-4 backdrop-blur-sm">
      <div className="relative my-8 w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface-raised shadow-2xl">
        <div className="flex items-center justify-between border-b border-line bg-surface p-5">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-indigo-400" />
            <div>
              <h3 className="text-base font-bold text-fg-strong">Create profile</h3>
              <p className="text-[11px] text-fg-muted">
                Add a profile, then return to the customer form.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            className="cursor-pointer rounded-lg p-1 text-fg-muted hover:text-fg-strong"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3 p-5">
          {formError ? <p className="text-xs text-red-700">{formError}</p> : null}
          <label className="block text-xs text-fg-muted">
            Code
            <input
              className={`${fieldClass} mt-1`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
          <label className="block text-xs text-fg-muted">
            Name
            <input
              className={`${fieldClass} mt-1`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
          <label className="block text-xs text-fg-muted">
            Description
            <input
              className={`${fieldClass} mt-1`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="block text-xs text-fg-muted">
            Account type
            <select
              className={`${fieldClass} mt-1`}
              value={accountType}
              onChange={(e) => {
                const next = e.target.value as 'cash' | 'credit';
                setAccountType(next);
                if (next === 'cash') {
                  setCreditLimit('0');
                  setPaymentTermDays('0');
                } else if (paymentTermDays === '0') {
                  setPaymentTermDays('30');
                }
              }}
            >
              <option value="cash">Cash</option>
              <option value="credit">Credit</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-fg-muted">
              Credit limit
              <input
                className={`${fieldClass} mt-1`}
                type="number"
                min={0}
                disabled={cash}
                value={cash ? '0' : creditLimit}
                onChange={(e) => setCreditLimit(e.target.value)}
              />
            </label>
            <label className="block text-xs text-fg-muted">
              Payment terms (days)
              <input
                className={`${fieldClass} mt-1`}
                type="number"
                min={0}
                disabled={cash}
                value={cash ? '0' : paymentTermDays}
                onChange={(e) => setPaymentTermDays(e.target.value)}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={transmitInvoicesToKra}
              onChange={(e) => setTransmitInvoicesToKra(e.target.checked)}
            />
            Mark invoices for KRA
          </label>
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {isSubmitting ? 'Saving…' : 'Save profile'}
          </button>
        </form>
      </div>
    </div>
  );
}
