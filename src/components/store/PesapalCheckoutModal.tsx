import { useState } from 'react';
import { CreditCard, ShieldCheck, X, RefreshCw, Smartphone, Landmark, CheckCircle2 } from 'lucide-react';
import { Order } from '../../types/index.js';
import { simulatePesapalPaymentAction } from '../../lib/serverActions.js';

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
  onPaymentFailed
}: PesapalCheckoutModalProps) {
  if (!isOpen || !order) return null;

  const [selectedChannel, setSelectedChannel] = useState<'VISA' | 'MASTERCARD' | 'AIRTEL_MONEY' | 'EQUITY_BANK'>('VISA');
  const [cardNumber, setCardNumber] = useState('4242 •••• •••• 4242');
  const [expiry, setExpiry] = useState('12/28');
  const [cvv, setCvv] = useState('884');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [statusText, setStatusText] = useState<string>('');

  const handlePay = async (simulateSuccess: boolean) => {
    setIsSubmitting(true);
    setStatusText('Contacting Pesapal v3.0 Gateway & Emitting IPN...');

    try {
      const res = await simulatePesapalPaymentAction(orderTrackingId, simulateSuccess, selectedChannel);
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
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/85 backdrop-blur-md p-4 flex items-center justify-center">
      <div className="relative w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-6">
        {/* Header */}
        <div className="bg-zinc-950 p-5 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <CreditCard className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white">Pesapal v3.0 Payment Portal</h3>
              <p className="text-[11px] text-zinc-400 font-mono">Tracking ID: {orderTrackingId.slice(0, 16)}...</p>
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 bg-zinc-900">
          {/* Order Summary Pill */}
          <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-between text-xs">
            <div>
              <span className="text-zinc-400 block">Total Due:</span>
              <span className="text-lg font-bold text-white font-mono">KES {order.totalAmount.toLocaleString()}</span>
            </div>
            <div className="text-right">
              <span className="text-zinc-400 block">Merchant Reference:</span>
              <span className="font-mono text-zinc-200 text-xs">{order.orderNumber}</span>
            </div>
          </div>

          {/* Payment Method Channels */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-zinc-300">Select Payment Method</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setSelectedChannel('VISA')}
                className={`p-3 rounded-lg border text-xs font-medium flex items-center gap-2 transition-all cursor-pointer ${
                  selectedChannel === 'VISA'
                    ? 'bg-indigo-950/40 border-indigo-500 text-white'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-white'
                }`}
              >
                <CreditCard className="w-4 h-4 text-indigo-400" />
                Visa / Mastercard
              </button>
              <button
                type="button"
                onClick={() => setSelectedChannel('AIRTEL_MONEY')}
                className={`p-3 rounded-lg border text-xs font-medium flex items-center gap-2 transition-all cursor-pointer ${
                  selectedChannel === 'AIRTEL_MONEY'
                    ? 'bg-indigo-950/40 border-indigo-500 text-white'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-white'
                }`}
              >
                <Smartphone className="w-4 h-4 text-rose-400" />
                Airtel Money
              </button>
              <button
                type="button"
                onClick={() => setSelectedChannel('EQUITY_BANK')}
                className={`p-3 rounded-lg border text-xs font-medium flex items-center gap-2 transition-all cursor-pointer ${
                  selectedChannel === 'EQUITY_BANK'
                    ? 'bg-indigo-950/40 border-indigo-500 text-white'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-white'
                }`}
              >
                <Landmark className="w-4 h-4 text-amber-400" />
                Equity / KCB Direct
              </button>
              <button
                type="button"
                onClick={() => setSelectedChannel('MASTERCARD')}
                className={`p-3 rounded-lg border text-xs font-medium flex items-center gap-2 transition-all cursor-pointer ${
                  selectedChannel === 'MASTERCARD'
                    ? 'bg-indigo-950/40 border-indigo-500 text-white'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-white'
                }`}
              >
                <CreditCard className="w-4 h-4 text-orange-400" />
                Mastercard 3DS
              </button>
            </div>
          </div>

          {/* Simulated Card inputs */}
          {(selectedChannel === 'VISA' || selectedChannel === 'MASTERCARD') && (
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-3">
              <div>
                <label className="text-[11px] text-zinc-400 block mb-1">Card Number</label>
                <input
                  type="text"
                  value={cardNumber}
                  onChange={(e) => setCardNumber(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-zinc-400 block mb-1">Valid Thru</label>
                  <input
                    type="text"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-zinc-400 block mb-1">CVV / CVC</label>
                  <input
                    type="password"
                    value={cvv}
                    onChange={(e) => setCvv(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>
            </div>
          )}

          {statusText && (
            <div className="p-3 rounded-lg bg-indigo-950/40 border border-indigo-500/30 text-xs text-indigo-300 text-center animate-pulse">
              {statusText}
            </div>
          )}

          {/* Action Buttons */}
          <div className="space-y-2 pt-2">
            <button
              onClick={() => handlePay(true)}
              disabled={isSubmitting}
              className="w-full py-3 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 transition-all cursor-pointer disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" /> Processing IPN...
                </>
              ) : (
                `Complete KES ${order.totalAmount.toLocaleString()} Payment`
              )}
            </button>

            <button
              onClick={() => handlePay(false)}
              disabled={isSubmitting}
              className="w-full py-2 text-zinc-500 hover:text-zinc-300 text-xs transition-colors cursor-pointer"
            >
              Simulate Cancelled / Card Decline
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
