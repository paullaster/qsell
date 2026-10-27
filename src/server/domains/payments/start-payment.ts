import { getContainer } from '@/server/di/container';
import type { StageSource } from '@/lib/order-stages';
import { amountDue } from '@/server/domains/orders/amount-due';
import { paymentUsesPhone } from '@/lib/payment-phone';
import { toKenyanMsisdn } from '@/lib/phone';
import { has, orElse } from '@/lib/values';
import type { PaymentProviderCode } from './types';

export interface StartedPayment {
  attemptId: string;
  status: string;
  redirectUrl?: string | null;
  customerMessage?: string;
  errorMessage?: string | null;
}

/**
 * Starts a payment for an order. This is server code, not an action a browser can call: `payerPhone` is the number the
 * prompt is sent to, and it is only ever passed by code that has already checked it (the checkout). If none is passed the
 * number the order already holds is used, so a public action can never point a prompt at a number of the caller's choosing.
 *
 * The number used is written on the payment attempt, and on the order when the method works through a phone.
 */
export async function startOrderPayment(input: { orderId: string; providerCode: PaymentProviderCode; payerPhone?: string | null; source?: StageSource }): Promise<StartedPayment> {
  const { companySettings, organizations, payments, orders } = getContainer();
  const company = await companySettings.ensureSeeded();
  const { branch } = await organizations.ensureDefaultOrgAndBranch(company.id, orElse(company.tradingName, company.legalName));
  const order = await orders.getById(input.orderId);
  if (!order) throw new Error('Order not found');
  if (amountDue(order) <= 0) throw new Error('Nothing is left to pay on this order.');

  const usesPhone = paymentUsesPhone(input.providerCode);
  const chosen = has(input.payerPhone) ? input.payerPhone : null;
  const phone = usesPhone ? (toKenyanMsisdn(chosen ?? order.paymentPhone ?? order.customerPhone) ?? orElse(order.customerPhone, '')) : (chosen ?? order.customerPhone);

  const { attempt, result } = await payments.initiatePayment({
    branch,
    providerCode: input.providerCode,
    orderId: order.id,
    orderNumber: order.orderNumber,
    amount: amountDue(order),
    currency: order.currency,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: phone,
    recordPhone: usesPhone || chosen !== null ? toKenyanMsisdn(phone) : null,
    ...(input.source === undefined ? {} : { stageSource: input.source }),
    description: `Order ${order.orderNumber}`,
  });
  return {
    attemptId: attempt.id,
    status: attempt.status,
    redirectUrl: attempt.redirectUrl,
    customerMessage: result.customerMessage,
    errorMessage: attempt.errorMessage,
  };
}
