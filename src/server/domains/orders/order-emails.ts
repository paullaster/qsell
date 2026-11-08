import { getContainer } from '@/server/di/container';
import { layout } from '@/server/domains/auth/emails';
import { resolvePublicBaseUrl } from '@/server/domains/auth/account-service';
import { isOrderEmailKind, orderEmailContent, usableEmail } from '@/lib/order-emails';
import { shownPaymentReference } from '@/lib/paymentReference';
import { formatCartAmount, resolveBaseCurrency } from '@/lib/cartMoney';
import { listCurrenciesAction } from '@/server/domains/currencies/actions';
import { orElse } from '@/lib/values';

const PAYMENT_WORDS: Record<string, string> = { mpesa_daraja: 'M-Pesa', kcb_buni: 'KCB Buni', pesapal_v3: 'Card or bank', card_direct: 'Card', jenga_hq: 'Bank', on_account: 'On account', pay_on_delivery: 'Pay on delivery' };

function payLaterOf(method: string): 'account' | 'door' | null {
  if (method === 'on_account') return 'account';
  return method === 'pay_on_delivery' ? 'door' : null;
}

/**
 * Writes to the shopper about their order: that it was placed, or that its payment was received. The job that calls this is retried
 * by the worker, so a mail server that is down only delays it. Sends at most the one mail for each order and kind (the job key).
 * Returns what happened, for the log.
 */
export async function sendOrderEmail(orderId: string, kind: string): Promise<'sent' | 'no_address' | 'gone'> {
  if (!isOrderEmailKind(kind)) return 'gone';
  const c = getContainer();
  const order = await c.orders.getById(orderId);
  // Staff-placed orders are the business's own paperwork; this mail is the shop's.
  if (order?.salesModule !== 'ecommerce') return 'gone';
  const to = usableEmail(order.customerEmail);
  if (to === null) return 'no_address';
  const settings = await c.companySettings.ensureSeeded();
  const base = resolvePublicBaseUrl(settings.publicBaseUrl);
  const token = await c.trackingLinks.tokenFor(settings.id, order.id);
  const trackUrl = token === null ? `${base}/` : `${base}/track/${token}`;
  let currency: ReturnType<typeof resolveBaseCurrency> = null;
  try {
    currency = resolveBaseCurrency(await listCurrenciesAction());
  } catch {
    currency = null;
  }
  const money = (amount: number): string => formatCartAmount(amount, currency);
  const content = orderEmailContent(kind, {
    tradingName: orElse(settings.tradingName, 'our shop'),
    customerName: order.customerName,
    orderNumber: order.orderNumber,
    lines: order.items.filter((i) => i.isGift !== true).map((i) => ({ name: i.productName, quantity: String(i.quantity), amount: money(i.totalPrice) })),
    subtotal: money(order.subtotal),
    tax: money(order.tax),
    shipping: order.shippingFee > 0 ? money(order.shippingFee) : null,
    total: money(order.totalAmount),
    paymentWords: PAYMENT_WORDS[order.paymentMethod] ?? 'Online payment',
    reference: orElse(shownPaymentReference(order), '') === '' ? null : shownPaymentReference(order),
    payLater: payLaterOf(order.paymentMethod),
    trackUrl,
  });
  const footer = `You are receiving this because you placed order ${order.orderNumber}. Please do not forward it: the link shows your order.`;
  const html = layout({ heading: content.heading, greeting: content.greeting, body: content.body, cta: content.cta, actionUrl: trackUrl, footer, details: content.details });
  const text = `${content.heading}\n\n${content.greeting}\n\n${content.body}\n\n${content.details.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${content.cta}: ${trackUrl}\n\n${footer}`;
  await c.email.send({ to, subject: content.subject, html, text });
  return 'sent';
}
