import { required } from '@/lib/values';
import { randomUUID } from 'node:crypto';
import { getContainer } from '@/server/di/container';
import { CatalogService } from '@/server/domains/catalog/service';
import { repairsFor } from './unit-repair';
import { blankQuoteForm, parseTotalsRequest, quoteFormOf } from './quote-forms';
import { SalesQuoteService, type QuoteInput, type QuoteTemplateInput } from './service';
import { parseQuoteForm, TemplateSwapService } from './template-swap-service';
import { computeQuoteTotals, type QuoteTotals } from './totals';

/** Statuses a quote can still be edited in. */
const EDITABLE = ['draft', 'pending_approval', 'approved'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Changes to the quote form that follow from a choice the person made, decided on the server: the
 * browser sends the form and the choice, and gets the form back. It holds none of these rules.
 */
export class QuoteFormService {
  /** The form for a new quote: the company's default template if it has one, otherwise blank. */
  async startNew(): Promise<QuoteInput> {
    return (await new TemplateSwapService().defaultDraft()) ?? blankQuoteForm(new Date());
  }

  /**
   * The form for editing a saved quote, with what the editor shows beside it. A line in a unit its product no longer
   * has is shown in the base unit at the same total, and a unit whose size has changed is pointed out: both as
   * notices, in words, so nothing about the quote changes unseen.
   */
  async formFor(id: string): Promise<{
    form: QuoteInput;
    quoteNumber: string;
    notices: { line: number; message: string }[];
  }> {
    const quote = await new SalesQuoteService().get(id);
    if (quote === null) throw new Error('Quote not found.');
    if (!EDITABLE.includes(quote.status))
      throw new Error('Only draft or approved quotes can be edited.');
    const form = quoteFormOf(quote, randomUUID);
    const repairs = await repairsFor(
      quote.lines
        .filter((line) => !line.isGift)
        .map((line) => ({
          productId: line.productId,
          unitId: line.unitId ?? null,
          unitCode: line.unitCode ?? null,
          enteredQuantity: line.enteredQuantity ?? null,
          qtyPerUnit: line.qtyPerUnit ?? null,
          quantity: Number(line.quantity),
          unitPrice: Number(line.unitPrice),
        })),
    );
    return {
      form: {
        ...form,
        lines: form.lines.map((line, i) => {
          const to = repairs[i]?.to;
          return to === undefined
            ? line
            : { ...line, quantity: to.quantity, unitPrice: to.unitPrice, unitId: null, unitCode: null };
        }),
      },
      quoteNumber: quote.quoteNumber,
      notices: repairs.flatMap((r, line) => (r === null ? [] : [{ line, message: r.message }])),
    };
  }

  /**
   * What the quote being typed comes to, worked out here from the catalogue and the kits and
   * measured against the company's margin floor. The browser sends only what is typed.
   */
  async previewTotals(raw: unknown): Promise<QuoteTotals> {
    const request = parseTotalsRequest(raw);
    const ids = [...new Set(request.lines.map((line) => line.productId))];
    const container = getContainer();
    const companyId = (await container.companySettings.ensureSeeded()).id;
    const [products, kits, settings] = await Promise.all([
      CatalogService.getProductsByIds(ids),
      container.kits.forProducts(companyId, ids),
      new SalesQuoteService().getSettings(companyId),
    ]);
    const byId = new Map(products.map((product) => [product.id, product]));
    // Lines typed in another unit (3 crates) are worked out in the product's base unit, as saving does.
    const unitLines = await container.unitWriter.convertLines(
      byId,
      request.lines.map((line) => ({ productId: line.productId, quantity: line.quantity, unitId: line.unitId, unitPrice: line.unitPrice })),
    );
    return computeQuoteTotals(
      {
        ...request,
        lines: request.lines.map((line, i) => {
          const unit = required(unitLines[i], 'the unit of a line');
          const { unitId: _unitId, ...rest } = line;
          return {
            ...rest,
            quantity: unit.quantity,
            ...(unit.unitPrice === undefined ? {} : { unitPrice: unit.unitPrice }),
            ...(unit.enteredUnitPrice !== null && unit.enteredQuantity !== null ? { exactAmount: unit.enteredUnitPrice * unit.enteredQuantity } : {}),
          };
        }),
      },
      byId,
      kits,
      Number(settings.minimumGrossMarginPercent),
    );
  }

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

  /**
   * The same choice on a quote template's form: the customer's addresses become the template's
   * defaults, and a credit customer puts it on account (or takes it off, when cleared).
   */
  async chooseTemplateCustomer(
    raw: unknown,
    customerId: string | null,
  ): Promise<QuoteTemplateInput> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('Invalid template.');
    }
    const form = raw as QuoteTemplateInput;
    if (customerId === null) {
      return {
        ...form,
        customerId: null,
        customerName: null,
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
    let paymentMethod = form.paymentMethod;
    if (customer.accountType === 'credit') paymentMethod = 'on_account';
    else if (paymentMethod === 'on_account') paymentMethod = 'mpesa_daraja';
    return {
      ...form,
      customerId: customer.id,
      customerName: customer.name,
      billingAddress: address,
      deliveryAddress: address,
      paymentMethod,
    };
  }
}
