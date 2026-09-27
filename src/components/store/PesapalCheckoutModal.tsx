'use client';

import React, { useEffect, useState } from 'react';
import { CreditCard, ShieldCheck, X, RefreshCw } from 'lucide-react';
import { type Order } from '@/types/index';
import { getPaymentAttemptStatusAction } from '@/server/actions';

interface PesapalCheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: Order | null;
  /** payment_attempts.id */
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
  const [statusText, setStatusText] = useState(
    'Complete payment in the provider window. This screen updates when the callback arrives.',
  );

  useEffect(() => {
    if (!isOpen || !orderTrackingId) return;
    setStatusText(
      'Complete payment in the provider window. This screen updates when the callback arrives.',
    );

    const poll = setInterval(async () => {
      try {
        const attempt = await getPaymentAttemptStatusAction(orderTrackingId);
        if (attempt.status === 'successful') {
          clearInterval(poll);
          setStatusText('Payment confirmed.');
          onPaymentSuccess(attempt.providerReference || orderTrackingId);
        } else if (attempt.status === 'failed' || attempt.status === 'cancelled') {
          clearInterval(poll);
          onPaymentFailed(attempt.errorMessage || 'Payment failed');
        }
      } catch {
        /* keep polling */
      }
    }, 2500);

    return () => clearInterval(poll);
  }, [isOpen, orderTrackingId, onPaymentSuccess, onPaymentFailed]);

  if (!isOpen || !order) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-backdrop/85 p-0 backdrop-blur-md sm:items-center sm:p-4">
      <div className="relative flex min-h-dvh w-full max-w-lg flex-col overflow-hidden border border-line bg-surface shadow-2xl sm:my-4 sm:min-h-0 sm:rounded-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface p-4 sm:p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-500/10 text-indigo-400">
              <CreditCard className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-fg-strong">Hosted checkout</h3>
              <p className="text-[11px] text-fg-subtle">Pesapal / Jenga — waiting for callback</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-fg-subtle hover:text-fg-strong">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-4 p-4 text-center sm:p-6">
          <RefreshCw className="mx-auto h-8 w-8 animate-spin text-indigo-400" />
          <p className="text-sm text-fg">{statusText}</p>
          <p className="font-mono text-xs text-fg-subtle">Order {order.orderNumber}</p>
          <div className="flex items-center justify-center gap-1.5 text-[10px] text-fg-subtle">
            <ShieldCheck className="h-3.5 w-3.5" />
            Do not close until payment completes or fails
          </div>
        </div>
      </div>
    </div>
  );
}
