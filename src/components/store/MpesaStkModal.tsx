import React, { useState, useEffect } from 'react';
import { Smartphone, CheckCircle2, XCircle, AlertCircle, RefreshCw, Lock, ShieldCheck, X } from 'lucide-react';
import { Order } from '../../types/index.js';
import { simulateDarajaUserAction } from '../../lib/serverActions.js';

interface MpesaStkModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: Order | null;
  checkoutRequestId: string;
  onPaymentSuccess: (receipt: string) => void;
  onPaymentFailed: (error: string) => void;
}

export function MpesaStkModal({
  isOpen,
  onClose,
  order,
  checkoutRequestId,
  onPaymentSuccess,
  onPaymentFailed
}: MpesaStkModalProps) {
  if (!isOpen || !order) return null;

  const [pin, setPin] = useState<string>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(30);
  const [statusMessage, setStatusMessage] = useState<string>('Awaiting M-Pesa PIN on handset...');

  useEffect(() => {
    if (!isOpen) return;
    setSecondsRemaining(30);
    setPin('');
    setIsProcessing(false);
    setStatusMessage('STK Push dispatched. Enter your Safaricom PIN below or simulate action:');

    const timer = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isOpen]);

  const handleSimulate = async (action: 'accept' | 'cancel' | 'wrong_pin' | 'timeout') => {
    setIsProcessing(true);
    setStatusMessage(
      action === 'accept'
        ? 'PIN verified! Safaricom Daraja is firing webhook callback...'
        : `Simulating ${action}...`
    );

    try {
      const res = await simulateDarajaUserAction(checkoutRequestId, action);
      if (res.status === 'successful') {
        setStatusMessage(`Payment Verified! M-Pesa Receipt: ${res.receipt}`);
        setTimeout(() => {
          onPaymentSuccess(res.receipt);
        }, 1200);
      } else {
        setStatusMessage(`Payment declined: ${res.error}`);
        setTimeout(() => {
          onPaymentFailed(res.error || 'Payment failed');
        }, 1500);
      }
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message}`);
      setIsProcessing(false);
    }
  };

  const handlePinKey = (num: string) => {
    if (pin.length < 4) {
      const newPin = pin + num;
      setPin(newPin);
      if (newPin.length === 4) {
        handleSimulate('accept');
      }
    }
  };

  const handleBackspace = () => {
    setPin(pin.slice(0, -1));
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/85 backdrop-blur-md p-4 flex items-center justify-center">
      <div className="relative w-full max-w-sm bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-6">
        {/* Smartphone Frame Top Notch */}
        <div className="bg-zinc-900 px-4 py-3 flex items-center justify-between border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
            <span className="text-[11px] font-mono text-emerald-400 font-bold uppercase tracking-wider">
              Safaricom M-Pesa
            </span>
          </div>
          <div className="text-[11px] font-mono text-zinc-400">
            00:{secondsRemaining < 10 ? `0${secondsRemaining}` : secondsRemaining}
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-white cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Realistic Safaricom STK Dialog Screen */}
        <div className="p-6 bg-zinc-900/90 text-zinc-100 flex flex-col items-center text-center space-y-4">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shadow-lg">
            <Smartphone className="w-6 h-6 animate-pulse" />
          </div>

          <div className="space-y-1">
            <h3 className="font-bold text-sm text-white">Do you want to pay?</h3>
            <p className="text-xs text-zinc-300 font-medium">
              OMNICOMMERCE (Paybill 174379)
            </p>
            <div className="text-lg font-mono font-bold text-white pt-1">
              KES {order.totalAmount.toLocaleString()}
            </div>
            <p className="text-[10px] text-zinc-500 font-mono">
              Account: {order.orderNumber}
            </p>
          </div>

          {/* PIN Input dots */}
          <div className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-2">
            <span className="text-[11px] text-zinc-400 block font-medium">
              Enter 4-digit M-Pesa PIN:
            </span>
            <div className="flex justify-center gap-3">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={`w-3.5 h-3.5 rounded-full border transition-all ${
                    pin.length > i
                      ? 'bg-emerald-400 border-emerald-300 scale-110 shadow-sm shadow-emerald-400'
                      : 'border-zinc-700 bg-zinc-900'
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Status Message */}
          <div className="text-xs font-medium text-zinc-300 min-h-[32px] flex items-center justify-center">
            {isProcessing ? (
              <span className="flex items-center gap-1.5 text-emerald-400 animate-pulse">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" /> {statusMessage}
              </span>
            ) : (
              <span className="text-zinc-400">{statusMessage}</span>
            )}
          </div>

          {/* Numeric Keypad Simulation */}
          <div className="grid grid-cols-3 gap-2 w-full pt-1">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
              <button
                key={num}
                onClick={() => handlePinKey(num)}
                disabled={isProcessing || pin.length >= 4}
                className="py-2.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-white font-mono text-sm font-semibold border border-zinc-800 active:scale-95 transition-all cursor-pointer disabled:opacity-40"
              >
                {num}
              </button>
            ))}
            <button
              onClick={() => handleSimulate('cancel')}
              disabled={isProcessing}
              className="py-2 rounded-lg bg-red-950/60 hover:bg-red-900 text-red-300 text-xs font-semibold border border-red-800/80 active:scale-95 transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => handlePinKey('0')}
              disabled={isProcessing || pin.length >= 4}
              className="py-2.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-white font-mono text-sm font-semibold border border-zinc-800 active:scale-95 transition-all cursor-pointer disabled:opacity-40"
            >
              0
            </button>
            <button
              onClick={handleBackspace}
              disabled={isProcessing || pin.length === 0}
              className="py-2 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-zinc-400 text-xs font-semibold border border-zinc-800 active:scale-95 transition-all cursor-pointer disabled:opacity-40"
            >
              ⌫
            </button>
          </div>

          {/* Quick Demo Simulation Triggers */}
          <div className="w-full pt-3 border-t border-zinc-800 space-y-2">
            <span className="text-[10px] text-zinc-500 uppercase font-mono tracking-wider block">
              Demo Simulation Options
            </span>
            <div className="grid grid-cols-2 gap-1.5 text-[11px]">
              <button
                onClick={() => handleSimulate('accept')}
                disabled={isProcessing}
                className="py-1.5 px-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition-colors cursor-pointer"
              >
                ✓ Fast Authorize
              </button>
              <button
                onClick={() => handleSimulate('wrong_pin')}
                disabled={isProcessing}
                className="py-1.5 px-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium transition-colors cursor-pointer"
              >
                Wrong PIN Test
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
