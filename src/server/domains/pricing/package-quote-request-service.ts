import { and, eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers } from '@/server/db/drizzle/schema';
import { SalesQuoteService } from '@/server/domains/quotes/service';
import { allowsQuote } from './domain/package-order-mode';
import { isCalendarDay, type QuoteRequestInput } from './domain/package-quote-input';
import { storedPicks } from './domain/package-shop';
import type { PackageOrderService } from './package-order-service';
import type { PackageShopService } from './package-shop-service';

export type QuoteRequestOutcome = { ok: true; quoteNumber: string; total: number } | { ok: false; error: string };

/** The id kept as the maker of a quote a shopper asked for (no staff member made it). */
export const SHOP_REQUEST_ACTOR = 'shop-request';

/**
 * A shopper asks for a quote for a package instead of ordering it. The choices are checked and priced from the package as it is now
 * (the browser's word is only ids and counts), the quote is made as an ordinary draft marked as coming from the shop, so staff see it in
 * Quotes, adjust it if the deal needs it, and send it; the customer then accepts it through the usual link and it becomes an order.
 * A quote promises nothing from the shelves, so stock is not looked at here.
 */
export class PackageQuoteRequestService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly shop: PackageShopService,
    private readonly orders: PackageOrderService,
    private readonly quotes: SalesQuoteService = new SalesQuoteService(),
  ) {}

  async request(companyId: string, customerId: string | null, input: QuoteRequestInput, now: Date = new Date()): Promise<QuoteRequestOutcome> {
    const builder = await this.shop.builder(companyId, input.line.productId);
    if (builder === null) return { ok: false, error: 'That package is not available right now.' };
    if (!allowsQuote(builder.package.orderMode)) return { ok: false, error: `${builder.package.name} is ordered through the cart, not by quote.` };
    if (input.neededOn !== '' && (!isCalendarDay(input.neededOn) || input.neededOn < now.toISOString().slice(0, 10))) return { ok: false, error: 'Choose a day that has not passed.' };

    const contact = await this.contact(companyId, customerId, input);
    if (!contact.ok) return contact;

    // The same check the quote itself makes, so a choice the package does not offer is refused here in plain words.
    const stored = storedPicks(builder.package, input.line.picks);
    const prepared = await this.orders.prepareStored(
      { companyId, customerGroupId: null, signedIn: customerId !== null, forDate: null, now, previewOnly: true, skipStock: true },
      [{ index: 0, productId: input.line.productId, servings: input.line.servings, stored, ...(input.line.note === undefined ? {} : { note: input.line.note }) }],
    );
    if (!prepared.ok) return { ok: false, error: prepared.error };
    const line = prepared.lines[0];
    if (line === undefined) return { ok: false, error: 'Please check your choices.' };

    const quote = await this.quotes.create(SHOP_REQUEST_ACTOR, {
      customerId,
      customerName: contact.name,
      customerEmail: contact.email === '' ? null : contact.email,
      customerPhone: contact.phone === '' ? null : contact.phone,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      discountPercent: 0,
      shippingFee: 0,
      sections: [],
      source: 'shop',
      neededOn: input.neededOn === '' ? null : input.neededOn,
      internalNotes: input.message === '' ? 'Requested on the web shop.' : `Requested on the web shop. The customer wrote: ${input.message}`,
      lines: [{ productId: input.line.productId, quantity: input.line.servings, discountPercent: 0, package: { picks: line.stored, ...(line.note === '' ? {} : { note: line.note }), summary: line.summary } }],
    });
    return { ok: true, quoteNumber: quote.quoteNumber, total: Number(quote.totalAmount) };
  }

  /** A signed-in shopper's own details, to fill the form with; null when there is no such customer. */
  async ownContact(companyId: string, customerId: string): Promise<{ name: string; email: string; phone: string } | null> {
    const [own] = await this.db.select({ name: customers.name, email: customers.email, phone: customers.phone }).from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId))).limit(1);
    return own === undefined ? null : { name: own.name, email: own.email ?? '', phone: own.phone ?? '' };
  }

  /** Who the quote is for: a signed-in shopper's own record fills what they left blank; a guest must have given a name and a way to answer. */
  private async contact(companyId: string, customerId: string | null, input: QuoteRequestInput): Promise<{ ok: true; name: string; email: string; phone: string } | { ok: false; error: string }> {
    let { name, email, phone } = input;
    if (customerId !== null) {
      const own = await this.ownContact(companyId, customerId);
      if (own === null) return { ok: false, error: 'Your account could not be found. Please sign in again.' };
      name = name === '' ? own.name : name;
      email = email === '' ? own.email : email;
      phone = phone === '' ? own.phone : phone;
    }
    if (name === '') return { ok: false, error: 'Please tell us your name.' };
    if (email === '' && phone === '') return { ok: false, error: 'Give an email address or a phone number so we can send the quote.' };
    return { ok: true, name, email, phone };
  }
}
