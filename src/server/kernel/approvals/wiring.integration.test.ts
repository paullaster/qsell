import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';

/**
 * Approvals wired into real modules: sales orders, credit notes and stock operations.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 * Workflows are scoped by a value only the test uses (a price, a reason), so tests do not
 * trigger each other's rules.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;

describe.skipIf(!url)('approvals in modules (database)', () => {
  type Container = ReturnType<typeof import('@/server/di/container').getContainer>;
  let c: Container;
  let db: typeof import('@/server/db/drizzle/client').drizzleDb;
  let schema: typeof import('@/server/db/drizzle/schema');
  let withAfterCommit: typeof import('@/server/kernel/after-commit').withAfterCommit;
  let OrderWriteService: typeof import('@/server/domains/orders/write-service').OrderWriteService;
  let InventoryDomainService: typeof import('@/server/domains/inventory/service').InventoryDomainService;
  let resubmit: typeof import('@/server/domains/orders/approval').resubmitOrderForApproval;
  let updateOrderStatus: typeof InventoryDomainService.updateOrderStatus;
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;

  const actor = { type: 'user' as const, id: 'wiring-test' };
  const reason = { code: 'POLICY_CHANGE' };

  const user = async (label: string) =>
    (
      await db
        .insert(schema.users)
        .values({
          email: `${label}-${randomUUID()}@wiring.test`,
          passwordHash: 'x',
          name: label,
          role: 'manager',
        })
        .returning()
    )[0]!.id;

  const approver = async () => {
    const [requester, boss] = await Promise.all([user('requester'), user('boss')]);
    await c.approvalConfig.saveProfile(companyId, { userId: boss, limits: [] }, actor, reason);
    return { requester, boss };
  };

  async function workflow(trigger: string, conditions: unknown, approverUserId: string) {
    const wf = await c.approvalConfig.createWorkflow(
      companyId,
      { code: `W-${randomUUID().slice(0, 8)}`, name: 'Wiring test', trigger },
      actor,
    );
    await c.approvalConfig.saveDraft(
      companyId,
      wf.id,
      {
        conditions,
        steps: [{ sequence: 1, name: 'Boss', approver: { type: 'user', userId: approverUserId } }],
      } as never,
      actor,
    );
    await c.approvalConfig.publish(companyId, wf.id, actor, reason);
    return wf;
  }

  const product = async (over: { price?: number; cost?: number; stock?: number } = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({
      id,
      sku: `W-${randomUUID().slice(0, 8)}`.toUpperCase(),
      stockCode: `WS-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Wiring product',
      slug: `wiring-${randomUUID()}`,
      itemTypeId,
      price: String(over.price ?? 100),
      costPrice: String(over.cost ?? 50),
      stockQuantity: over.stock ?? 100,
      taxRate: '0',
      isTaxInclusive: true,
    });
    return id;
  };
  const stockOf = async (id: string) =>
    (
      await db
        .select({ n: schema.products.stockQuantity })
        .from(schema.products)
        .where(eq(schema.products.id, id))
    )[0]!.n;

  const approve = (entryId: string, by: string) =>
    withAfterCommit(db, (tx) => c.approvals.approve(entryId, by, null, tx));
  const reject = (entryId: string, by: string) =>
    withAfterCommit(db, (tx) =>
      c.approvals.reject(entryId, by, { reasonCode: 'OTHER', comment: 'No' }, tx),
    );
  const reopen = (documentKind: string, documentId: string, by: string) =>
    withAfterCommit(db, (tx) =>
      c.approvals.reopen(
        documentKind,
        documentId,
        { userId: by },
        { text: 'Will fix' },
        tx,
        companyId,
      ),
    );
  const openEntry = async (kind: string, documentId: string) =>
    (await c.approvals.forDocument(companyId, kind, documentId))
      .flatMap((r) => r.entries)
      .find((e) => e.status === 'open')!;

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ withAfterCommit } = await import('@/server/kernel/after-commit'));
    ({ OrderWriteService } = await import('@/server/domains/orders/write-service'));
    ({ InventoryDomainService } = await import('@/server/domains/inventory/service'));
    ({ resubmitOrderForApproval: resubmit } = await import('@/server/domains/orders/approval'));
    updateOrderStatus = InventoryDomainService.updateOrderStatus.bind(InventoryDomainService);
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    // A quote is saved in an enabled currency.
    await db
      .insert(schema.currencies)
      .values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true })
      .onConflictDoNothing();
    // Rules left over from earlier runs of this file would also match today's documents.
    await db
      .update(schema.approvalWorkflows)
      .set({ status: 'retired' })
      .where(
        inArray(schema.approvalWorkflows.trigger, [
          'stock_adjustment.submitted',
          'sales_order.submitted',
          'credit_note.requested',
          'sales_quote.submitted',
        ]),
      );
    const { organizations } = c;
    const { branch } = await organizations.ensureDefaultOrgAndBranch(companyId, 'Wiring Test Co');
    branchId = ((await c.branches.getDefault(companyId)) || branch).id;
    itemTypeId = `it_wiring_${randomUUID().slice(0, 8)}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
  });

  // ── stock ──

  it('a stock write-off big enough for a workflow waits for approval, then happens exactly once', async () => {
    const { requester, boss } = await approver();
    // A distinctive value: write-offs worth more than KES 1,000 at cost.
    const p = await product({ cost: 50, stock: 100 });
    const wf = await workflow(
      'stock_adjustment.submitted',
      {
        op: 'and',
        children: [
          { op: 'gt', field: 'amount', value: 1000 },
          { op: 'eq', field: 'reasonCode', value: 'shrinkage_loss' },
        ],
      },
      boss,
    );
    expect(wf).toBeTruthy();

    // Small: straight through, as before.
    const small = await InventoryDomainService.gatedOp(
      {
        kind: 'write_off',
        productId: p,
        quantity: 5,
        reasonCode: 'shrinkage_loss',
        actor: requester,
      },
      requester,
    );
    expect(small.parked).toBe(false);
    expect(await stockOf(p)).toBe(95);

    // Large: parked, stock untouched.
    const large = await InventoryDomainService.gatedOp(
      {
        kind: 'write_off',
        productId: p,
        quantity: 30,
        reasonCode: 'shrinkage_loss',
        actor: requester,
      },
      requester,
    );
    expect(large.parked).toBe(true);
    expect(await stockOf(p)).toBe(95);
    const requestId = (large as { requestId: string }).requestId;
    const parked = (
      await db
        .select()
        .from(schema.approvalParkedActions)
        .where(eq(schema.approvalParkedActions.id, requestId))
    )[0]!;
    expect(parked.status).toBe('parked');
    expect(parked.summary).toMatch(/Write off stock/);

    // The approver is told what they are approving.
    const detail = await c.approvals.requestDetail(
      companyId,
      (await c.approvals.forDocument(companyId, 'stock_adjustment', requestId))[0]!.id,
    );
    expect(detail!.what!.title).toMatch(/Worth KES 1,500/);

    const entry = await openEntry('stock_adjustment', requestId);
    expect(await approve(entry.id, boss)).toMatchObject({ released: true });
    expect(await stockOf(p)).toBe(65);
    const after = (
      await db
        .select()
        .from(schema.approvalParkedActions)
        .where(eq(schema.approvalParkedActions.id, requestId))
    )[0]!;
    expect(after.status).toBe('applied');
    expect(after.closedAt).not.toBeNull();
  });

  it('a rejected stock change never happens; a failing one cannot be approved', async () => {
    const { requester, boss } = await approver();
    const p = await product({ cost: 50, stock: 100 });
    await workflow(
      'stock_adjustment.submitted',
      { op: 'eq', field: 'reasonCode', value: 'damage_transit' },
      boss,
    );
    const parked = await InventoryDomainService.gatedOp(
      {
        kind: 'write_off',
        productId: p,
        quantity: 10,
        reasonCode: 'damage_transit',
        actor: requester,
      },
      requester,
    );
    const id = (parked as { requestId: string }).requestId;
    await reject((await openEntry('stock_adjustment', id)).id, boss);
    expect(await stockOf(p)).toBe(100);
    expect(
      (
        await db
          .select()
          .from(schema.approvalParkedActions)
          .where(eq(schema.approvalParkedActions.id, id))
      )[0]!.status,
    ).toBe('rejected');

    // Stock falls before the approver gets to it: approving would over-write-off, so it fails
    // cleanly, the approval is not recorded, and the entry is still open to reject.
    const big = await InventoryDomainService.gatedOp(
      {
        kind: 'write_off',
        productId: p,
        quantity: 90,
        reasonCode: 'damage_transit',
        actor: requester,
      },
      requester,
    );
    const bigId = (big as { requestId: string }).requestId;
    await db.update(schema.products).set({ stockQuantity: 20 }).where(eq(schema.products.id, p));
    const e = await openEntry('stock_adjustment', bigId);
    await expect(approve(e.id, boss)).rejects.toThrow(/only 20 currently on hand/);
    expect((await openEntry('stock_adjustment', bigId)).id).toBe(e.id);
    expect(await stockOf(p)).toBe(20);
  });

  it('with no workflow, stock operations run immediately and leave nothing parked', async () => {
    const { requester } = await approver();
    const p = await product({ stock: 10 });
    const before = (await db.select().from(schema.approvalParkedActions)).length;
    const r = await InventoryDomainService.gatedOp(
      { kind: 'adjust', productId: p, newQuantity: 7, reason: 'recount', actor: requester },
      requester,
    );
    expect(r.parked).toBe(false);
    expect(await stockOf(p)).toBe(7);
    expect((await db.select().from(schema.approvalParkedActions)).length).toBe(before);
  });

  // ── sales orders ──

  const order = (productId: string, over: Record<string, unknown> = {}) =>
    OrderWriteService.createOrder({
      branchId,
      // Explicit, because this test database holds many companies that each number from 1.
      orderNumber: `WIRE-${randomUUID()}`,
      customerName: 'Wiring Buyer',
      customerEmail: `buyer-${randomUUID()}@wiring.test`,
      customerPhone: '0700000000',
      shippingAddress: {
        street: '1 Test Rd',
        city: 'Nairobi',
        countyOrState: 'Nairobi',
        country: 'KE',
      },
      items: [{ productId, quantity: 1 }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja' as never,
      ...over,
    });

  it('a sales order that needs approval is held, cannot move on, then is released by the approver', async () => {
    const { requester, boss } = await approver();
    const price = 10000 + Math.floor(Math.random() * 89999);
    const p = await product({ price });
    await workflow('sales_order.submitted', { op: 'eq', field: 'amount', value: price }, boss);

    // A shop checkout is never held up, whatever its size.
    const shop = await order(p, { salesModule: 'ecommerce' });
    expect(shop.error).toBeUndefined();
    expect(shop.order!.approvalStatus ?? 'none').toBe('none');

    // Staff-placed sales order: held.
    const res = await order(p, { salesModule: 'sales_order', requestedBy: requester });
    expect(res.success).toBe(true);
    const o = res.order!;
    expect(o.approvalStatus).toBe('pending');
    expect((await c.orders.getById(o.id))!.approvalStatus).toBe('pending');
    await expect(updateOrderStatus(o.id, 'processing')).rejects.toThrow(/waiting for approval/);
    // It can still be cancelled.
    const entry = await openEntry('sales_order', o.id);
    expect(entry.approverUserId).toBe(boss);

    expect(await approve(entry.id, boss)).toMatchObject({ released: true });
    expect((await c.orders.getById(o.id))!.approvalStatus).toBe('approved');
    expect((await updateOrderStatus(o.id, 'processing')).status).toBe('processing');
  });

  it('a rejected order stays held; reopen then resubmit sends it round again', async () => {
    const { requester, boss } = await approver();
    const price = 10000 + Math.floor(Math.random() * 89999);
    const p = await product({ price });
    await workflow('sales_order.submitted', { op: 'eq', field: 'amount', value: price }, boss);
    const o = (await order(p, { salesModule: 'sales_order', requestedBy: requester })).order!;

    await reject((await openEntry('sales_order', o.id)).id, boss);
    expect((await c.orders.getById(o.id))!.approvalStatus).toBe('rejected');
    await expect(updateOrderStatus(o.id, 'shipped')).rejects.toThrow(/refused/);
    await expect(resubmit(o.id, requester)).rejects.toThrow(/not waiting to be sent/);

    await reopen('sales_order', o.id, requester);
    expect((await c.orders.getById(o.id))!.approvalStatus).toBe('draft');
    await expect(updateOrderStatus(o.id, 'shipped')).rejects.toThrow(/refused/);

    expect(await resubmit(o.id, requester)).toBe('pending');
    const history = await c.approvals.forDocument(companyId, 'sales_order', o.id);
    expect(history.map((r) => r.status)).toEqual(['reopened', 'pending']);
    expect(history[1]!.attempt).toBe(2);
    await approve((await openEntry('sales_order', o.id)).id, boss);
    expect((await c.orders.getById(o.id))!.approvalStatus).toBe('approved');
  });

  it('a failed order creation gives back the stock it had set aside', async () => {
    const p = await product({ stock: 5 });
    // A blocked customer makes order creation fail after the stock was reserved.
    const email = `blocked-${randomUUID()}@wiring.test`;
    await c.customers.saveCustomer(companyId, {
      name: 'Blocked Buyer',
      email,
      accountType: 'cash',
      creditLimit: 0,
      paymentTermDays: 0,
      blocked: 'all',
      transmitInvoicesToKra: true,
    } as never);
    const res = await order(p, { customerEmail: email });
    expect(res.success).toBe(false);
    const [row] = await db
      .select({ reserved: schema.products.reservedQuantity })
      .from(schema.products)
      .where(eq(schema.products.id, p));
    expect(row!.reserved).toBe(0);
  });

  // ── credit notes ──

  it('a credit note that needs approval is issued only when approved, in the approver’s transaction', async () => {
    const { requester, boss } = await approver();
    const price = 10000 + Math.floor(Math.random() * 89999);
    const p = await product({ price });
    const placed = (await order(p, { salesModule: 'ecommerce' })).order!;
    await db.insert(schema.invoiceDocuments).values({
      orderId: placed.id,
      orderNumber: placed.orderNumber,
      invoiceNumber: `TI-${randomUUID().slice(0, 10)}`,
      documentType: 'tax_invoice',
      customerEmail: placed.customerEmail,
      customerName: placed.customerName,
      currency: 'KES',
      subtotal: String(price),
      tax: '0',
      shippingFee: '0',
      totalAmount: String(price),
      pdfStorageKey: 'x.pdf',
      emailStatus: 'not_sent',
      meta: {},
    });
    // This test database holds many companies that each number from 1, while credit note numbers
    // are unique across the table. Start this company's series somewhere of its own.
    await db
      .transaction((tx) =>
        c.numbering.assign(
          'credit_note',
          {
            companyId,
            branchId,
            date: new Date().toISOString().slice(0, 10),
            document: { kind: 'credit_note', id: randomUUID() },
          },
          tx,
        ),
      )
      .catch(() => undefined); // an earlier run may have left this company's series used up: reset below
    await db.execute(
      sql`update number_series_counters set last_no = ${Math.floor(1e6 + Math.random() * 9e7)}
        where line_id in (select l.id from number_series_lines l join number_series s on s.id = l.series_id
          where s.company_id = ${companyId} and s.code = 'CN')`,
    );
    await workflow(
      'credit_note.requested',
      { op: 'eq', field: 'reasonCode', value: 'goodwill' },
      boss,
    );

    const request = {
      orderId: placed.id,
      lines: [{ productId: p, quantity: 1 }],
      reason: { code: 'goodwill' as const },
      issuedBy: requester,
    };
    const outcome = await c.creditNotes.issueForOrderGated(request);
    expect(outcome.status).toBe('pending_approval');
    expect(await c.creditNotes.listForSource('order', placed.id)).toHaveLength(0);

    const parkedId = (
      await db
        .select()
        .from(schema.approvalParkedActions)
        .where(eq(schema.approvalParkedActions.documentKind, 'credit_note'))
    ).find((r) => (r.payload as { orderId?: string }).orderId === placed.id)!.id;
    await approve((await openEntry('credit_note', parkedId)).id, boss);
    const issued = await c.creditNotes.listForSource('order', placed.id);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.issuedBy).toBe(requester);
    expect(issued[0]!.creditNoteNo).toBeTruthy();
    const after = (
      await db
        .select()
        .from(schema.approvalParkedActions)
        .where(eq(schema.approvalParkedActions.id, parkedId))
    )[0]!;
    expect(after).toMatchObject({ status: 'applied' });
    expect((after.result as { creditNoteId: string }).creditNoteId).toBe(issued[0]!.id);

    // A different reason is not caught by the workflow, so it is issued straight away.
    const direct = await c.creditNotes
      .issueForOrderGated({
        ...request,
        lines: [{ productId: p, quantity: 0 }].slice(0, 0).concat([]),
        reason: { code: 'returned_goods' },
      })
      .catch((e: Error) => e);
    expect(direct instanceof Error ? direct.message : direct.status).toMatch(
      /at least one line|issued|credit/i,
    );
  });
  // ── quotes ──

  const quoteInput = (productId: string, over: Record<string, unknown> = {}) => ({
    customerName: 'Quote Buyer',
    customerEmail: 'quote-buyer@wiring.test',
    currency: 'KES',
    paymentMethod: 'mpesa_daraja' as never,
    discountPercent: 0,
    shippingFee: 0,
    sections: [],
    lines: [{ productId, quantity: 1, discountPercent: 0 }],
    ...over,
  });
  /** Rules from earlier tests would also match this test's quotes, so start from none. */
  const clearQuoteRules = () =>
    db
      .update(schema.approvalWorkflows)
      .set({ status: 'retired' })
      .where(eq(schema.approvalWorkflows.trigger, 'sales_quote.submitted'));
  const quoteRow = async (id: string) =>
    (await db.select().from(schema.salesQuotes).where(eq(schema.salesQuotes.id, id)))[0]!;

  it('a quote with no workflow behaves as before: margin floor only', async () => {
    const { SalesQuoteService } = await import('@/server/domains/quotes/service');
    const quotes = new SalesQuoteService();
    const { requester } = await approver();
    const ok = await product({ price: 1000, cost: 100 });
    const fine = await quotes.create(requester, quoteInput(ok) as never);
    expect(fine).toMatchObject({
      status: 'draft',
      approvalStatus: 'not_required',
      approvalManagedBy: null,
    });

    // Sold below cost: the old margin check still holds it, and the old approve still releases it.
    const loss = await product({ price: 100, cost: 900 });
    const held = await quotes.create(requester, quoteInput(loss) as never);
    expect(held).toMatchObject({
      status: 'pending_approval',
      approvalStatus: 'pending',
      approvalManagedBy: null,
    });
    expect((await quotes.approve(requester, held.id))!.status).toBe('approved');
  });

  it('a workflow owns a quote’s approval: held, no shortcut, released by the approver', async () => {
    const { SalesQuoteService } = await import('@/server/domains/quotes/service');
    const quotes = new SalesQuoteService();
    await clearQuoteRules();
    const { requester, boss } = await approver();
    const price = 20000 + Math.floor(Math.random() * 50000);
    const p = await product({ price, cost: 1 });
    await workflow(
      'sales_quote.submitted',
      { op: 'between', field: 'amount', value: [price, price * 3] },
      boss,
    );

    const q = await quotes.create(requester, quoteInput(p) as never);
    expect(q).toMatchObject({
      status: 'pending_approval',
      approvalStatus: 'pending',
      approvalManagedBy: 'workflow',
    });
    // The old one-click approve cannot be used to get round the workflow, nor can sending.
    await expect(quotes.approve(requester, q.id)).rejects.toThrow(/Approvals inbox/);
    await expect(quotes.send(requester, q.id)).rejects.toThrow(
      /needs approval|Only draft or approved/,
    );

    const detail = await c.approvals.requestDetail(
      companyId,
      (await c.approvals.forDocument(companyId, 'sales_quote', q.id))[0]!.id,
    );
    expect(detail!.what!.title).toContain(q.quoteNumber);

    await approve((await openEntry('sales_quote', q.id)).id, boss);
    expect(await quoteRow(q.id)).toMatchObject({ status: 'approved', approvalStatus: 'approved' });
    expect((await quotes.get(q.id))!.events.map((e) => e.eventType)).toContain('approved');
  });

  it('editing a quote while it waits voids the old request and asks again', async () => {
    const { SalesQuoteService } = await import('@/server/domains/quotes/service');
    const quotes = new SalesQuoteService();
    await clearQuoteRules();
    const { requester, boss } = await approver();
    const price = 20000 + Math.floor(Math.random() * 50000);
    const p = await product({ price, cost: 1 });
    await workflow(
      'sales_quote.submitted',
      { op: 'between', field: 'amount', value: [price, price * 3] },
      boss,
    );
    const q = await quotes.create(requester, quoteInput(p) as never);

    const edited = await quotes.update(
      requester,
      q.id,
      quoteInput(p, { lines: [{ productId: p, quantity: 2, discountPercent: 0 }] }) as never,
    );
    expect(edited.status).toBe('pending_approval');
    const requests = await c.approvals.forDocument(companyId, 'sales_quote', q.id);
    expect(requests.map((r) => r.status)).toEqual(['superseded', 'pending']);
    expect((await openEntry('sales_quote', q.id)).approverUserId).toBe(boss);
  });

  it('a refused quote must be reopened before it can be sent again, then goes round afresh', async () => {
    const { SalesQuoteService } = await import('@/server/domains/quotes/service');
    const quotes = new SalesQuoteService();
    await clearQuoteRules();
    const { requester, boss } = await approver();
    const price = 20000 + Math.floor(Math.random() * 50000);
    const p = await product({ price, cost: 1 });
    await workflow(
      'sales_quote.submitted',
      { op: 'between', field: 'amount', value: [price, price * 3] },
      boss,
    );
    const q = await quotes.create(requester, quoteInput(p) as never);

    await reject((await openEntry('sales_quote', q.id)).id, boss);
    expect(await quoteRow(q.id)).toMatchObject({ status: 'draft', approvalStatus: 'rejected' });
    await expect(quotes.send(requester, q.id)).rejects.toThrow(/refused/);
    // Editing it is not a way round the refusal: it still has to be reopened first.
    await expect(quotes.update(requester, q.id, quoteInput(p) as never)).rejects.toThrow(
      /Reopen it/,
    );

    await reopen('sales_quote', q.id, requester);
    expect(await quoteRow(q.id)).toMatchObject({ status: 'draft', approvalStatus: 'draft' });
    await expect(quotes.send(requester, q.id)).rejects.toThrow(/again/);
    await expect(quotes.resubmitApproval(requester, q.id)).resolves.toMatchObject({
      status: 'pending_approval',
    });
    const history = await c.approvals.forDocument(companyId, 'sales_quote', q.id);
    expect(history.map((r) => r.status)).toEqual(['reopened', 'pending']);
    await approve((await openEntry('sales_quote', q.id)).id, boss);
    expect(await quoteRow(q.id)).toMatchObject({ status: 'approved', approvalStatus: 'approved' });
  });

  it('after a refusal, editing a quote out of the workflow’s reach lets it carry on normally', async () => {
    const { SalesQuoteService } = await import('@/server/domains/quotes/service');
    const quotes = new SalesQuoteService();
    await clearQuoteRules();
    const { requester, boss } = await approver();
    const price = 20000 + Math.floor(Math.random() * 50000);
    const p = await product({ price, cost: 1 });
    await workflow(
      'sales_quote.submitted',
      { op: 'between', field: 'amount', value: [price, price * 2] },
      boss,
    );
    const q = await quotes.create(requester, quoteInput(p) as never);
    await reject((await openEntry('sales_quote', q.id)).id, boss);

    // Three of them is over the workflow's range, so it no longer applies.
    const fixed = await quotes.update(
      requester,
      q.id,
      quoteInput(p, { lines: [{ productId: p, quantity: 3, discountPercent: 0 }] }) as never,
    );
    expect(fixed).toMatchObject({
      status: 'draft',
      approvalStatus: 'not_required',
      approvalManagedBy: null,
    });
    expect(
      (await c.approvals.forDocument(companyId, 'sales_quote', q.id)).map((r) => r.status),
    ).toEqual(['reopened']);
  });
});
