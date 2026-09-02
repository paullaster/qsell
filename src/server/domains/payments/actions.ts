'use server';

import { revalidatePath } from 'next/cache';
import { DarajaService } from './mpesa/darajaService';
import { PesapalService } from './pesapal/pesapalService';
import { db } from '@/server/db/store';

export async function initiateDarajaStkAction(
  orderIdOrParams: string | { orderId: string; phoneNumber: string; amount?: number },
  phoneNumber?: string,
  amount?: number,
) {
  const payload =
    typeof orderIdOrParams === 'string'
      ? { orderId: orderIdOrParams, phoneNumber: phoneNumber || '', amount: amount || 0 }
      : orderIdOrParams;

  const order = db.orders.get(payload.orderId);
  const response = await DarajaService.initiateStkPush({
    orderId: payload.orderId,
    phoneNumber: payload.phoneNumber,
    amount: payload.amount || order?.totalAmount || 0,
  });
  revalidatePath('/admin/orders');
  return response;
}

export async function simulateDarajaUserAction(
  checkoutRequestId: string,
  action: 'accept' | 'cancel' | 'wrong_pin' | 'timeout',
) {
  const result = await DarajaService.simulateUserStkAction(checkoutRequestId, action);
  revalidatePath('/admin/orders');
  revalidatePath('/admin/reconciliation');
  revalidatePath('/');
  return result;
}

export async function initiatePesapalPaymentAction(
  orderIdOrParams: string | { orderId: string; amount?: number; currency?: 'KES' | 'USD' },
  amount?: number,
) {
  const payload =
    typeof orderIdOrParams === 'string'
      ? { orderId: orderIdOrParams, amount: amount || 0, currency: 'KES' as const }
      : orderIdOrParams;

  const order = db.orders.get(payload.orderId);
  const response = await PesapalService.submitOrder({
    orderId: payload.orderId,
    amount: payload.amount || order?.totalAmount || 0,
    currency: payload.currency || 'KES',
  });
  revalidatePath('/admin/orders');
  return response;
}

export const submitPesapalOrderAction = initiatePesapalPaymentAction;

export async function simulatePesapalPaymentAction(
  orderTrackingId: string,
  success: boolean,
  paymentChannel?: 'VISA' | 'MASTERCARD' | 'AIRTEL_MONEY' | 'EQUITY_BANK',
) {
  const result = await PesapalService.simulatePesapalPayment(
    orderTrackingId,
    success,
    paymentChannel,
  );
  revalidatePath('/admin/orders');
  revalidatePath('/admin/reconciliation');
  revalidatePath('/');
  return result;
}
