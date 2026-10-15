import type { CompanySettingsRow } from '@/server/db/drizzle/schema';

/**
 * What any visitor may be told about the company: its name, address, contact, tax PIN and look.
 * Bank details are never part of it; they are read only by the people who manage the company.
 */
export type PublicCompany = Omit<CompanySettingsRow, 'bankName' | 'bankAccountName' | 'bankAccountNumber' | 'bankBranch'>;

export function toPublicCompany(row: CompanySettingsRow): PublicCompany {
  const { bankName: _bankName, bankAccountName: _bankAccountName, bankAccountNumber: _bankAccountNumber, bankBranch: _bankBranch, ...rest } = row;
  return rest;
}
