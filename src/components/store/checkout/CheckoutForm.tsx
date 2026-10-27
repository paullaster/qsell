'use client';

import { useEffect, useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import Link from 'next/link';
import { ArrowRight, Building, Check, CreditCard, Lock, LogIn, MapPin, Smartphone, User, UserPlus } from 'lucide-react';
import type { CustomerAccount, CustomerAddress, PaymentProvider } from '@/types/index';
import type { PaymentProviderCode } from '@/server/domains/payments/types';
import type { CartLine } from '@/lib/cart-lines';
import { cartTotals } from '@/lib/cartMoney';
import { readOptionalEmail } from '@/lib/guest-contact';
import { has, nth, orElse } from '@/lib/values';
import { paymentUsesPhone, resolvePaymentPhone } from '@/lib/payment-phone';
import { PayFromField } from '@/components/store/checkout/PayFromField';
import { fetchCustomerAccountAction, listEnabledCheckoutProvidersAction, lookupCheckoutCustomerAction, addCustomerAddressAction } from '@/server/actions';
import { useStore } from '@/components/store/StoreContext';
import { OrderSummary } from '@/components/store/checkout/OrderSummary';

export interface CheckoutSubmission {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** Set when the customer chose to pay from a number other than the contact number. */
  paymentPhone?: string;
  buyerKraPin?: string;
  shippingAddress: { street: string; city: string; countyOrState: string; country: string };
  paymentMethod: PaymentProvider;
}

interface CheckoutFormProps {
  lines: CartLine[];
  defaultCountry: string;
  submitting: boolean;
  /** Why the last attempt failed, in words for the shopper. */
  error: string | null;
  onSubmit: (data: CheckoutSubmission) => Promise<void>;
}

const inputClass =
  'min-h-11 w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-sm text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40';

function Field({ label, hint, className = '', children }: { label: string; hint?: string; className?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-fg">{label}</label>
      {children(id)}
      {hint === undefined ? null : <p className="mt-1 text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

function SectionTitle({ number, icon, children }: { number: number; icon: ReactNode; children: string }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-indigo-500 uppercase dark:text-indigo-400">
      {icon}
      <span>{number}. {children}</span>
    </h2>
  );
}

function addressToggleLabel(hasSaved: boolean, addingNew: boolean): string {
  if (!hasSaved) return 'Add your first delivery address';
  return addingNew ? 'Cancel and use a saved address' : 'Deliver to a new address';
}

function ProviderIcon({ code }: { code: PaymentProviderCode }) {
  if (code === 'mpesa_daraja' || code === 'kcb_buni') return <Smartphone className="h-4 w-4 text-emerald-600" aria-hidden="true" />;
  if (code === 'jenga_hq') return <Building className="h-4 w-4 text-amber-600" aria-hidden="true" />;
  return <CreditCard className="h-4 w-4 text-indigo-400" aria-hidden="true" />;
}

interface LookedUp {
  found: boolean;
  accountType: 'cash' | 'credit' | null;
  name: string | null;
  blocked: boolean;
  creditLimit: number;
  balance: number;
  transmitInvoicesToKra: boolean;
}

/** Who is buying, where it goes, and how they pay, with the order beside it. The server checks all of it again. */
export function CheckoutForm({ lines, defaultCountry, submitting, error, onSubmit }: CheckoutFormProps) {
  const { money } = useStore();
  const [customer, setCustomer] = useState<CustomerAccount | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  // Blank means "pay from my contact number"; anything typed is the number the payment is made from.
  const [payPhone, setPayPhone] = useState('');
  const [buyerKraPin, setBuyerKraPin] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [countyOrState, setCountyOrState] = useState('');
  const [country, setCountry] = useState(defaultCountry);
  const [chosenMethod, setPaymentMethod] = useState<PaymentProvider | ''>('');
  const [providers, setProviders] = useState<{ code: PaymentProviderCode; label: string; description: string }[] | null>(null);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [useNewAddress, setUseNewAddress] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lookedUp, setLookedUp] = useState<LookedUp | null>(null);

  const isSignedIn = customer !== null && has(customer.email);
  // A lookup answer only counts while the email field still holds an address.
  const accountCustomer = customerEmail.includes('@') ? lookedUp : null;

  useEffect(() => {
    const email = customerEmail.trim();
    if (!email.includes('@')) return;
    const handle = window.setTimeout(() => {
      lookupCheckoutCustomerAction(email)
        .then(setLookedUp)
        .catch(() => setLookedUp(null));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [customerEmail]);

  // A signed-in shopper's saved details and addresses fill the form; the ways to pay come from the shop.
  useEffect(() => {
    fetchCustomerAccountAction()
      .then(({ customer: account }) => {
        if (account === null) {
          setCustomer(null);
          setUseNewAddress(true);
          return;
        }
        setCustomer(account);
        setCustomerName(account.name);
        setCustomerEmail(account.email);
        setCustomerPhone(account.phone);
        setBuyerKraPin(account.buyerKraPin ?? '');
        if (account.addresses.length > 0) {
          const preferred = account.addresses.find((a) => a.isDefault) ?? nth(account.addresses, 0);
          setSelectedAddressId(preferred.id);
          setUseNewAddress(false);
          setStreet(preferred.street);
          setCity(preferred.city);
          setCountyOrState(preferred.countyOrState);
          setCountry(preferred.country);
        } else {
          setUseNewAddress(true);
        }
      })
      .catch(() => {
        setCustomer(null);
        setUseNewAddress(true);
      });
    listEnabledCheckoutProvidersAction()
      .then((list) => {
        setProviders(list);
        setPaymentMethod((current) => (current !== '' && list.some((p) => p.code === current) ? current : (list[0]?.code ?? '')));
      })
      .catch(() => setProviders([]));
  }, []);

  const pickSaved = (address: CustomerAddress) => {
    setSelectedAddressId(address.id);
    setUseNewAddress(false);
    setStreet(address.street);
    setCity(address.city);
    setCountyOrState(address.countyOrState);
    setCountry(address.country);
    if (has(address.recipientName)) setCustomerName(address.recipientName);
    if (has(address.recipientPhone)) setCustomerPhone(address.recipientPhone);
  };

  const totals = cartTotals(lines);
  const enabled = providers ?? [];
  const creditAvailable = accountCustomer?.accountType === 'credit' ? accountCustomer.creditLimit - accountCustomer.balance : 0;
  const canPayOnAccount = accountCustomer?.found === true && accountCustomer.accountType === 'credit' && !accountCustomer.blocked && creditAvailable >= totals.totalAmount;
  // On account is open only to a credit customer with room; otherwise the first enabled provider stands.
  const paymentMethod: PaymentProvider | '' = chosenMethod === 'on_account' && !canPayOnAccount ? (enabled[0]?.code ?? '') : chosenMethod;
  const payLabel = paymentMethod === 'on_account' ? 'On account' : enabled.find((provider) => provider.code === paymentMethod)?.label;
  const savedAddresses = customer?.addresses ?? [];
  const hasSavedAddresses = savedAddresses.length > 0;
  const showAddressFields = !isSignedIn || useNewAddress || !hasSavedAddresses;
  const shownError = formError ?? error;

  let paymentBody: ReactNode;
  if (providers === null) {
    paymentBody = (
            <p role="status" className="text-sm text-fg-muted">Loading the ways to pay…</p>
    );
  } else if (enabled.length === 0 && !canPayOnAccount) {
    paymentBody = (
            <p className="rounded-lg border border-line bg-surface-raised px-3 py-3 text-sm text-fg-muted">Online payment is unavailable right now. Please try again later or contact us for help.</p>
    );
  } else {
    paymentBody = (
            <fieldset className="space-y-2.5">
              <legend className="sr-only">Choose how to pay</legend>
              {canPayOnAccount ? (
                <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-all ${paymentMethod === 'on_account' ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-line bg-surface hover:border-line-strong'}`}>
                  <input type="radio" name="payment_provider" checked={paymentMethod === 'on_account'} onChange={() => setPaymentMethod('on_account')} className="mt-1 h-4 w-4 accent-indigo-600" />
                  <span>
                    <span className="block text-sm font-semibold text-fg-strong">On account</span>
                    <span className="mt-0.5 block text-xs text-fg-muted">
                      {accountCustomer.name} · credit available {money(creditAvailable)}
                      {accountCustomer.transmitInvoicesToKra ? ' · invoice will be marked for KRA' : ' · invoice will not be sent to KRA'}
                    </span>
                  </span>
                </label>
              ) : null}
              {enabled.map((provider) => (
                <label key={provider.code} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-all ${paymentMethod === provider.code ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-line bg-surface hover:border-line-strong'}`}>
                  <input type="radio" name="payment_provider" checked={paymentMethod === provider.code} onChange={() => setPaymentMethod(provider.code)} className="mt-1 h-4 w-4 accent-indigo-600" />
                  <span className="flex-1">
                    <span className="flex items-center gap-2"><ProviderIcon code={provider.code} /><span className="text-sm font-semibold text-fg-strong">{provider.label}</span></span>
                    <span className="mt-1 block text-xs text-fg-muted">{provider.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
    );
  }

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!has(customerName) || !has(customerPhone) || !has(street) || !has(city)) {
      setFormError(isSignedIn && !hasSavedAddresses ? 'Add a delivery address to continue.' : 'Please fill in your name, phone number and delivery address.');
      return;
    }
    const email = readOptionalEmail(customerEmail);
    if (!email.ok) {
      setFormError(email.error);
      return;
    }
    if (paymentMethod === '') {
      setFormError('Online payment is unavailable right now. Please try again later or contact us for help.');
      return;
    }
    const payFrom = resolvePaymentPhone({ method: paymentMethod, contactPhone: customerPhone, paymentPhone: payPhone });
    if (!payFrom.ok) {
      setFormError(payFrom.error);
      return;
    }
    try {
      if (isSignedIn && (useNewAddress || !hasSavedAddresses)) {
        const { customer: updated } = await addCustomerAddressAction(customer.id, {
          label: hasSavedAddresses ? 'Delivery' : 'Primary',
          recipientName: customerName,
          recipientPhone: customerPhone,
          street,
          city,
          countyOrState,
          country,
          isDefault: !hasSavedAddresses,
        });
        setCustomer(updated);
      }
    } catch {
      // The address could not be saved to the account; the order itself does not depend on it.
    }
    await onSubmit({
      customerName,
      customerEmail: email.email,
      customerPhone,
      ...(paymentUsesPhone(paymentMethod) && payPhone.trim() !== '' ? { paymentPhone: payPhone.trim() } : {}),
      buyerKraPin: orElse(buyerKraPin.trim(), undefined),
      shippingAddress: { street, city, countyOrState, country },
      paymentMethod,
    });
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="grid grid-cols-1 gap-6 lg:grid-cols-12" aria-busy={submitting}>
      <div className="space-y-8 lg:col-span-7">
        {shownError === null ? null : (
          <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3.5 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
            {shownError}
          </div>
        )}

        <section aria-label="Your details" className="space-y-4">
          <SectionTitle number={1} icon={<User className="h-4 w-4" aria-hidden="true" />}>Your details</SectionTitle>
          {isSignedIn ? (
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-sm font-semibold text-fg-strong">{customerName}</p>
              <p className="mt-0.5 text-sm text-fg-muted">{customerEmail}</p>
              <p className="mt-0.5 font-mono text-sm text-fg">{customerPhone}</p>
              {has(customer.customerNumber) ? <p className="mt-1 font-mono text-xs text-fg-muted">{customer.customerNumber}</p> : null}
              <Field label="Tax PIN (optional)" className="mt-3">
                {(id) => <input id={id} value={buyerKraPin} onChange={(e) => setBuyerKraPin(e.target.value)} autoComplete="off" className={`${inputClass} font-mono uppercase`} placeholder="KRA PIN" />}
              </Field>
            </div>
          ) : (
            <>
              <div className="rounded-2xl border border-indigo-500/30 bg-indigo-500/5 p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white"><UserPlus className="h-5 w-5" aria-hidden="true" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-fg-strong">Faster checkout next time</p>
                    <p className="mt-1 text-sm text-fg-muted">Sign in to use your saved details, or create an account to keep your addresses and orders together. You can also check out as a guest below.</p>
                    <div className="mt-3 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
                      <Link href="/register?callbackUrl=%2Fcheckout" className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-bold text-white hover:bg-indigo-500"><UserPlus className="h-4 w-4" aria-hidden="true" />Create account</Link>
                      <Link href="/login?callbackUrl=%2Fcheckout" className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface-raised px-4 text-sm font-semibold text-fg-strong hover:bg-hover"><LogIn className="h-4 w-4" aria-hidden="true" />Sign in</Link>
                    </div>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Full name">
                  {(id) => <input id={id} value={customerName} onChange={(e) => setCustomerName(e.target.value)} required autoComplete="name" className={inputClass} placeholder="Full name" />}
                </Field>
                <Field label="Email (optional)" hint="For your receipt. You can leave this empty.">
                  {(id) => <input id={id} type="email" value={customerEmail} onChange={(e) => setCustomerEmail(e.target.value)} autoComplete="email" className={inputClass} placeholder="you@example.com" />}
                </Field>
                <Field label="Mobile phone" className="sm:col-span-2" hint="Used for delivery updates and, if you choose it, the M-Pesa prompt.">
                  {(id) => <input id={id} type="tel" inputMode="tel" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} required autoComplete="tel" className={`${inputClass} font-mono`} placeholder="07XX XXX XXX" />}
                </Field>
                <Field label="Tax PIN (optional)" className="sm:col-span-2">
                  {(id) => <input id={id} value={buyerKraPin} onChange={(e) => setBuyerKraPin(e.target.value)} autoComplete="off" className={`${inputClass} font-mono uppercase`} placeholder="KRA PIN" />}
                </Field>
              </div>
            </>
          )}
        </section>

        <section aria-label="Delivery address" className="space-y-4">
          <SectionTitle number={2} icon={<MapPin className="h-4 w-4" aria-hidden="true" />}>Delivery address</SectionTitle>
          {hasSavedAddresses ? (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Your saved addresses">
              {savedAddresses.map((address) => {
                const selected = !useNewAddress && selectedAddressId === address.id;
                return (
                  <li key={address.id}>
                    <button
                      type="button"
                      onClick={() => pickSaved(address)}
                      aria-pressed={selected}
                      className={`flex min-h-11 w-full cursor-pointer items-start justify-between gap-2 rounded-xl border p-3 text-left text-sm transition-all ${selected ? 'border-indigo-500 bg-indigo-600/10' : 'border-line bg-surface hover:border-line-strong'}`}
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 font-semibold text-fg-strong">
                          <span className="truncate">{address.label}</span>
                          {address.isDefault ? <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">Default</span> : null}
                        </span>
                        <span className="mt-0.5 block truncate text-fg-muted">{address.street}</span>
                        <span className="block text-xs text-fg-muted">{address.city}, {address.countyOrState}</span>
                      </span>
                      {selected ? <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white"><Check className="h-3 w-3" aria-hidden="true" /></span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {isSignedIn ? (
            <button
              type="button"
              onClick={() => {
                if (useNewAddress && hasSavedAddresses) {
                  pickSaved(savedAddresses.find((a) => a.id === selectedAddressId) ?? savedAddresses.find((a) => a.isDefault) ?? nth(savedAddresses, 0));
                  return;
                }
                setUseNewAddress(true);
                setSelectedAddressId(null);
                setStreet('');
                setCity('');
                setCountyOrState('');
                setCountry(defaultCountry);
              }}
              aria-pressed={useNewAddress}
              className={`min-h-11 w-full cursor-pointer rounded-xl border px-3 py-2 text-left text-sm transition-colors ${useNewAddress ? 'border-indigo-500 bg-indigo-600/10' : 'border-line bg-surface hover:border-line-strong'}`}
            >
              {addressToggleLabel(hasSavedAddresses, useNewAddress)}
            </button>
          ) : null}
          {showAddressFields ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Street, building or office" className="sm:col-span-2">
                {(id) => <input id={id} value={street} onChange={(e) => setStreet(e.target.value)} required autoComplete="street-address" className={inputClass} placeholder="Street address" />}
              </Field>
              <Field label="City or town">
                {(id) => <input id={id} value={city} onChange={(e) => setCity(e.target.value)} required autoComplete="address-level2" className={inputClass} placeholder="City" />}
              </Field>
              <Field label="County or region">
                {(id) => <input id={id} value={countyOrState} onChange={(e) => setCountyOrState(e.target.value)} autoComplete="address-level1" className={inputClass} placeholder="Region" />}
              </Field>
              <Field label="Country" className="sm:col-span-2">
                {(id) => <input id={id} value={country} onChange={(e) => setCountry(e.target.value)} autoComplete="country-name" className={inputClass} />}
              </Field>
            </div>
          ) : null}
        </section>

        <section aria-label="Payment method" className="space-y-3">
          <SectionTitle number={3} icon={<CreditCard className="h-4 w-4" aria-hidden="true" />}>Payment method</SectionTitle>
          {paymentBody}
          {paymentUsesPhone(paymentMethod) ? <PayFromField value={payPhone} contactPhone={customerPhone} onChange={setPayPhone} label={`${payLabel ?? 'Mobile'} number to pay from`} /> : null}
        </section>
      </div>

      <aside aria-label="Order summary" className="space-y-5 self-start rounded-xl border border-line bg-surface p-4 sm:p-5 lg:sticky lg:top-24 lg:col-span-5">
        <h2 className="border-b border-line pb-2 text-base font-bold text-fg-strong">Order review ({lines.length} {lines.length === 1 ? 'item' : 'items'})</h2>
        <OrderSummary lines={lines} />
        <button
          type="submit"
          disabled={submitting || providers === null}
          className="flex min-h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />
              Placing your order…
            </>
          ) : (
            <>
              Pay {money(totals.totalAmount)}
              {has(payLabel) ? ` with ${payLabel}` : ''}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </>
          )}
        </button>
        <p className="flex items-center justify-center gap-1.5 text-center text-xs text-fg-muted"><Lock className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />Secure checkout</p>
      </aside>
    </form>
  );
}
