'use server';

import { headers } from 'next/headers';
import { auth } from '@/auth';
import { getContainer } from '@/server/di/container';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { parseQuoteRequest } from './domain/package-quote-input';
import type { ShopResult } from './package-shop-actions';

const company = async (): Promise<string> => (await getContainer().companySettings.ensureSeeded()).id;

/** Public: a shopper asks for a quote for a package. The browser sends ids, counts and contact details; the price is worked out here. */
export async function requestPackageQuoteAction(raw: unknown): Promise<ShopResult<{ quoteNumber: string }>> {
  const session = await auth();
  const customerId = session?.user.customerStoreId ?? null;
  const parsed = parseQuoteRequest(raw, customerId === null);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    const h = await headers();
    const c = getContainer();
    const address = await c.rateLimits.hit('shop_quote_request_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
    if (!address.allowed) return { ok: false, error: waitMessage(address.retryAfterSeconds) };
    const who = parsed.input.email !== '' ? parsed.input.email : parsed.input.phone;
    if (who !== '') {
      const person = await c.rateLimits.hit('shop_quote_request_contact', who);
      if (!person.allowed) return { ok: false, error: waitMessage(person.retryAfterSeconds) };
    }
    const made = await c.packageQuoteRequests.request(await company(), customerId, parsed.input);
    return made.ok ? { ok: true, data: { quoteNumber: made.quoteNumber } } : { ok: false, error: made.error };
  } catch (error) {
    console.error('[packages] quote request', error);
    return { ok: false, error: 'We could not take your request just now. Please try again, or contact us.' };
  }
}

/** Public: the signed-in shopper's own name, email and phone, to fill the request form; null for a guest. */
export async function quoteContactAction(): Promise<ShopResult<{ name: string; email: string; phone: string } | null>> {
  const session = await auth();
  const customerId = session?.user.customerStoreId ?? null;
  if (customerId === null) return { ok: true, data: null };
  try {
    return { ok: true, data: await getContainer().packageQuoteRequests.ownContact(await company(), customerId) };
  } catch (error) {
    console.error('[packages] quote contact', error);
    return { ok: true, data: null };
  }
}
