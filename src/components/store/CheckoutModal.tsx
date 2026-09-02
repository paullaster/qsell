'use client';

import React, { useState, useEffect } from 'react';
import { X, Smartphone, CreditCard, ShieldCheck, Lock, MapPin, User, Mail, Phone, ArrowRight, Building, Check } from 'lucide-react';
import { Product, PaymentProvider, Order, CustomerAccount, CustomerAddress } from '@/types/index';
import { CartItem } from './CartDrawer';
import { fetchCustomerAccountAction } from '@/server/actions';

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
  isLoading
}: CheckoutModalProps) {
  if (!isOpen) return null;

  const [customer, setCustomer] = useState<CustomerAccount | null>(null);
  const [customerName, setCustomerName] = useState('Paul Laster Okoth');
  const [customerEmail, setCustomerEmail] = useState('paullasterokoth98@gmail.com');
  const [customerPhone, setCustomerPhone] = useState('0712345678');
  const [street, setStreet] = useState('Riverside Drive, Delta Corner Suite 4A');
  const [city, setCity] = useState('Nairobi');
  const [countyOrState, setCountyOrState] = useState('Nairobi County');
  const [country, setCountry] = useState('Kenya');
  const [paymentMethod, setPaymentMethod] = useState<PaymentProvider>('mpesa_daraja');
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Load customer profile to autofill addresses and payment rails
  useEffect(() => {
    fetchCustomerAccountAction()
      .then(({ customer }) => {
        if (customer) {
          setCustomer(customer);
          setCustomerName(customer.name);
          setCustomerEmail(customer.email);
          setCustomerPhone(customer.phone);
          if (customer.paymentPreferences?.preferredMethod) {
            setPaymentMethod(customer.paymentPreferences.preferredMethod);
          }
          if (customer.addresses && customer.addresses.length > 0) {
            const def = customer.addresses.find(a => a.isDefault) || customer.addresses[0];
            setSelectedAddressId(def.id);
            setStreet(def.street);
            setCity(def.city);
            setCountyOrState(def.countyOrState);
            setCountry(def.country);
          }
        }
      })
      .catch(() => {});
  }, []);

  const handleSelectSavedAddress = (addr: CustomerAddress) => {
    setSelectedAddressId(addr.id);
    setStreet(addr.street);
    setCity(addr.city);
    setCountyOrState(addr.countyOrState);
    setCountry(addr.country);
    if (addr.recipientName) setCustomerName(addr.recipientName);
    if (addr.recipientPhone) setCustomerPhone(addr.recipientPhone);
  };

  const subtotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);
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

    try {
      await onSubmitCheckout({
        customerName,
        customerEmail,
        customerPhone,
        shippingAddress: {
          street,
          city,
          countyOrState,
          country
        },
        paymentMethod
      });
    } catch (err: any) {
      setFormError(err.message || 'Checkout failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-md p-4 sm:p-6 flex items-center justify-center">
      <div className="relative w-full max-w-4xl bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-8 max-h-[90vh]">
        {/* Header */}
        <div className="p-5 sm:p-6 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-lg text-white">Secure Checkout</h2>
              <p className="text-xs text-zinc-400">Pay via Safaricom M-Pesa STK Push or Credit/Debit Card</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-zinc-400 hover:text-white bg-zinc-900 border border-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSubmit} className="p-6 overflow-y-auto flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Shipping & Customer Info */}
          <div className="lg:col-span-7 space-y-6">
            {formError && (
              <div className="p-3.5 rounded-lg bg-red-950/80 border border-red-800 text-red-200 text-xs">
                {formError}
              </div>
            )}

            {/* Customer Details */}
            <div className="space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-indigo-400 flex items-center gap-2">
                <User className="w-4 h-4" /> 1. Customer & Identification
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Full Legal Name</label>
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    required
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                    placeholder="e.g. Paul Laster Okoth"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Email (eTIMS Receipt)</label>
                  <input
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    required
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                    placeholder="paullasterokoth98@gmail.com"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-zinc-300 mb-1">
                    Kenyan Mobile Phone <span className="text-emerald-400 font-normal">(For M-Pesa STK Prompt)</span>
                  </label>
                  <div className="relative">
                    <Phone className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-400" />
                    <input
                      type="text"
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      required
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-10 pr-4 py-2 text-xs font-mono text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                      placeholder="0712345678 or 254712345678"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Shipping Address */}
            <div className="space-y-4 pt-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-indigo-400 flex items-center gap-2">
                  <MapPin className="w-4 h-4" /> 2. Delivery & Dispatch Address
                </h3>
                {customer?.addresses && customer.addresses.length > 0 && (
                  <span className="text-[11px] text-zinc-400">
                    {customer.addresses.length} saved addresses
                  </span>
                )}
              </div>

              {/* Saved Address Quick-Pick Cards */}
              {customer?.addresses && customer.addresses.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
                  {customer.addresses.map((addr) => (
                    <button
                      key={addr.id}
                      type="button"
                      onClick={() => handleSelectSavedAddress(addr)}
                      className={`p-2.5 rounded-xl border text-left text-xs transition-all cursor-pointer flex items-start justify-between gap-2 ${
                        selectedAddressId === addr.id
                          ? 'bg-indigo-600/10 border-indigo-500 text-white shadow-sm'
                          : 'bg-zinc-950/60 border-zinc-800 hover:border-zinc-700 text-zinc-300'
                      }`}
                    >
                      <div className="overflow-hidden">
                        <div className="flex items-center gap-1.5 font-bold text-zinc-200">
                          <Building className="w-3 h-3 text-indigo-400 flex-shrink-0" />
                          <span className="truncate">{addr.label}</span>
                          {addr.isDefault && (
                            <span className="text-[9px] px-1.5 py-0.2 bg-emerald-500/10 text-emerald-400 rounded">Default</span>
                          )}
                        </div>
                        <p className="text-[11px] text-zinc-400 truncate mt-0.5">{addr.street}</p>
                        <p className="text-[10px] text-zinc-500">{addr.city}, {addr.countyOrState}</p>
                      </div>
                      {selectedAddressId === addr.id && (
                        <div className="w-4 h-4 rounded-full bg-indigo-600 flex items-center justify-center flex-shrink-0">
                          <Check className="w-2.5 h-2.5 text-white stroke-[3]" />
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-zinc-300 mb-1">Street / Building / Office</label>
                  <input
                    type="text"
                    value={street}
                    onChange={(e) => setStreet(e.target.value)}
                    required
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                    placeholder="e.g. Riverside Drive, Delta Corner Suite 4A"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">City / Town</label>
                  <input
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    required
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                    placeholder="Nairobi"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1">County / Region</label>
                  <input
                    type="text"
                    value={countyOrState}
                    onChange={(e) => setCountyOrState(e.target.value)}
                    required
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3.5 py-2 text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                    placeholder="Nairobi County"
                  />
                </div>
              </div>
            </div>

            {/* Payment Method Selector */}
            <div className="space-y-3 pt-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-indigo-400 flex items-center gap-2">
                <CreditCard className="w-4 h-4" /> 3. Select Payment Gateway
              </h3>
              <div className="space-y-2.5">
                {/* M-Pesa Option */}
                <label
                  onClick={() => setPaymentMethod('mpesa_daraja')}
                  className={`flex items-start gap-3.5 p-3.5 rounded-xl border transition-all cursor-pointer ${
                    paymentMethod === 'mpesa_daraja'
                      ? 'bg-emerald-950/30 border-emerald-500/50 shadow-md shadow-emerald-950/30'
                      : 'bg-zinc-950 border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="payment_provider"
                    checked={paymentMethod === 'mpesa_daraja'}
                    onChange={() => setPaymentMethod('mpesa_daraja')}
                    className="mt-1 text-emerald-500 focus:ring-emerald-500"
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Smartphone className="w-4 h-4 text-emerald-400" />
                        <span className="font-bold text-xs text-white">M-Pesa Express</span>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        INSTANT PHONE PROMPT
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      A payment prompt will be sent directly to <span className="font-mono text-emerald-300">{customerPhone}</span> to enter your M-Pesa PIN.
                    </p>
                  </div>
                </label>

                {/* Card / Bank Option */}
                <label
                  onClick={() => setPaymentMethod('pesapal_v3')}
                  className={`flex items-start gap-3.5 p-3.5 rounded-xl border transition-all cursor-pointer ${
                    paymentMethod === 'pesapal_v3'
                      ? 'bg-indigo-950/30 border-indigo-500/50 shadow-md shadow-indigo-950/30'
                      : 'bg-zinc-950 border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="payment_provider"
                    checked={paymentMethod === 'pesapal_v3'}
                    onChange={() => setPaymentMethod('pesapal_v3')}
                    className="mt-1 text-indigo-500 focus:ring-indigo-500"
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CreditCard className="w-4 h-4 text-indigo-400" />
                        <span className="font-bold text-xs text-white">Cards & Bank Transfer</span>
                      </div>
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
                        VISA / MASTERCARD
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      Pay securely with Visa, Mastercard, Airtel Money, or direct Bank transfer with instant verification.
                    </p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          {/* Right Column: Order Summary & Execution */}
          <div className="lg:col-span-5 flex flex-col justify-between space-y-6 bg-zinc-950 p-5 rounded-xl border border-zinc-800">
            <div className="space-y-4">
              <h3 className="font-bold text-white text-sm pb-2 border-b border-zinc-800">
                Order Review ({items.length} {items.length === 1 ? 'item' : 'items'})
              </h3>

              <div className="space-y-3 max-h-52 overflow-y-auto pr-1">
                {items.map(({ product, quantity }) => (
                  <div key={product.id} className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <img
                        src={product.imageUrl}
                        alt={product.name}
                        className="w-9 h-9 object-cover rounded-lg bg-zinc-900 shrink-0"
                        referrerPolicy="no-referrer"
                      />
                      <div className="truncate">
                        <div className="text-white font-medium truncate" title={product.name}>
                          {product.name}
                        </div>
                        <div className="text-zinc-500 text-[10px]">
                          Qty: {quantity} × KES {product.price.toLocaleString()}
                        </div>
                      </div>
                    </div>
                    <span className="font-mono text-zinc-200 shrink-0">
                      KES {(product.price * quantity).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>

              <div className="space-y-2 pt-3 border-t border-zinc-800 text-xs text-zinc-400">
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
                    {shippingFee === 0 ? <span className="text-emerald-400">FREE</span> : `KES ${shippingFee}`}
                  </span>
                </div>
                <div className="flex justify-between text-base font-bold text-white pt-2 border-t border-zinc-800">
                  <span>Total Amount</span>
                  <span className="text-white font-mono">KES {total.toLocaleString()}</span>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3.5 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20 transition-all disabled:opacity-50 cursor-pointer"
              >
                {isLoading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Sending {paymentMethod === 'mpesa_daraja' ? 'M-Pesa STK Prompt' : 'Pesapal Link'}...
                  </>
                ) : (
                  <>
                    Pay KES {total.toLocaleString()} with {paymentMethod === 'mpesa_daraja' ? 'M-Pesa' : 'Card'}
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>

              <div className="text-[11px] text-zinc-400 text-center flex items-center justify-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>100% Secure Checkout • eTIMS Tax Compliant</span>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
