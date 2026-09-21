'use server';

import { getContainer } from '@/server/di/container';
import type { TransactionLedgerLine } from './ledger-service';

export async function listTransactionLedgerAction(): Promise<TransactionLedgerLine[]> {
  const { companySettings, transactionLedger } = getContainer();
  const company = await companySettings.ensureSeeded();
  return transactionLedger.list(company.id);
}
