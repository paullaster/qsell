'use client';

import React, { useState, useEffect } from 'react';
import { Smartphone, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { type Order } from '@/types/index';
import { getPaymentAttemptStatusAction } from '@/server/actions';

interface MpesaStkModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: Order | null;
  /** payment_attempts.id */
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
  const [statusMessage, setStatusMessage] = useState('Waiting for confirmation on your phone…');
  const [secondsRemaining, setSecondsRemaining] = useState(120);

  useEffect(() => {
    if (!isOpen || !checkoutRequestId) return;
    setSecondsRemaining(120);
    setStatusMessage('STK push sent. Enter your PIN on the handset to complete payment.');

    const timer = setInterval(() => {
      setSecondsRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);

    const poll = setInterval(async () => {
      try {
        const attempt = await getPaymentAttemptStatusAction(checkoutRequestId);
        if (attempt.status === 'successful') {
          clearInterval(poll);
          clearInterval(timer);
          setStatusMessage('Payment confirmed.');
          onPaymentSuccess(attempt.receiptNumber || attempt.providerReference || 'PAID');
        } else if (attempt.status === 'failed' || attempt.status === 'cancelled') {
          clearInterval(poll);
          clearInterval(timer);
          onPaymentFailed(attempt.errorMessage || 'Payment failed');
        }
      } catch {
        /* keep polling */
      }
    }, 2500);

    return () => {
      clearInterval(timer);
      clearInterval(poll);
    };
  }, [isOpen, checkoutRequestId, onPaymentSuccess, onPaymentFailed]);

  if (!isOpen || !order) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-backdrop/80 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="relative flex min-h-dvh w-full max-w-sm flex-col overflow-hidden border border-line bg-surface shadow-2xl sm:my-4 sm:min-h-0 sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg-strong">
            <Smartphone className="h-4 w-4 text-emerald-600" />
            M-Pesa / STK
          </div>
          <button type="button" onClick={onClose} className="text-fg-subtle hover:text-fg-strong">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-5 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <RefreshCw className="h-6 w-6 animate-spin" />
          </div>
          <p className="text-sm text-fg">{statusMessage}</p>
          <p className="font-mono text-xs text-fg-subtle">
            Order {order.orderNumber} · {order.customerPhone}
          </p>
          <p className="text-[11px] text-fg-faint" role="status" aria-live="polite">
            {secondsRemaining > 0
              ? `Waiting for provider callback · ${secondsRemaining}s`
              : 'Still waiting for confirmation. Do not start another payment; this order will update when M-Pesa responds.'}
          </p>
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-fg-subtle">
            <ShieldCheck className="h-3.5 w-3.5" />
            Status updates when the network posts to your unique callback URL
          </div>
        </div>
      </div>
    </div>
  );
}
