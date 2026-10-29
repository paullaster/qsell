/**
 * Helpers for the supplier invoice tests, run as a separate person from the signed-in test user (who links and checks, and so may not approve).
 *   tsx e2e/support/invoice-fixture.ts prepare                      stock in the books, and the input tax account set (idempotent)
 *   tsx e2e/support/invoice-fixture.ts approve <vendorInvoiceNo>    approves the invoice as `e2e-boss`
 *   tsx e2e/support/invoice-fixture.ts payments-prepare             the e2e cash method may pay vendors
 *   tsx e2e/support/invoice-fixture.ts book <tag:vendorId:poId:dn>   a booked invoice for the received order (464.00)
 *   tsx e2e/support/invoice-fixture.ts approve-voucher <voucherId>  approves a payment voucher as `e2e-boss`
 *   tsx e2e/support/invoice-fixture.ts run <stage:vendorId:purchaseInvoiceId>  a payment run approved or released by other people
 *   tsx e2e/support/invoice-fixture.ts approve-run <runId>          approves a run's vouchers as `e2e-boss`
 *   tsx e2e/support/invoice-fixture.ts approve-credit <vendorCreditNo>  approves a vendor credit memo as `e2e-boss`
 * Prints one JSON line.
 */
export {};

async function main(): Promise<void> {
  const [action, arg] = process.argv.slice(2);
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { and, eq, isNull } = await import('drizzle-orm');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  if (action === 'prepare') {
    await db.update(schema.financeSettings).set({ inventoryGlGoLive: '2026-01-01' }).where(and(eq(schema.financeSettings.companyId, company.id), isNull(schema.financeSettings.inventoryGlGoLive)));
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, company.id));
    const tax = accounts.find((a) => a.no === '1410');
    if (tax === undefined) throw new Error('the input tax account 1410 is missing');
    await db.insert(schema.vendorSettings).values({ companyId: company.id, inputTaxAccountId: tax.id }).onConflictDoUpdate({ target: schema.vendorSettings.companyId, set: { inputTaxAccountId: tax.id } });
    process.stdout.write(`FIXTURE ${JSON.stringify({ ok: true })}\n`);
    return;
  }
  if (action === 'approve' && arg !== undefined) {
    const [inv] = await db.select().from(schema.supplierInvoices).where(and(eq(schema.supplierInvoices.companyId, company.id), eq(schema.supplierInvoices.vendorInvoiceNo, arg)));
    if (inv === undefined) throw new Error(`no invoice ${arg}`);
    await container.supplierInvoices.approve({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, inv.id);
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: inv.id })}\n`);
    return;
  }
  if (action === 'payments-prepare') {
    await db.update(schema.paymentMethods).set({ usableFor: ['customer_receipt', 'customer_refund', 'vendor_payment'] }).where(and(eq(schema.paymentMethods.companyId, company.id), eq(schema.paymentMethods.code, 'E2ECASH')));
    process.stdout.write(`FIXTURE ${JSON.stringify({ ok: true })}\n`);
    return;
  }
  if (action === 'book' && arg !== undefined) {
    // arg = <tag>:<vendorId>:<poId>:<deliveryNote>
    const [tag, vendorId, poId, note] = arg.split(':');
    const staff = (id: string) => ({ companyId: company.id, actor: { type: 'user' as const, id }, origin: { surface: 'e2e', action: 'fixture' } });
    const [link] = await db.select().from(schema.vendorUsers).where(eq(schema.vendorUsers.vendorId, vendorId ?? ''));
    if (link === undefined || poId === undefined || note === undefined || tag === undefined) throw new Error('bad arguments');
    const actor = { vendorId: vendorId ?? '', userId: link.userId, portalRole: 'owner' as const };
    const today = new Date().toISOString().slice(0, 10);
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const no = `PAY-${tag}`;
    const { id } = await container.invoicePortal.start(actor, company.id, { poId, vendorInvoiceNo: no });
    const loaded = await container.invoicePortal.load(actor, id);
    const scan = await container.invoicePortal.addFile(actor, company.id, { originalName: 'invoice.pdf', data: pdf });
    const dn = await container.invoicePortal.addFile(actor, company.id, { originalName: 'dn.pdf', data: pdf });
    await container.invoicePortal.save(actor, id, { header: { vendorInvoiceNo: no, invoiceDate: today, dueDate: '', notes: '', declaration: true }, lines: loaded.lines.map((l) => ({ poLineId: l.poLineId, quantity: l.quantity, unitPrice: l.unitPrice })), deliveryNotes: [{ noteNo: note, noteDate: today, fileId: dn.id }], invoiceFileId: scan.id });
    await container.invoicePortal.submit(actor, company.id, id);
    await container.supplierInvoices.pickUp(staff('e2e-clerk'), id);
    await container.supplierInvoices.autoLink(staff('e2e-clerk'), id);
    await container.supplierInvoices.runMatch(staff('e2e-clerk'), id);
    await container.supplierInvoices.sendForApproval(staff('e2e-clerk'), id);
    await container.supplierInvoices.approve(staff('e2e-boss'), id);
    await container.invoicePosting.post(staff('e2e-finance'), id);
    const [pinv] = await db.select().from(schema.purchaseInvoices).where(eq(schema.purchaseInvoices.supplierInvoiceId, id));
    process.stdout.write(`FIXTURE ${JSON.stringify({ invoiceId: id, purchaseInvoiceId: pinv?.id ?? '', vendorInvoiceNo: no })}\n`);
    return;
  }
  if (action === 'approve-voucher' && arg !== undefined) {
    await container.vendorPayments.approve({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, arg);
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: arg })}\n`);
    return;
  }
  if (action === 'run' && arg !== undefined) {
    // arg = <stage>:<vendorId>:<purchaseInvoiceId>; stage = approved | released. Made by other people so the signed-in user may confirm.
    const [stage, vendorId, purchaseInvoiceId] = arg.split(':');
    const staff = (id: string) => ({ companyId: company.id, actor: { type: 'user' as const, id }, origin: { surface: 'e2e', action: 'fixture' } });
    const [method] = await db.select().from(schema.paymentMethods).where(and(eq(schema.paymentMethods.companyId, company.id), eq(schema.paymentMethods.code, 'E2ECASH')));
    if (method === undefined || vendorId === undefined || purchaseInvoiceId === undefined) throw new Error('bad arguments');
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const made = await container.paymentRuns.create(staff('e2e-clerk'), { methodId: method.id, executionDate: tomorrow, note: 'E2E run', selections: [{ vendorId, allocations: [{ purchaseInvoiceId, amount: '464.00' }] }] });
    await container.paymentRuns.submit(staff('e2e-clerk'), made.id);
    const vouchers = await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.batchId, made.id));
    await container.paymentRuns.approve(staff('e2e-boss'), made.id, { approveIds: vouchers.map((v) => v.id), sendBackReason: '' });
    if (stage === 'released') await container.paymentRuns.release(staff('e2e-till'), made.id, {});
    process.stdout.write(`FIXTURE ${JSON.stringify({ runId: made.id, number: made.number })}\n`);
    return;
  }
  if (action === 'approve-run' && arg !== undefined) {
    const vouchers = await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.batchId, arg));
    await container.paymentRuns.approve({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, arg, { approveIds: vouchers.map((v) => v.id), sendBackReason: '' });
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: arg })}\n`);
    return;
  }
  if (action === 'approve-credit' && arg !== undefined) {
    const [memo] = await db.select().from(schema.vendorCreditMemos).where(and(eq(schema.vendorCreditMemos.companyId, company.id), eq(schema.vendorCreditMemos.vendorCreditNo, arg)));
    if (memo === undefined) throw new Error(`no credit memo ${arg}`);
    await container.creditMemos.approve({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, memo.id);
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: memo.id })}\n`);
    return;
  }
  if (action === 'petty-float' && arg !== undefined) {
    const staff = (id: string) => ({ companyId: company.id, actor: { type: 'user' as const, id }, origin: { surface: 'e2e', action: 'fixture' } });
    const accounts = await db.select().from(schema.glAccounts).where(eq(schema.glAccounts.companyId, company.id));
    const cashGl = accounts.find((a) => a.no === '1110');
    const [method] = await db.select().from(schema.paymentMethods).where(and(eq(schema.paymentMethods.companyId, company.id), eq(schema.paymentMethods.code, 'E2ECASH')));
    const [admin] = await db.select().from(schema.users).limit(1);
    if (cashGl === undefined || method === undefined || admin === undefined) throw new Error('the e2e books are not set up');
    const bank = await container.finance.bankAccounts.create(staff('e2e-admin'), { code: `PC${arg}`.toUpperCase().slice(0, 20), name: `Petty cash ${arg}`, kind: 'cash', currency: 'KES' });
    const made = await container.pettyCash.saveFloat(staff('e2e-admin'), null, { code: `PC${arg}`.slice(0, 20), name: `Front office ${arg}`, bankAccountId: bank.id, glAccountId: cashGl.id, custodianId: admin.id, floatAmount: '10000', perVoucherLimit: '1000', dailyLimit: '3000', minimumBalance: '0' });
    const top = await container.pettyCash.requestReplenishment(staff('e2e-clerk'), { floatId: made.id, fromMethodId: method.id, amount: '', countNote: '' });
    await container.pettyCash.approveReplenishment(staff('e2e-boss'), top.id);
    await container.pettyCash.payReplenishment(staff('e2e-till'), top.id, { reference: `E2E-${arg}` });
    process.stdout.write(`FIXTURE ${JSON.stringify({ floatId: made.id, name: `Front office ${arg}` })}\n`);
    return;
  }
  if (action === 'statement-line' && arg !== undefined) {
    // arg = <tag>:<amount>: a payment of that amount on the statement of the account E2E Cash pays out of.
    const [tag, amount] = arg.split(':');
    const { businessDate } = await import('@/server/kernel/numbering/business-date');
    const [method] = await db.select().from(schema.paymentMethods).where(and(eq(schema.paymentMethods.companyId, company.id), eq(schema.paymentMethods.code, 'E2ECASH')));
    if (method === undefined || tag === undefined || amount === undefined) throw new Error('the e2e books are not set up');
    const [imp] = await db.insert(schema.bankStatementImports).values({ companyId: company.id, bankAccountId: method.balancingBankAccountId, fileName: `e2e-${tag}.csv`, fileHash: `e2e-${tag}-${Date.now()}`, format: 'csv', lineCount: 1, totalIn: '0', totalOut: amount, importedBy: 'e2e' }).returning();
    const today = businessDate();
    const description = `TRANSFER ${tag}`;
    const [line] = await db.insert(schema.bankStatementLines).values({ companyId: company.id, importId: imp?.id ?? '', bankAccountId: method.balancingBankAccountId, lineNo: 1, lineDate: today, description, reference: `E2E-BANK-${tag}`, amount: `-${amount}`, lineHash: `e2e-${tag}-${Date.now()}` }).returning();
    process.stdout.write(`FIXTURE ${JSON.stringify({ lineId: line?.id ?? 0, bankAccountId: method.balancingBankAccountId, description })}\n`);
    return;
  }
  if (action === 'statement-voucher' && arg !== undefined) {
    // arg = <lineId>: approves the voucher written from that line, as another person, and gives its id.
    const [v] = await db.select().from(schema.vendorPaymentVouchers).where(eq(schema.vendorPaymentVouchers.statementLineId, Number(arg)));
    if (v === undefined) throw new Error('no voucher was written from that line');
    await container.vendorPayments.approve({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, v.id);
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: v.id })}\n`);
    return;
  }
  if (action === 'requisition-approve' && arg !== undefined) {
    await container.requisitions.approve({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, arg);
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: arg })}\n`);
    return;
  }
  if (action === 'contract-approve' && arg !== undefined) {
    await container.contracts.approve({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, arg);
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: arg })}\n`);
    return;
  }
  if (action === 'landed-post' && arg !== undefined) {
    await container.landedCosts.post({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, arg);
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: arg })}\n`);
    return;
  }
  if (action === 'scorecard-review' && arg !== undefined) {
    const ctx = { companyId: company.id, actor: { type: 'user' as const, id: 'e2e-buyer' }, origin: { surface: 'e2e', action: 'fixture' } };
    const service = (await container.scorecards.criteria(company.id, false)).find((c) => c.code === 'service');
    if (service === undefined) throw new Error('the scorecard has no service criterion');
    await container.scorecards.addReview(ctx, arg, { [service.id]: 3 }, 'Fixture review');
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: arg })}\n`);
    return;
  }
  if (action === 'return-note' && arg !== undefined) {
    // arg = <poId>: the posted received goods note of that order.
    const [note] = await db.select().from(schema.rgns).where(and(eq(schema.rgns.poId, arg), eq(schema.rgns.status, 'posted')));
    if (note === undefined) throw new Error('that order has no posted goods note');
    process.stdout.write(`FIXTURE ${JSON.stringify({ rgnId: note.id })}\n`);
    return;
  }
  if (action === 'return-post' && arg !== undefined) {
    await container.purchaseReturns.post({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, arg);
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: arg })}\n`);
    return;
  }
  if (action === 'refund-credit' && arg !== undefined) {
    // arg = <vendorId>: a payment of 300 on account, prepared, approved and paid by other people.
    const staff = (id: string) => ({ companyId: company.id, actor: { type: 'user' as const, id }, origin: { surface: 'e2e', action: 'fixture' } });
    const [method] = await db.select().from(schema.paymentMethods).where(and(eq(schema.paymentMethods.companyId, company.id), eq(schema.paymentMethods.code, 'E2ECASH')));
    if (method === undefined) throw new Error('the e2e books are not set up');
    const { id } = await container.vendorPayments.saveDraft(staff('e2e-clerk'), null, { kind: 'on_account', vendorId: arg, methodId: method.id, advanceId: '', narration: 'Deposit', amount: '300' }, []);
    await container.vendorPayments.submit(staff('e2e-clerk'), id);
    await container.vendorPayments.approve(staff('e2e-boss'), id);
    await container.vendorPayments.pay(staff('e2e-till'), id, { reference: `E2E-OA-${id.slice(0, 6)}`, paidOn: new Date().toISOString().slice(0, 10) });
    process.stdout.write(`FIXTURE ${JSON.stringify({ id })}\n`);
    return;
  }
  if (action === 'refund-post' && arg !== undefined) {
    await container.vendorRefunds.post({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, arg, { reference: `E2E-RF-${arg.slice(0, 6)}`, receivedOn: new Date().toISOString().slice(0, 10) });
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: arg })}\n`);
    return;
  }
  if (action === 'petty-receipt' && arg !== undefined) {
    await container.pettyCash.attach({ companyId: company.id, actor: { type: 'user', id: 'e2e-clerk' }, origin: { surface: 'e2e', action: 'fixture' } }, arg, { mediaAssetId: `media_e2e_${arg}`, fileName: 'receipt.jpg' });
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: arg })}\n`);
    return;
  }
  if (action === 'petty-approve' && arg !== undefined) {
    await container.pettyCash.approve({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, arg);
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: arg })}\n`);
    return;
  }
  if (action === 'petty-approve-topup' && arg !== undefined) {
    const [r] = await db.select().from(schema.pettyCashReplenishments).where(and(eq(schema.pettyCashReplenishments.floatId, arg), eq(schema.pettyCashReplenishments.status, 'pending_approval')));
    if (r === undefined) throw new Error('no top-up is waiting');
    await container.pettyCash.approveReplenishment({ companyId: company.id, actor: { type: 'user', id: 'e2e-boss' }, origin: { surface: 'e2e', action: 'fixture' } }, r.id);
    process.stdout.write(`FIXTURE ${JSON.stringify({ id: r.id })}\n`);
    return;
  }
  throw new Error('usage: invoice-fixture prepare | approve <vendorInvoiceNo> | payments-prepare | book <tag:vendorId:poId:deliveryNote> | approve-voucher <voucherId>');
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
