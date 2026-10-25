'use client';

import { cartQuantityWords, perUnitSuffix } from '@/lib/cart-quantity';
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  X,
  Smartphone,
  CreditCard,
  ShieldCheck,
  Lock,
  MapPin,
  User,
  Phone,
  ArrowRight,
  Building,
  Check,
  LogIn,
  UserPlus,
} from 'lucide-react';
import {
  type PaymentProvider,
  type CustomerAccount,
  type CustomerAddress,
  type CurrencyConfig,
} from '@/types/index';
import { type CartItem } from './CartDrawer';
import {
  fetchCustomerAccountAction,
  listEnabledCheckoutProvidersAction,
  lookupCheckoutCustomerAction,
  addCustomerAddressAction,
} from '@/server/actions';
import type { PaymentProviderCode } from '@/server/domains/payments/types';
import { cartTaxRows, cartTotals, formatCartAmount } from '@/lib/cartMoney';
import { AppImage } from '@/components/ui/AppImage';
import { readOptionalEmail } from '@/lib/guest-contact';
import { has, nth, orElse } from '@/lib/values';

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  currency: CurrencyConfig | null;
  defaultCountry: string;
  onSubmitCheckout: (checkoutData: {
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    buyerKraPin?: string;
    shippingAddress: {
      street: string;
      city: string;
      countyOrState: string;
      country: string;
    };
    paymentMethod: PaymentProvider;
  }) => Promise<void>;
  isLoading: boolean;
}

function addressToggleLabel(hasSaved: boolean, addingNew: boolean): string {
  if (!hasSaved) return 'Add your first delivery address';
  return addingNew ? 'Cancel — use a saved address' : 'Deliver to a new address';
}

function ProviderIcon({ code }: { code: PaymentProviderCode }) {
  if (code === 'mpesa_daraja' || code === 'kcb_buni')
    return <Smartphone className="h-4 w-4 text-emerald-600" />;
  if (code === 'jenga_hq') return <Building className="h-4 w-4 text-amber-600" />;
  return <CreditCard className="h-4 w-4 text-indigo-400" />;
}

