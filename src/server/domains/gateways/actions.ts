'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { AdminService } from './service';
import type { PaymentGatewayConfig, TransactionRecord } from '@/types/index';

export async function listGatewaysAction(): Promise<PaymentGatewayConfig[]> {
  await requirePermission('payments:manage_gateways');
  return AdminService.getPaymentGateways();
}

export async function updateGatewayConfigAction(
  gatewayId: string,
  updates: Partial<PaymentGatewayConfig>,
): Promise<PaymentGatewayConfig> {
  await requirePermission('payments:manage_gateways');
  const gateway = AdminService.updatePaymentGateway(gatewayId, updates);
  revalidatePath('/admin/gateways');
  return gateway;
}

export async function listTransactionsAction(): Promise<TransactionRecord[]> {
  await requirePermission('payments:read');
  return AdminService.getAllTransactions();
}
