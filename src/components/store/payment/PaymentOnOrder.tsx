'use client';

import { use } from 'react';
import { PaymentRecovery } from '@/components/store/payment/PaymentRecovery';
import type { AccountResult } from '@/server/domains/customers/actions';
import type { CustomerOrder } from '@/lib/storefront-account';

/** The payment choices, once the order has been read: they need its number and, behind the scenes, its id. */
export function PaymentOnOrder({ result, params }: { result: Promise<AccountResult<CustomerOrder>>; params: Promise<{ id: string }> }) {
  const order = use(result);
  const { id } = use(params);
  if (!order.ok) return null;
  return <PaymentRecovery mode={{ kind: 'account', orderId: id }} orderNumber={order.data.orderNumber} />;
}
