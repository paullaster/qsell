'use client';

import React, { useState, useEffect } from 'react';
import {
  X,
  Smartphone,
  CreditCard,
  ShieldCheck,
  Lock,
  MapPin,
  User,
  Mail,
  Phone,
  ArrowRight,
  Building,
  Check,
} from 'lucide-react';
import {
  Product,
  type PaymentProvider,
  Order,
  type CustomerAccount,
  type CustomerAddress,
} from '@/types/index';
import { type CartItem } from './CartDrawer';
import { fetchCustomerAccountAction, listEnabledCheckoutProvidersAction } from '@/server/actions';
import type { PaymentProviderCode } from '@/server/domains/payments/types';

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  onSubmitCheckout: (checkoutData: {
    customerName: string;
    customerEmail: string;
    customerPhone: string;
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

export function CheckoutModal({
  isOpen,
  onClose,
  items,
  onSubmitCheckout,
  isLoading,
}: CheckoutModalProps) {
  const [customer, setCustomer] = useState<CustomerAccount | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [countyOrState, setCountyOrState] = useState('');
  const [country, setCountry] = useState('Kenya');
  const [paymentMethod, setPaymentMethod] = useState<PaymentProvider | ''>('');
  const [enabledProviders, setEnabledProviders] = useState<
    { code: PaymentProviderCode; label: string; description: string }[]
  >([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Load customer profile to autofill addresses and payment rails
  useEffect(() => {
    if (!isOpen) return;

    fetchCustomerAccountAction()
      .then(({ customer }) => {
        if (customer) {
          setCustomer(customer);
          setCustomerName(customer.name);
          setCustomerEmail(customer.email);
          setCustomerPhone(customer.phone);
          if (customer.addresses && customer.addresses.length > 0) {
            const def = customer.addresses.find((a) => a.isDefault) || customer.addresses[0];
            setSelectedAddressId(def.id);
            setStreet(def.street);
            setCity(def.city);
            setCountyOrState(def.countyOrState);
            setCountry(def.country);
          }
        }
      })
      .catch(() => {});

    listEnabledCheckoutProvidersAction()
      .then((providers) => {
        setEnabledProviders(providers);
        setPaymentMethod((current) => {
          if (current && providers.some((p) => p.code === current)) return current;
          return (providers[0]?.code as PaymentProvider) || '';
        });
      })
      .catch(() => setEnabledProviders([]));
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSelectSavedAddress = (addr: CustomerAddress) => {
    setSelectedAddressId(addr.id);
    setStreet(addr.street);
    setCity(addr.city);
    setCountyOrState(addr.countyOrState);
    setCountry(addr.country);
    if (addr.recipientName) setCustomerName(addr.recipientName);
    if (addr.recipientPhone) setCustomerPhone(addr.recipientPhone);
  };

  const subtotal = items.reduce((sum, item) => sum + (item.product.price ?? 0) * item.quantity, 0);
  // Rough display estimate — server recomputes authoritative tax from product tax categories
  const tax = Math.round(subtotal * 0.16);
  const shippingFee = subtotal > 100000 ? 0 : 500;
  const total = subtotal + tax + shippingFee;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!customerName || !customerEmail || !customerPhone || !street || !city) {
      setFormError('Please fill in all mandatory billing and shipping fields.');
      return;
    }
    if (!paymentMethod) {
      setFormError('No payment method is available. Enable a provider in Settings → Payments.');
      return;
    }

    try {
      await onSubmitCheckout({
        customerName,
        customerEmail,
        customerPhone,
        shippingAddress: {
          street,
          city,
          countyOrState,
          country,
        },
        paymentMethod,
      });
    } catch (err: any) {
      setFormError(err.message || 'Checkout failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-md sm:p-6">
      <div className="relative my-8 flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-600/20 text-emerald-400">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Secure Checkout</h2>
              <p className="text-xs text-zinc-400">
                Pay via Safaricom M-Pesa STK Push or Credit/Debit Card
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 transition-colors hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content Form */}
        <form
          onSubmit={handleSubmit}
          className="grid flex-1 grid-cols-1 gap-8 overflow-y-auto p-6 lg:grid-cols-12"
        >
          {/* Left Column: Shipping & Customer Info */}
          <div className="space-y-6 lg:col-span-7">
            {formError && (
              <div className="rounded-lg border border-red-800 bg-red-950/80 p-3.5 text-xs text-red-200">
                {formError}
              </div>
            )}

            {/* Customer Details */}
            <div className="space-y-4">
              <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-indigo-400 uppercase">
                <User className="h-4 w-4" /> 1. Customer & Identification
              </h3>
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Full Legal Name
                  </label>
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    required
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                    placeholder="e.g. Paul Laster Okoth"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Email (eTIMS Receipt)
                  </label>
                  <input
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    required
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                    placeholder="paullasterokoth98@gmail.com"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Kenyan Mobile Phone{' '}
                    <span className="font-normal text-emerald-400">(For M-Pesa STK Prompt)</span>
                  </label>
                  <div className="relative">
                    <Phone className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-emerald-400" />
                    <input
                      type="text"
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      required
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-2 pr-4 pl-10 font-mono text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                      placeholder="0712345678 or 254712345678"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Shipping Address */}
            <div className="space-y-4 pt-2">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-indigo-400 uppercase">
                  <MapPin className="h-4 w-4" /> 2. Delivery & Dispatch Address
                </h3>
                {customer?.addresses && customer.addresses.length > 0 && (
                  <span className="text-[11px] text-zinc-400">
                    {customer.addresses.length} saved addresses
                  </span>
                )}
              </div>

              {/* Saved Address Quick-Pick Cards */}
              {customer?.addresses && customer.addresses.length > 0 && (
                <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {customer.addresses.map((addr) => (
                    <button
                      key={addr.id}
                      type="button"
                      onClick={() => handleSelectSavedAddress(addr)}
                      className={`flex cursor-pointer items-start justify-between gap-2 rounded-xl border p-2.5 text-left text-xs transition-all ${
                        selectedAddressId === addr.id
                          ? 'border-indigo-500 bg-indigo-600/10 text-white shadow-sm'
                          : 'border-zinc-800 bg-zinc-950/60 text-zinc-300 hover:border-zinc-700'
                      }`}
                    >
                      <div className="overflow-hidden">
                        <div className="flex items-center gap-1.5 font-bold text-zinc-200">
                          <Building className="h-3 w-3 flex-shrink-0 text-indigo-400" />
                          <span className="truncate">{addr.label}</span>
                          {addr.isDefault && (
                            <span className="py-0.2 rounded bg-emerald-500/10 px-1.5 text-[9px] text-emerald-400">
                              Default
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-zinc-400">{addr.street}</p>
                        <p className="text-[10px] text-zinc-500">
                          {addr.city}, {addr.countyOrState}
                        </p>
                      </div>
                      {selectedAddressId === addr.id && (
                        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-indigo-600">
                          <Check className="h-2.5 w-2.5 stroke-[3] text-white" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Street / Building / Office
                  </label>
                  <input
                    type="text"
                    value={street}
                    onChange={(e) => setStreet(e.target.value)}
                    required
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                    placeholder="e.g. Riverside Drive, Delta Corner Suite 4A"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    City / Town
                  </label>
                  <input
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    required
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                    placeholder="Nairobi"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    County / Region
                  </label>
                  <input
                    type="text"
                    value={countyOrState}
                    onChange={(e) => setCountyOrState(e.target.value)}
                    required
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                    placeholder="Nairobi County"
                  />
                </div>
              </div>
            </div>

            {/* Payment Method Selector — only branch-enabled providers */}
            <div className="space-y-3 pt-2">
              <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-indigo-400 uppercase">
                <CreditCard className="h-4 w-4" /> 3. Select Payment Gateway
              </h3>
              {enabledProviders.length === 0 ? (
                <p className="rounded-lg border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                  No payment methods are enabled for this branch. Configure credentials under Admin →
                  Settings → Payments.
                </p>
              ) : (
                <div className="space-y-2.5">
                  {enabledProviders.map((provider) => {
                    const selected = paymentMethod === provider.code;
                    return (
                      <label
                        key={provider.code}
                        onClick={() => setPaymentMethod(provider.code)}
                        className={`flex cursor-pointer items-start gap-3.5 rounded-xl border p-3.5 transition-all ${
                          selected
                            ? 'border-indigo-500/50 bg-indigo-950/30 shadow-md shadow-indigo-950/30'
                            : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700'
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
                            {provider.code === 'mpesa_daraja' || provider.code === 'kcb_buni' ? (
                              <Smartphone className="h-4 w-4 text-emerald-400" />
                            ) : provider.code === 'jenga_hq' ? (
                              <Building className="h-4 w-4 text-amber-400" />
                            ) : (
                              <CreditCard className="h-4 w-4 text-indigo-400" />
                            )}
                            <span className="text-xs font-bold text-white">{provider.label}</span>
                          </div>
                          <p className="mt-1 text-[11px] text-zinc-400">{provider.description}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Order Summary & Execution */}
          <div className="flex flex-col justify-between space-y-6 rounded-xl border border-zinc-800 bg-zinc-950 p-5 lg:col-span-5">
            <div className="space-y-4">
              <h3 className="border-b border-zinc-800 pb-2 text-sm font-bold text-white">
                Order Review ({items.length} {items.length === 1 ? 'item' : 'items'})
              </h3>

              <div className="max-h-52 space-y-3 overflow-y-auto pr-1">
                {items.map(({ product, quantity }) => (
                  <div key={product.id} className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="h-9 w-9 shrink-0 rounded-lg bg-zinc-900 object-cover"
                        referrerPolicy="no-referrer"
                      />
                      <div className="truncate">
                        <div className="truncate font-medium text-white" title={product.name}>
                          {product.name}
                        </div>
                        <div className="text-[10px] text-zinc-500">
                          Qty: {quantity} × KES {(product.price ?? 0).toLocaleString()}
                        </div>
                      </div>
                    </div>
                    <span className="shrink-0 font-mono text-zinc-200">
                      KES {((product.price ?? 0) * quantity).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>

              <div className="space-y-2 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span className="font-mono text-zinc-200">KES {subtotal.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>16% VAT (eTIMS)</span>
                  <span className="font-mono text-zinc-200">KES {tax.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span>Express Shipping</span>
                  <span className="font-mono text-zinc-200">
                    {shippingFee === 0 ? (
                      <span className="text-emerald-400">FREE</span>
                    ) : (
                      `KES ${shippingFee}`
                    )}
                  </span>
                </div>
                <div className="flex justify-between border-t border-zinc-800 pt-2 text-base font-bold text-white">
                  <span>Total Amount</span>
                  <span className="font-mono text-white">KES {total.toLocaleString()}</span>
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
                    Sending{' '}
                    {paymentMethod === 'mpesa_daraja' ? 'M-Pesa STK Prompt' : 'Pesapal Link'}...
                  </>
                ) : (
                  <>
                    Pay KES {total.toLocaleString()} with{' '}
                    {paymentMethod === 'mpesa_daraja' ? 'M-Pesa' : 'Card'}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>

              <div className="flex items-center justify-center gap-1.5 text-center text-[11px] text-zinc-400">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                <span>100% Secure Checkout • eTIMS Tax Compliant</span>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