export function CheckoutModal({
  isOpen,
  onClose,
  items,
  currency,
  defaultCountry,
  onSubmitCheckout,
  isLoading,
}: CheckoutModalProps) {
  const [customer, setCustomer] = useState<CustomerAccount | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [buyerKraPin, setBuyerKraPin] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [countyOrState, setCountyOrState] = useState('');
  const [country, setCountry] = useState(defaultCountry);
  const [chosenMethod, setPaymentMethod] = useState<PaymentProvider | ''>('');
  const [enabledProviders, setEnabledProviders] = useState<
    { code: PaymentProviderCode; label: string; description: string }[]
  >([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [useNewAddress, setUseNewAddress] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lookedUp, setAccountCustomer] = useState<{
    found: boolean;
    accountType: 'cash' | 'credit' | null;
    name: string | null;
    blocked: boolean;
    creditLimit: number;
    balance: number;
    transmitInvoicesToKra: boolean;
  } | null>(null);

  const isSignedIn = customer !== null && has(customer.email);
  // A lookup answer only counts while the email field still holds an address.
  const accountCustomer = customerEmail.includes('@') ? lookedUp : null;

  useEffect(() => {
    if (!isOpen) return;
    const email = customerEmail.trim();
    if (!email.includes('@')) return;
    const handle = window.setTimeout(() => {
      lookupCheckoutCustomerAction(email)
        .then(setAccountCustomer)
        .catch(() => setAccountCustomer(null));
    }, 300);
    return () => window.clearTimeout(handle);
  }, [isOpen, customerEmail]);

  // Load customer profile to autofill addresses and payment rails
  useEffect(() => {
    if (!isOpen) return;

    fetchCustomerAccountAction()
      .then(({ customer: account }) => {
        if (account) {
          setCustomer(account);
          setCustomerName(account.name);
          setCustomerEmail(account.email);
          setCustomerPhone(account.phone);
          setBuyerKraPin(account.buyerKraPin ?? '');
          if (account.addresses.length > 0) {
            const def = account.addresses.find((a) => a.isDefault) ?? nth(account.addresses, 0);
            setSelectedAddressId(def.id);
            setUseNewAddress(false);
            setStreet(def.street);
            setCity(def.city);
            setCountyOrState(def.countyOrState);
            setCountry(def.country);
          } else {
            setUseNewAddress(true);
            setSelectedAddressId(null);
          }
        } else {
          setCustomer(null);
          setUseNewAddress(true);
        }
      })
      .catch(() => {
        setCustomer(null);
        setUseNewAddress(true);
      });

    listEnabledCheckoutProvidersAction()
      .then((providers) => {
        setEnabledProviders(providers);
        setPaymentMethod((current) => {
          if (current !== '' && providers.some((p) => p.code === current)) return current;
          return providers[0]?.code ?? '';
        });
      })
      .catch(() => setEnabledProviders([]));
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSelectSavedAddress = (addr: CustomerAddress) => {
    setSelectedAddressId(addr.id);
    setUseNewAddress(false);
    setStreet(addr.street);
    setCity(addr.city);
    setCountyOrState(addr.countyOrState);
    setCountry(addr.country);
    if (has(addr.recipientName)) setCustomerName(addr.recipientName);
    if (has(addr.recipientPhone)) setCustomerPhone(addr.recipientPhone);
  };

  const totals = cartTotals(items);
  const taxRows = cartTaxRows(items);
  const money = (amount: number) => formatCartAmount(amount, currency);
  const creditAvailable =
    accountCustomer?.accountType === 'credit'
      ? accountCustomer.creditLimit - accountCustomer.balance
      : 0;
  const canPayOnAccount =
    accountCustomer?.found === true &&
    accountCustomer.accountType === 'credit' &&
    !accountCustomer.blocked &&
    creditAvailable >= totals.totalAmount;
  // On account is only open to a credit customer with room; otherwise the first enabled provider stands.
  const paymentMethod: PaymentProvider | '' =
    chosenMethod === 'on_account' && !canPayOnAccount
      ? (enabledProviders[0]?.code ?? '')
      : chosenMethod;
  const selectedProvider = enabledProviders.find((provider) => provider.code === paymentMethod);
  const payLabel = paymentMethod === 'on_account' ? 'On account' : selectedProvider?.label;
  const savedAddresses = customer?.addresses ?? [];
  const hasSavedAddresses = savedAddresses.length > 0;
  const showAddressFields = !isSignedIn || useNewAddress || !hasSavedAddresses;

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!has(customerName) || !has(customerPhone) || !has(street) || !has(city)) {
      setFormError(
        isSignedIn && !hasSavedAddresses
          ? 'Add a delivery address to continue.'
          : 'Please fill in all mandatory billing and shipping fields.',
      );
      return;
    }
    const emailProblem = readOptionalEmail(customerEmail);
    if (!emailProblem.ok) {
      setFormError(emailProblem.error);
      return;
    }
    if (paymentMethod === '') {
      setFormError('No payment method is available. Enable a provider in Settings → Payments.');
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

      await onSubmitCheckout({
        customerName,
        customerEmail: emailProblem.email,
        customerPhone,
        buyerKraPin: orElse(buyerKraPin.trim(), undefined),
        shippingAddress: {
          street,
          city,
          countyOrState,
          country,
        },
        paymentMethod,
      });
    } catch (err: unknown) {
      setFormError(err instanceof Error && has(err.message) ? err.message : 'Checkout failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-backdrop/80 p-0 backdrop-blur-md sm:items-center sm:p-4 lg:p-6">
      <div className="relative flex min-h-dvh w-full max-w-4xl flex-col overflow-hidden border border-line bg-surface-raised shadow-2xl sm:my-4 sm:max-h-[calc(100dvh-2rem)] sm:min-h-0 sm:rounded-2xl lg:my-6 lg:max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-line bg-surface p-4 sm:p-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-600/20 text-emerald-600 sm:h-10 sm:w-10">
              <Lock className="h-4 w-4 sm:h-5 sm:w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-fg-strong sm:text-lg">Secure Checkout</h2>
              <p className="line-clamp-1 text-[11px] text-fg-muted sm:text-xs">
                {enabledProviders.length > 0
                  ? enabledProviders.map((provider) => provider.label).join(' · ')
                  : 'Choose a payment method to continue'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-line bg-surface-raised p-2 text-fg-muted transition-colors hover:text-fg-strong"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Form */}
        <form
          onSubmit={handleSubmit}
          className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto p-4 sm:gap-6 sm:p-6 lg:grid-cols-12"
        >
          {/* Left Column: Shipping & Customer Info */}
          <div className="space-y-6 lg:col-span-7">
            {formError !== null && (
              <div className="rounded-lg border border-red-800 bg-red-50/80 p-3.5 text-xs text-red-800">
                {formError}
              </div>
            )}

            {/* Customer Details */}
            <div className="space-y-4">
              <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-indigo-400 uppercase">
                <User className="h-4 w-4" /> 1. Customer & Identification
              </h3>
              {!isSignedIn ? (
                <section className="rounded-2xl border border-indigo-500/30 bg-indigo-500/5 p-4 sm:p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white">
                      <UserPlus className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h4 className="text-sm font-bold text-fg-strong">
                        Faster checkout next time
                      </h4>
                      <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                        Sign in to use saved details, or create an account to keep your addresses
                        and order history together. Your cart will be here when you return.
                      </p>
                      <div className="mt-4 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
                        <Link
                          href="/register?callbackUrl=%2F"
                          className="flex min-h-12 touch-manipulation items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-md transition-colors hover:bg-indigo-500"
                        >
                          <UserPlus className="h-4 w-4 shrink-0" />
                          <span>Create account</span>
                        </Link>
                        <Link
                          href="/login?callbackUrl=%2F"
                          className="flex min-h-12 touch-manipulation items-center justify-center gap-2 rounded-xl border border-line-strong bg-surface-raised px-4 py-3 text-sm font-semibold text-fg-strong transition-colors hover:bg-hover"
                        >
                          <LogIn className="h-4 w-4 shrink-0" />
                          <span>Sign in</span>
                        </Link>
                      </div>
                      <p className="mt-2 text-center text-[11px] text-fg-subtle">
                        Guest checkout is also available below.
                      </p>
                    </div>
                  </div>
                </section>
              ) : null}
              {isSignedIn ? (
                <div className="rounded-xl border border-line bg-surface/80 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-fg-strong">{customerName}</p>
                      <p className="mt-0.5 text-xs text-fg-muted">{customerEmail}</p>
                      <p className="mt-0.5 font-mono text-xs text-fg">{customerPhone}</p>
                    </div>
                    {has(customer.customerNumber) ? (
                      <span className="rounded-md border border-line-strong bg-surface-raised px-2 py-1 font-mono text-[11px] text-fg">
                        {customer.customerNumber}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-fg">Tax PIN</label>
                    <input
                      type="text"
                      value={buyerKraPin}
                      onChange={(e) => setBuyerKraPin(e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface-raised px-3.5 py-2 font-mono text-xs text-fg-strong uppercase placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                      placeholder="Optional KRA PIN"
                    />
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">
                      Full Legal Name
                    </label>
                    <input
                      type="text"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      required
                      className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                      placeholder="Full name"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">
                      Email (optional)
                    </label>
                    <input
                      type="email"
                      value={customerEmail}
                      onChange={(e) => setCustomerEmail(e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                      placeholder="you@example.com"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs font-medium text-fg">Mobile phone</label>
                    <div className="relative">
                      <Phone className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-emerald-600" />
                      <input
                        type="text"
                        value={customerPhone}
                        onChange={(e) => setCustomerPhone(e.target.value)}
                        required
                        className="w-full rounded-lg border border-line bg-surface py-2 pr-4 pl-10 font-mono text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                        placeholder="Phone number"
                      />
                    </div>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs font-medium text-fg">Tax PIN</label>
                    <input
                      type="text"
                      value={buyerKraPin}
                      onChange={(e) => setBuyerKraPin(e.target.value)}
                      className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 font-mono text-xs text-fg-strong uppercase placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                      placeholder="Optional KRA PIN"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Shipping Address */}
            <div className="space-y-4 pt-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-indigo-400 uppercase">
                  <MapPin className="h-4 w-4" /> 2. Delivery & Dispatch Address
                </h3>
                {hasSavedAddresses ? (
                  <span className="text-[11px] text-fg-muted">
                    {savedAddresses.length} saved addresses
                  </span>
                ) : null}
              </div>

              {hasSavedAddresses ? (
                <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {savedAddresses.map((addr) => (
                    <button
                      key={addr.id}
                      type="button"
                      onClick={() => handleSelectSavedAddress(addr)}
                      className={`flex cursor-pointer items-start justify-between gap-2 rounded-xl border p-2.5 text-left text-xs transition-all ${
                        !useNewAddress && selectedAddressId === addr.id
                          ? 'TW border-indigo-500 bg-indigo-600/10 shadow-sm'
                          : 'border-line bg-surface/60 text-fg hover:border-line-strong'
                      }`}
                    >
                      <div className="overflow-hidden">
                        <div className="flex items-center gap-1.5 font-bold text-fg-strong">
                          <Building className="h-3 w-3 flex-shrink-0 text-indigo-400" />
                          <span className="truncate">{addr.label}</span>
                          {addr.isDefault && (
                            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-600">
                              Default
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-fg-muted">{addr.street}</p>
                        <p className="text-[10px] text-fg-subtle">
                          {addr.city}, {addr.countyOrState}
                        </p>
                      </div>
                      {!useNewAddress && selectedAddressId === addr.id ? (
                        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-indigo-600">
                          <Check className="h-2.5 w-2.5 stroke-[3] text-fg-strong" />
                        </div>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}

              {isSignedIn ? (
                <button
                  type="button"
                  onClick={() => {
                    if (useNewAddress && hasSavedAddresses) {
                      const fallback =
                        savedAddresses.find((a) => a.id === selectedAddressId) ??
                        savedAddresses.find((a) => a.isDefault) ??
                        nth(savedAddresses, 0);
                      handleSelectSavedAddress(fallback);
                      return;
                    }
                    setUseNewAddress(true);
                    setSelectedAddressId(null);
                    setStreet('');
                    setCity('');
                    setCountyOrState('');
                    setCountry(defaultCountry);
                  }}
                  className={`w-full cursor-pointer rounded-xl border px-3 py-2 text-left text-xs transition-colors ${
                    useNewAddress
                      ? 'TW border-indigo-500 bg-indigo-600/10'
                      : 'border-line bg-surface/60 text-fg hover:border-line-strong'
                  }`}
                >
                  {addressToggleLabel(hasSavedAddresses, useNewAddress)}
                </button>
              ) : null}

              {showAddressFields ? (
                <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className="mb-1 block text-xs font-medium text-fg">
                      Street / Building / Office
                    </label>
                    <input
                      type="text"
                      value={street}
                      onChange={(e) => setStreet(e.target.value)}
                      required={showAddressFields}
                      className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                      placeholder="Street address"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">City / Town</label>
                    <input
                      type="text"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      required={showAddressFields}
                      className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                      placeholder="City"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-fg">
                      County / Region
                    </label>
                    <input
                      type="text"
                      value={countyOrState}
                      onChange={(e) => setCountyOrState(e.target.value)}
                      required={showAddressFields}
                      className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                      placeholder="Region"
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {/* Payment Method Selector — only branch-enabled providers */}
            <div className="space-y-3 pt-2">
              <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-indigo-400 uppercase">
                <CreditCard className="h-4 w-4" /> 3. Choose Payment Method
              </h3>
              {enabledProviders.length === 0 && !canPayOnAccount ? (
                <p className="rounded-lg border border-line bg-surface-raised px-3 py-3 text-sm text-fg-muted">
                  Online payment is unavailable right now. Please try again later or contact us for
                  help.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {canPayOnAccount ? (
                    <label
                      className={`flex cursor-pointer items-start gap-3.5 rounded-xl border p-3.5 transition-all ${
                        paymentMethod === 'on_account'
                          ? 'border-indigo-500/50 bg-indigo-50'
                          : 'border-line bg-surface hover:border-line-strong'
                      }`}
                    >
                      <input
                        type="radio"
                        name="payment_provider"
                        checked={paymentMethod === 'on_account'}
                        onChange={() => setPaymentMethod('on_account')}
                        className="mt-1 text-indigo-500 focus:ring-indigo-500"
                      />
                      <div>
                        <div className="text-xs font-semibold text-fg-strong">On account</div>
                        <p className="mt-0.5 text-[11px] text-fg-muted">
                          {accountCustomer.name} · credit available {money(creditAvailable)}
                          {accountCustomer.transmitInvoicesToKra
                            ? ' · invoice will be marked for KRA'
                            : ' · invoice will not be sent to KRA'}
                        </p>
                      </div>
                    </label>
                  ) : null}
                  {enabledProviders.map((provider) => {
                    const selected = paymentMethod === provider.code;
                    return (
                      <label
                        key={provider.code}
                        onClick={() => setPaymentMethod(provider.code)}
                        className={`flex cursor-pointer items-start gap-3.5 rounded-xl border p-3.5 transition-all ${
                          selected
                            ? 'border-indigo-500/50 bg-indigo-50 shadow-md shadow-indigo-950/30'
                            : 'border-line bg-surface hover:border-line-strong'
                        }`}
                      >
                        <input
                          type="radio"
                          name="payment_provider"
                          checked={selected}
                          onChange={() => setPaymentMethod(provider.code)}
                          className="mt-1 text-indigo-500 focus:ring-indigo-500"
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <ProviderIcon code={provider.code} />
                            <span className="text-xs font-bold text-fg-strong">
                              {provider.label}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] text-fg-muted">{provider.description}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Order Summary & Execution */}
          <div className="flex min-w-0 flex-col justify-between space-y-5 rounded-xl border border-line bg-surface p-4 sm:p-5 lg:col-span-5">
            <div className="space-y-4">
              <h3 className="border-b border-line pb-2 text-sm font-bold text-fg-strong">
                Order Review ({items.length} {items.length === 1 ? 'item' : 'items'})
              </h3>

              <div className="max-h-52 space-y-3 overflow-y-auto pr-1">
                {items.map(({ product, quantity }) => (
                  <div key={product.id} className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <AppImage
                        src={product.imageUrl}
                        alt={product.name}
                        width={36}
                        height={36}
                        sizes="36px"
                        className="h-9 w-9 shrink-0 rounded-lg bg-surface-raised object-cover"
                        referrerPolicy="no-referrer"
                      />
                      <div className="truncate">
                        <div className="truncate font-medium text-fg-strong" title={product.name}>
                          {product.name}
                        </div>
                        <div className="text-[10px] text-fg-subtle">
                          Qty: {cartQuantityWords(quantity, product)} × {money(product.price ?? 0)}
                          {perUnitSuffix(product)}
                        </div>
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-fg-strong">
                      {money(Math.round((product.price ?? 0) * quantity * 100) / 100)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="space-y-2 border-t border-line pt-3 text-xs text-fg-muted">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span className="font-mono text-fg-strong">{money(totals.subtotal)}</span>
                </div>
                {taxRows.map((row) => (
                  <div key={row.key} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate">{row.label}</span>
                    <span className="shrink-0 font-mono text-fg-strong">{money(row.amount)}</span>
                  </div>
                ))}
                {totals.shippingFee > 0 ? (
                  <div className="flex justify-between">
                    <span>Shipping</span>
                    <span className="font-mono text-fg-strong">{money(totals.shippingFee)}</span>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-line pt-2 text-base font-bold text-fg-strong">
                  <span>Total</span>
                  <span className="font-mono text-fg-strong">{money(totals.totalAmount)}</span>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <button
                type="submit"
                disabled={isLoading}
                className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-3.5 text-xs font-bold text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-500 disabled:opacity-50"
              >
                {isLoading ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Sending {orElse(payLabel, 'payment')}...
                  </>
                ) : (
                  <>
                    Pay {money(totals.totalAmount)}
                    {has(payLabel) ? ` with ${payLabel}` : ''}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>

              <div className="flex items-center justify-center gap-1.5 text-center text-[11px] text-fg-muted">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
                <span>Secure checkout</span>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
