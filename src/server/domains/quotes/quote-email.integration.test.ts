import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { has, nth } from '@/lib/values';
import type * as mod_client from '@/server/db/drizzle/client';
import type * as mod_schema from '@/server/db/drizzle/schema';
import type * as mod_service from './service';
import type * as mod_container from '@/server/di/container';
import { NodemailerSmtpAdapter } from '@/server/adapters/email/nodemailer.adapter';
import type { SenderConfig } from '@/server/adapters/email/sender';

/**
 * A quote sent to a customer, from the quote service through the SMTP adapter to what the mail server is handed. Mail servers differ
 * on what From they accept, so the instance's settings decide it, and the company's own address is never made up.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('sending a quote by email (database)', () => {
  let db: typeof mod_client.drizzleDb;
  let schema: typeof mod_schema;
  let c: ReturnType<typeof mod_container.getContainer>;
  let svc: mod_service.SalesQuoteService;
  let userId: string;
  let itemTypeId: string;
  let companyId: string;
  let originalEmail: string;
  let tradingName: string;
  let handedToServer: ReturnType<typeof vi.fn>;
  let spy: { mockRestore: () => void };
  let sender: SenderConfig;

  const company = async (email: string) => {
    await db.update(schema.companySettings).set({ email }).where(eq(schema.companySettings.id, companyId));
  };

  const quote = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `T-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `TS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Mailed', slug: `t-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50', taxRate: '0', isTaxInclusive: true, stockQuantity: 100 });
    const customerEmail = `${randomUUID()}@customer.test`;
    const made = await svc.create(userId, {
      customerName: 'Mailed Buyer',
      customerEmail,
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      discountPercent: 0,
      shippingFee: 0,
      deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' },
      sections: [],
      lines: [{ productId: id, quantity: 1, unitPrice: 100, discountPercent: 0 }],
      ...over,
    } as never);
    return { made, customerEmail };
  };

  /** What the mail server was handed for the last mail. */
  const handed = () => nth(handedToServer.mock.calls, handedToServer.mock.calls.length - 1)[0] as Record<string, unknown>;

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    const settings = await c.companySettings.ensureSeeded();
    companyId = settings.id;
    originalEmail = settings.email;
    tradingName = (await c.companySettings.getProfile()).tradingName;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_t_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Mail Co');
    userId = nth(await db.insert(schema.users).values({ email: `t-${randomUUID()}@t.test`, passwordHash: 'x', name: 'Sender', role: 'manager' }).returning(), 0).id;
    const { SalesQuoteService } = await import('./service');
    svc = new SalesQuoteService();

    handedToServer = vi.fn().mockResolvedValue({ messageId: '<sent@mail.test>' });
    sender = { mailbox: 'mailer@mail.test', fromName: null, policy: 'mailbox' };
    // The quote goes through the real SMTP adapter; only the connection to a mail server is replaced.
    spy = vi.spyOn(c.email, 'send').mockImplementation((message) => new NodemailerSmtpAdapter({ transporter: { sendMail: handedToServer as never }, sender }).send(message));
  });

  afterAll(async () => {
    spy.mockRestore();
    await company(originalEmail);
  });

  it('goes out as the instance’s mailbox in the company’s name, with answers to the company, on a server that ties From to the login', async () => {
    await company('sales@acme-trading.test');
    sender = { mailbox: 'mailer@mail.test', fromName: null, policy: 'mailbox' };
    const { made, customerEmail } = await quote();
    const sent = await svc.send(userId, made.id);
    expect(sent?.status).toBe('sent');
    expect(handed()).toMatchObject({
      from: `"${tradingName}" <mailer@mail.test>`,
      replyTo: 'sales@acme-trading.test',
      envelope: { from: 'mailer@mail.test', to: [customerEmail] },
      to: customerEmail,
    });
    expect(handed()).not.toHaveProperty('sender');
    expect(String(handed().from)).not.toMatch(/Sales|Billing/);
  });

  it('goes out as the company’s own address, naming the mailbox as sender, on a server that accepts another From', async () => {
    await company('sales@acme-trading.test');
    sender = { mailbox: 'mailer@mail.test', fromName: null, policy: 'business' };
    const { made, customerEmail } = await quote();
    await svc.send(userId, made.id);
    expect(handed()).toMatchObject({
      from: `"${tradingName}" <sales@acme-trading.test>`,
      sender: 'mailer@mail.test',
      envelope: { from: 'mailer@mail.test', to: [customerEmail] },
    });
  });

  it('never sends as, or asks answers to, an address the company has not really given', async () => {
    await company('admin@localhost');
    for (const policy of ['mailbox', 'business'] as const) {
      sender = { mailbox: 'mailer@mail.test', fromName: null, policy };
      const { made } = await quote();
      await svc.send(userId, made.id);
      expect(handed().from, policy).toBe(`"${tradingName}" <mailer@mail.test>`);
      expect(handed(), policy).not.toHaveProperty('replyTo');
      expect(handed(), policy).not.toHaveProperty('sender');
    }
  });

  it('keeps the quote a draft and says in words what to change when the mail server refuses the sender', async () => {
    await company('sales@acme-trading.test');
    sender = { mailbox: 'mailer@mail.test', fromName: null, policy: 'business' };
    handedToServer.mockRejectedValueOnce(Object.assign(new Error('553 5.7.1 Sender address rejected: not owned by user'), { responseCode: 553, command: 'MAIL FROM', response: '553 5.7.1 Sender address rejected: not owned by user' }));
    const { made } = await quote();
    await expect(svc.send(userId, made.id)).rejects.toThrow(/EMAIL_FROM_POLICY=mailbox/);
    const [row] = await db.select({ status: schema.salesQuotes.status }).from(schema.salesQuotes).where(eq(schema.salesQuotes.id, made.id));
    expect(row?.status).toBe('draft');
  });
  it('records who made the quote and who emailed it, by name, in the list and on the quote', async () => {
    await company('sales@acme-trading.test');
    sender = { mailbox: 'mailer@mail.test', fromName: null, policy: 'mailbox' };
    const { made } = await quote();
    const other = nth(await db.insert(schema.users).values({ email: `s-${randomUUID()}@t.test`, passwordHash: 'x', name: 'Second Sender', role: 'manager' }).returning(), 0);

    const before = await svc.get(made.id);
    expect(before).toMatchObject({ createdByName: 'Sender', sentBy: null, sentByName: null });

    await svc.send(other.id, made.id);
    const after = await svc.get(made.id);
    expect(after).toMatchObject({ createdByName: 'Sender', sentBy: other.id, sentByName: 'Second Sender' });

    const page = await svc.listPage({ query: made.quoteNumber, status: 'all', limit: 5, after: null });
    expect(page.rows.at(0)).toMatchObject({ createdByName: 'Sender', sentByName: 'Second Sender' });
  });

  it('shows the customer details unless someone hides them', async () => {
    const { made } = await quote();
    expect(made.showBillingAddress).toBe(true);
    const hiddenInput = { customerName: 'Hidden Buyer', customerEmail: 'h@customer.test', currency: 'KES', paymentMethod: 'mpesa_daraja', discountPercent: 0, shippingFee: 0, deliveryAddress: { street: '1', city: 'N', countyOrState: 'N', country: 'KE' }, showBillingAddress: false, sections: [], lines: [] };
    const productId = (await svc.get(made.id))?.lines.at(0)?.productId;
    const hidden = await svc.create(userId, { ...hiddenInput, lines: [{ productId, quantity: 1, unitPrice: 100, discountPercent: 0 }] } as never);
    expect(hidden.showBillingAddress).toBe(false);
  });

  it('goes to the people set up in Email routing: several to, a copy for the sender, a blind copy, and answers to a chosen address', async () => {
    await company('sales@acme-trading.test');
    sender = { mailbox: 'mailer@mail.test', fromName: null, policy: 'mailbox' };
    const colleague = nth(await db.insert(schema.users).values({ email: `c-${randomUUID()}@t.test`, passwordHash: 'x', name: 'Colleague', role: 'manager' }).returning(), 0);
    const actor = { type: 'user' as const, id: 'quote-email-test' };
    await c.emailRoutes.save(companyId, 'quote_sent', { enabled: true, to: [{ kind: 'customer' }, { kind: 'staff', userId: colleague.id }], cc: [{ kind: 'actor' }], bcc: [{ kind: 'company' }], replyTo: [{ kind: 'address', address: 'accounts@acme-trading.test' }, { kind: 'staff', userId: colleague.id }] }, actor, { code: 'POLICY_CHANGE' });
    try {
      const { made, customerEmail } = await quote();
      await svc.send(userId, made.id);
      const sent = handed();
      expect(sent.to).toEqual([customerEmail, colleague.email]);
      expect(sent.cc).toEqual([(await db.select().from(schema.users).where(eq(schema.users.id, userId)))[0]?.email]);
      expect(sent.bcc).toEqual(['sales@acme-trading.test']);
      expect(sent.replyTo).toBe(`accounts@acme-trading.test, ${colleague.email}`);
      const event = (await svc.get(made.id))?.events.find((e) => e.eventType === 'sent');
      expect(JSON.stringify(event?.details)).toContain(colleague.email);
    } finally {
      await c.emailRoutes.reset(companyId, 'quote_sent', actor, { code: 'POLICY_CHANGE' });
    }
  });

  it('is not sent when Email routing has switched quote emails off, and says so', async () => {
    const actor = { type: 'user' as const, id: 'quote-email-test' };
    await c.emailRoutes.save(companyId, 'quote_sent', { enabled: false }, actor, { code: 'POLICY_CHANGE' });
    try {
      const { made } = await quote();
      await expect(svc.send(userId, made.id)).rejects.toThrow('switched off in Settings, Email routing');
      expect((await svc.get(made.id))?.status).toBe('draft');
    } finally {
      await c.emailRoutes.reset(companyId, 'quote_sent', actor, { code: 'POLICY_CHANGE' });
    }
  });

  it('shows the business emails the company chose for its quotes, or the quote\'s own, on the document and in the email, and the company email when nothing is chosen', async () => {
    await company('sales@acme-trading.test');
    const actor = { type: 'user' as const, id: 'quote-email-test' };
    const why = { code: 'POLICY_CHANGE' };
    const pdf = vi.spyOn(c.invoicePdf, 'generate');
    const printed = () => (pdf.mock.calls.at(-1)?.[0] as { company: { email: string } }).company.email;
    try {
      const plain = (await quote()).made;
      await svc.send(userId, plain.id);
      expect(printed()).toBe('sales@acme-trading.test');
      expect(String(handed().html)).toContain('Questions? Contact sales@acme-trading.test');

      await c.emailRoutes.save(companyId, 'quote_document_staff', { shown: [{ kind: 'address', address: 'accounts@acme-trading.test' }, { kind: 'company' }] }, actor, why);
      const chosen = (await quote()).made;
      await svc.send(userId, chosen.id);
      expect(printed()).toBe('accounts@acme-trading.test, sales@acme-trading.test');
      expect(String(handed().html)).toContain('Questions? Contact accounts@acme-trading.test, sales@acme-trading.test');

      // A quote with its own list shows that list; one a shopper asked for follows the web shop setting, which is still the company email.
      const own = (await quote({ contactEmails: [{ kind: 'address', address: 'only@acme-trading.test' }, { kind: 'staff', userId: 'not-a-uuid' }] })).made;
      expect(own.contactEmails).toEqual([{ kind: 'address', address: 'only@acme-trading.test' }]);
      await svc.send(userId, own.id);
      expect(printed()).toBe('only@acme-trading.test');
      const fromShop = (await quote()).made;
      await db.update(schema.salesQuotes).set({ source: 'shop' }).where(eq(schema.salesQuotes.id, fromShop.id));
      await svc.send(userId, fromShop.id);
      expect(printed()).toBe('sales@acme-trading.test');

      // Emptying the quote's own list goes back to the company's choice.
      const emptied = (await quote({ contactEmails: [] })).made;
      expect(emptied.contactEmails).toBeNull();
    } finally {
      pdf.mockRestore();
      await c.emailRoutes.reset(companyId, 'quote_document_staff', actor, why);
    }
  });
});
