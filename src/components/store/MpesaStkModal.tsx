'use client';

import React, { useState, useEffect } from 'react';
import {
  Smartphone,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  Lock,
  ShieldCheck,
  X,
} from 'lucide-react';
import { type Order } from '@/types/index';
import { simulateDarajaUserAction } from '@/server/actions';

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
  onPaymentFailed,
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
        : `Simulating ${action}...`,
    );

    try {
      const res = await simulateDarajaUserAction(checkoutRequestId, action);
      if (res.status === 'successful') {
        const receipt = String(res.receipt || 'RECEIPT');
        setStatusMessage(`Payment Verified! M-Pesa Receipt: ${receipt}`);
        setTimeout(() => {
          onPaymentSuccess(receipt);
        }, 1200);
      } else {
        const errMsg = String(res.error || 'Payment failed');
        setStatusMessage(`Payment declined: ${errMsg}`);
        setTimeout(() => {
          onPaymentFailed(errMsg);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/85 p-4 backdrop-blur-md">
      <div className="relative my-6 flex w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        {/* Smartphone Frame Top Notch */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 animate-ping rounded-full bg-emerald-400" />
            <span className="font-mono text-[11px] font-bold tracking-wider text-emerald-400 uppercase">
              Safaricom M-Pesa
            </span>
          </div>
          <div className="font-mono text-[11px] text-zinc-400">
            00:{secondsRemaining < 10 ? `0${secondsRemaining}` : secondsRemaining}
          </div>
          <button onClick={onClose} className="cursor-pointer text-zinc-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Realistic Safaricom STK Dialog Screen */}
        <div className="flex flex-col items-center space-y-4 bg-zinc-900/90 p-6 text-center text-zinc-100">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 shadow-lg">
            <Smartphone className="h-6 w-6 animate-pulse" />
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-bold text-white">Do you want to pay?</h3>
            <p className="text-xs font-medium text-zinc-300">OMNICOMMERCE (Paybill 174379)</p>
            <div className="pt-1 font-mono text-lg font-bold text-white">
              KES {order.totalAmount.toLocaleString()}
            </div>
            <p className="font-mono text-[10px] text-zinc-500">Account: {order.orderNumber}</p>
          </div>

          {/* PIN Input dots */}
          <div className="w-full space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <span className="block text-[11px] font-medium text-zinc-400">
              Enter 4-digit M-Pesa PIN:
            </span>
            <div className="flex justify-center gap-3">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={`h-3.5 w-3.5 rounded-full border transition-all ${
                    pin.length > i
                      ? 'scale-110 border-emerald-300 bg-emerald-400 shadow-sm shadow-emerald-400'
                      : 'border-zinc-700 bg-zinc-900'
                  }`}
                />
              ))}
            </div>
          </div>

          {/* Status Message */}
          <div className="flex min-h-[32px] items-center justify-center text-xs font-medium text-zinc-300">
            {isProcessing ? (
              <span className="flex animate-pulse items-center gap-1.5 text-emerald-400">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" /> {statusMessage}
              </span>
            ) : (
              <span className="text-zinc-400">{statusMessage}</span>
            )}
          </div>

          {/* Numeric Keypad Simulation */}
          <div className="grid w-full grid-cols-3 gap-2 pt-1">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((num) => (
              <button
                key={num}
                onClick={() => handlePinKey(num)}
                disabled={isProcessing || pin.length >= 4}
                className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950 py-2.5 font-mono text-sm font-semibold text-white transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
              >
                {num}
              </button>
            ))}
            <button
              onClick={() => handleSimulate('cancel')}
              disabled={isProcessing}
              className="cursor-pointer rounded-lg border border-red-800/80 bg-red-950/60 py-2 text-xs font-semibold text-red-300 transition-all hover:bg-red-900 active:scale-95"
            >
              Cancel
            </button>
            <button
              onClick={() => handlePinKey('0')}
              disabled={isProcessing || pin.length >= 4}
              className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950 py-2.5 font-mono text-sm font-semibold text-white transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
            >
              0
            </button>
            <button
              onClick={handleBackspace}
              disabled={isProcessing || pin.length === 0}
              className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-950 py-2 text-xs font-semibold text-zinc-400 transition-all hover:bg-zinc-800 active:scale-95 disabled:opacity-40"
            >
              ⌫
            </button>
          </div>

          {/* Quick Demo Simulation Triggers */}
          <div className="w-full space-y-2 border-t border-zinc-800 pt-3">
            <span className="block font-mono text-[10px] tracking-wider text-zinc-500 uppercase">
              Demo Simulation Options
            </span>
            <div className="grid grid-cols-2 gap-1.5 text-[11px]">
              <button
                onClick={() => handleSimulate('accept')}
                disabled={isProcessing}
                className="cursor-pointer rounded-lg bg-emerald-600 px-2 py-1.5 font-semibold text-white transition-colors hover:bg-emerald-500"
              >
                ✓ Fast Authorize
              </button>
              <button
                onClick={() => handleSimulate('wrong_pin')}
                disabled={isProcessing}
                className="cursor-pointer rounded-lg bg-zinc-800 px-2 py-1.5 font-medium text-zinc-300 transition-colors hover:bg-zinc-700"
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
