'use client';

import { use } from 'react';
import { Chip } from '@/components/ui/screen-kit';
import type { AccountResult } from '@/server/domains/customers/actions';
import {
  formatAmount,
  formatOrderDate,
  orderStateOf,
  paymentStateOf,
  type CustomerOrder,
} from '@/lib/storefront-account';
import { has } from '@/lib/values';
import { SignInPrompt } from './SignInPrompt';

export function OrderDetailClient({ result }: { result: Promise<AccountResult<CustomerOrder>> }) {
  const answer = use(result);
  if (!answer.ok) {
    return answer.code === 'SIGN_IN' ? (
      <SignInPrompt what="this order" />
    ) : (
      <p
        role="alert"
        className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700"
      >
        {answer.error}
      </p>
    );
  }
  const order = answer.data;
  const state = orderStateOf(order.status);
  const payment = paymentStateOf(order.paymentStatus);
  const address = order.shippingAddress;
  const money = (value: number) => formatAmount(value, order.currency);
  return (
    <div className="space-y-6">
      <section
        aria-label="Order status"
        className="rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-fg-strong">Order {order.orderNumber}</h2>
          <Chip tone={state.tone}>{state.label}</Chip>
          <Chip tone={payment.tone}>{payment.label}</Chip>
        </div>
        <p className="mt-1 text-sm text-fg-muted">Placed on {formatOrderDate(order.createdAt)}</p>
        {has(state.hint) ? <p className="mt-3 text-sm text-fg">{state.hint}</p> : null}
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          {order.shippedAt === null ? null : (
            <div>
              <dt className="text-fg-subtle">Shipped</dt>
              <dd className="font-medium text-fg-strong">{formatOrderDate(order.shippedAt)}</dd>
            </div>
          )}
          {order.deliveredAt === null ? null : (
            <div>
              <dt className="text-fg-subtle">Delivered</dt>
              <dd className="font-medium text-fg-strong">{formatOrderDate(order.deliveredAt)}</dd>
            </div>
          )}
          {order.shippingCourier === null && order.trackingNumber === null ? null : (
            <div>
              <dt className="text-fg-subtle">Courier and tracking</dt>
              <dd className="font-medium break-words text-fg-strong">
                {[order.shippingCourier, order.trackingNumber].filter(has).join(' · ')}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section
        aria-label="Items"
        className="rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
      >
        <h2 className="text-lg font-semibold text-fg-strong">Items</h2>
        <ul className="mt-3 divide-y divide-line">
          {order.items.map((item, index) => (
            <li
              key={`${item.sku}-${String(index)}`}
              className="flex items-start justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="font-medium break-words text-fg-strong">{item.productName}</p>
                <p className="text-sm text-fg-muted">
                  {item.isGift ? 'Free gift · ' : ''}
                  {String(item.quantity)} × {money(item.unitPrice)}
                </p>
              </div>
              <p className="shrink-0 font-medium text-fg-strong">{money(item.totalPrice)}</p>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-fg-muted">Subtotal</dt>
            <dd>{money(order.subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-fg-muted">Tax</dt>
            <dd>{money(order.tax)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-fg-muted">Delivery</dt>
            <dd>{money(order.shippingFee)}</dd>
          </div>
          <div className="flex justify-between text-base font-semibold text-fg-strong">
            <dt>Total</dt>
            <dd>{money(order.totalAmount)}</dd>
          </div>
        </dl>
      </section>

      <section
        aria-label="Delivery address"
        className="rounded-xl border border-line bg-surface-raised p-4 sm:p-5"
      >
        <h2 className="text-lg font-semibold text-fg-strong">Delivered to</h2>
        <p className="mt-2 text-sm break-words text-fg">
          {[
            address.street,
            address.city,
            address.countyOrState,
            address.postalCode,
            address.country,
          ]
            .filter(has)
            .join(', ')}
        </p>
      </section>
    </div>
  );
}
