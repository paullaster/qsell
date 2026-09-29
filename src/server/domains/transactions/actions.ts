'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { getContainer } from '@/server/di/container';
import type { TransactionLedgerLine } from './ledger-service';

export async function listTransactionLedgerAction(): Promise<TransactionLedgerLine[]> {
  await requirePermission('transactions:read');
  const { companySettings, transactionLedger } = getContainer();
  const company = await companySettings.ensureSeeded();
  return transactionLedger.list(company.id);
}
