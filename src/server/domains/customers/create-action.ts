'use server';

import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { newCustomerPayload, type CustomerForm } from '@/lib/customer-forms';
import { isUniqueViolation, SettingsError } from '@/server/domains/settings/errors';

export interface CreatedCustomer {
  id: string;
  number: string;
  name: string;
  email: string | null;
  accountType: string;
}

/** A customer is told apart by email; the message from the rule is for the person. */
const friendly = (error: unknown): string | null => {
  if (isUniqueViolation(error)) return 'A customer with that email already exists.';
  return error instanceof Error && error.message.includes('already exists') ? error.message : null;
};

/**
 * Makes a customer from the quick form (the one the pickers link to). The form is checked again here:
 * what the browser sent is never trusted. Dimensions are left to the customer card.
 */
export async function createCustomerAction(form: CustomerForm) {
  return await runSetting(
    'customers:create',
    async ({ companyId }): Promise<CreatedCustomer> => {
      const checked = newCustomerPayload(form);
      if (!checked.ok) throw new SettingsError(checked.error);
      const row = await getContainer().customers.saveCustomer(companyId, { ...checked.payload, blocked: 'none' });
      return { id: row.id, number: row.number, name: row.name, email: row.email, accountType: row.accountType };
    },
    { paths: ['/admin/customers'], friendly },
  );
}
