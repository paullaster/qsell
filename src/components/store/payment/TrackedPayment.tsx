'use client';

import { use } from 'react';
import { OrderDetailClient } from '@/components/store/account/OrderDetailClient';
import type { AccountResult } from '@/server/domains/customers/actions';
import type { CustomerOrder } from '@/lib/storefront-account';
import { PaymentRecovery } from './PaymentRecovery';

/** The order as it is (read only), with the payment choices above it, for a shopper who reached it by the link in their message. */
export function TrackedPayment({ result, token }: { result: Promise<AccountResult<CustomerOrder>>; token: string }) {
  const order = use(result);
  if (!order.ok) {
    return (
      <p role="alert" className="rounded-xl border border-line bg-surface-raised p-4 text-sm text-fg">
        {order.error}
      </p>
    );
  }
  return (
    <div className="space-y-6">
      <PaymentRecovery mode={{ kind: 'track', token }} orderNumber={order.data.orderNumber} />
      <OrderDetailClient result={result} />
    </div>
  );
}
