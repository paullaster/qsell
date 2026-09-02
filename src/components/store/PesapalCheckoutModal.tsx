'use client';

import { useState } from 'react';
import {
  CreditCard,
  ShieldCheck,
  X,
  RefreshCw,
  Smartphone,
  Landmark,
  CheckCircle2,
} from 'lucide-react';
import { type Order } from '@/types/index';
import { simulatePesapalPaymentAction } from '@/server/actions';

interface PesapalCheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: Order | null;
  orderTrackingId: string;
  onPaymentSuccess: (trackingId: string) => void;
  onPaymentFailed: (error: string) => void;
}

export function PesapalCheckoutModal({
  isOpen,
  onClose,
  order,
  orderTrackingId,
  onPaymentSuccess,
  onPaymentFailed,
}: PesapalCheckoutModalProps) {
  if (!isOpen || !order) return null;

  const [selectedChannel, setSelectedChannel] = useState<
    'VISA' | 'MASTERCARD' | 'AIRTEL_MONEY' | 'EQUITY_BANK'
  >('VISA');
  const [cardNumber, setCardNumber] = useState('4242 •••• •••• 4242');
  const [expiry, setExpiry] = useState('12/28');
  const [cvv, setCvv] = useState('884');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>('');

  const handlePay = async (simulateSuccess: boolean) => {
    setIsSubmitting(true);
    setStatusText('Contacting Pesapal v3.0 Gateway & Emitting IPN...');

    try {
      const res = await simulatePesapalPaymentAction(
        orderTrackingId,
        simulateSuccess,
        selectedChannel,
      );
      if (simulateSuccess) {
        setStatusText('Pesapal IPN Verified! Reconciling order status...');
        setTimeout(() => {
          onPaymentSuccess(orderTrackingId);
        }, 1200);
      } else {
        setStatusText('Pesapal Payment Failed or Cancelled.');
        setTimeout(() => {
          onPaymentFailed('Payment declined by card issuer');
        }, 1500);
      }
    } catch (err: any) {
      setStatusText(`Error: ${err.message}`);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/85 p-4 backdrop-blur-md">
      <div className="relative my-6 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-500/10 text-indigo-400">
              <CreditCard className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Pesapal v3.0 Payment Portal</h3>
              <p className="font-mono text-[11px] text-zinc-400">
                Tracking ID: {orderTrackingId.slice(0, 16)}...
              </p>
            </div>
          </div>
          <button onClick={onClose} className="cursor-pointer text-zinc-400 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="space-y-5 bg-zinc-900 p-6">
          {/* Order Summary Pill */}
          <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 p-3.5 text-xs">
            <div>
              <span className="block text-zinc-400">Total Due:</span>
              <span className="font-mono text-lg font-bold text-white">
                KES {order.totalAmount.toLocaleString()}
              </span>
            </div>
            <div className="text-right">
              <span className="block text-zinc-400">Merchant Reference:</span>
              <span className="font-mono text-xs text-zinc-200">{order.orderNumber}</span>
            </div>
          </div>

          {/* Payment Method Channels */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-zinc-300">Select Payment Method</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSelectedChannel('VISA')}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-xs font-medium transition-all ${
                  selectedChannel === 'VISA'
                    ? 'border-indigo-500 bg-indigo-950/40 text-white'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-white'
                }`}
              >
                <CreditCard className="h-4 w-4 text-indigo-400" />
                Visa / Mastercard
              </button>
              <button
                type="button"
                onClick={() => setSelectedChannel('AIRTEL_MONEY')}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-xs font-medium transition-all ${
                  selectedChannel === 'AIRTEL_MONEY'
                    ? 'border-indigo-500 bg-indigo-950/40 text-white'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-white'
                }`}
              >
                <Smartphone className="h-4 w-4 text-rose-400" />
                Airtel Money
              </button>
              <button
                type="button"
                onClick={() => setSelectedChannel('EQUITY_BANK')}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-xs font-medium transition-all ${
                  selectedChannel === 'EQUITY_BANK'
                    ? 'border-indigo-500 bg-indigo-950/40 text-white'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-white'
                }`}
              >
                <Landmark className="h-4 w-4 text-amber-400" />
                Equity / KCB Direct
              </button>
              <button
                type="button"
                onClick={() => setSelectedChannel('MASTERCARD')}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-xs font-medium transition-all ${
                  selectedChannel === 'MASTERCARD'
                    ? 'border-indigo-500 bg-indigo-950/40 text-white'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-white'
                }`}
              >
                <CreditCard className="h-4 w-4 text-orange-400" />
                Mastercard 3DS
              </button>
            </div>
          </div>

          {/* Simulated Card inputs */}
          {(selectedChannel === 'VISA' || selectedChannel === 'MASTERCARD') && (
            <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <div>
                <label className="mb-1 block text-[11px] text-zinc-400">Card Number</label>
                <input
                  type="text"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-white focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-400">Valid Thru</label>
                  <input
                    type="text"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-white focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-zinc-400">CVV / CVC</label>
                  <input
                    type="password"
                    value={cvv}
                    onChange={(e) => setCvv(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-xs text-white focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          {statusText && (
            <div className="animate-pulse rounded-lg border border-indigo-500/30 bg-indigo-950/40 p-3 text-center text-xs text-indigo-300">
              {statusText}
            </div>
          )}

          {/* Action Buttons */}
          <div className="space-y-2 pt-2">
            <button
              onClick={() => handlePay(true)}
              disabled={isSubmitting}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 transition-all hover:bg-indigo-500 disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" /> Processing IPN...
                </>
              ) : (
                `Complete KES ${order.totalAmount.toLocaleString()} Payment`
              )}
            </button>

            <button
              onClick={() => handlePay(false)}
              disabled={isSubmitting}
              className="w-full cursor-pointer py-2 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
            >
              Simulate Cancelled / Card Decline
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
