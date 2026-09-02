'use server';

import { revalidatePath } from 'next/cache';
import { AdminService } from './service';
import type { PaymentGatewayConfig, TransactionRecord } from '@/types/index';

export async function listGatewaysAction(): Promise<PaymentGatewayConfig[]> {
  return AdminService.getPaymentGateways();
}

export async function updateGatewayConfigAction(
  gatewayId: string,
  updates: Partial<PaymentGatewayConfig>,
): Promise<PaymentGatewayConfig> {
  const gateway = AdminService.updatePaymentGateway(gatewayId, updates);
  revalidatePath('/admin/gateways');
  return gateway;
}

export async function listTransactionsAction(): Promise<TransactionRecord[]> {
  return AdminService.getAllTransactions();
}
