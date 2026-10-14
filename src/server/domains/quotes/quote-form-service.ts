import { getContainer } from '@/server/di/container';
import type { QuoteInput } from './service';
import { parseQuoteForm } from './template-swap-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Changes to the quote form that follow from a choice the person made, decided on the server: the
 * browser sends the form and the choice, and gets the form back. It holds none of these rules.
 */
export class QuoteFormService {
  /**
   * Chooses a trade customer (or none): their details and addresses fill the form, and paying on
   * account follows their credit account: chosen for a credit customer, and dropped when the
   * customer is cleared or has no credit.
   */
  async chooseCustomer(raw: unknown, customerId: string | null): Promise<QuoteInput> {
    const form = parseQuoteForm(raw);
    if (customerId === null) {
      return {
        ...form,
        customerId: null,
        paymentMethod: form.paymentMethod === 'on_account' ? 'mpesa_daraja' : form.paymentMethod,
      };
    }
    if (!UUID.test(customerId)) throw new Error('Choose a customer from the list.');
    const container = getContainer();
    const companyId = (await container.companySettings.ensureSeeded()).id;
    const found = await container.customers.getCustomer(companyId, customerId);
    if (found === null) throw new Error('That customer is no longer available.');
    const { customer } = found;
    const address = {
      street: customer.street ?? '',
      city: customer.city ?? '',
      countyOrState: customer.countyOrState ?? '',
      postalCode: customer.postalCode ?? '',
      country: customer.country ?? 'Kenya',
    };
    const credit = customer.accountType === 'credit';
    let paymentMethod = form.paymentMethod;
    if (credit) paymentMethod = 'on_account';
    else if (paymentMethod === 'on_account') paymentMethod = 'mpesa_daraja';
    return {
      ...form,
      customerId: customer.id,
      customerName: customer.name,
      customerEmail: customer.email ?? '',
      customerPhone: customer.phone ?? '',
      billingAddress: address,
      deliveryAddress: address,
      paymentMethod,
    };
  }
}
