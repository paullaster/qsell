/**
 * Makes purchase orders for one test, written by `e2e-buyer` so that the signed-in test user is a different person and may approve.
 *   tsx e2e/support/po-fixture.ts <tag> <vendorId> pending|sent|sent_flagged|amendment|advance_pending|awarded|stocked|received|workflow
 * `stocked` is a sent, confirmed order for 10 of a new stock item; `received` adds a posted note for 4 of them (delivery note DN-<tag>).
 * `pending` is waiting for approval; `sent` is approved and sent; `sent_flagged` requires an advance; `amendment` is a sent order with a
 * price change waiting; `advance_pending` is a flagged order with an advance waiting for approval; `awarded` is a closed, awarded request
 * with no order made yet; `workflow` is an order held by an approval workflow for this vendor that only the signed-in test user can approve, from the inbox. The vendor is made qualified in a new category first. Prints one JSON line.
 */
export {};

const MODES = ['pending', 'sent', 'sent_flagged', 'amendment', 'advance_pending', 'awarded', 'stocked', 'received', 'workflow'];

async function main(): Promise<void> {
  const [tag, vendorId, mode] = process.argv.slice(2);
  if (tag === undefined || vendorId === undefined || mode === undefined || !MODES.includes(mode)) throw new Error(`usage: po-fixture <tag> <vendorId> ${MODES.join('|')}`);
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const staff = (id: string) => ({ companyId: company.id, actor: { type: 'user' as const, id }, origin: { surface: 'e2e', action: 'fixture' } });
  const today = new Date().toISOString().slice(0, 10);
  const [link] = await db.select().from(schema.vendorUsers).where(eq(schema.vendorUsers.vendorId, vendorId));
  if (link === undefined) throw new Error('that vendor has no owner');
  const actor = { vendorId, userId: link.userId, portalRole: 'owner' as const };
  const categoryName = `Fixture PO category ${tag}`;
  const cat = await container.categories.save(company.id, null, { code: `PO_${tag}`.toUpperCase().slice(0, 30), name: categoryName, description: '', parentId: '', validityMonths: '24', windowFrom: '', windowTo: '', passMarkPercent: '', fourEyes: true, showTotalScore: false, showPassMark: false, showQuestionScores: false, showEvaluatorComments: false });
  await container.categories.setStatus(company.id, cat.id, 'open');
  const { ids } = await container.prequal.apply(actor, company.id, [cat.id], today);
  await container.prequal.submit(actor, ids[0] ?? '');
  await container.prequalReview.take(staff('e2e-evaluator'), ids[0] ?? '');
  await container.prequalReview.approve(staff('e2e-decider'), ids[0] ?? '', { maxOrderValue: '', note: '' }, today);
  const out: Record<string, unknown> = { categoryId: cat.id, categoryName };

  if (mode === 'awarded') {
    const two = (n: number) => String(n).padStart(2, '0');
    const d = new Date(Date.now() + 72 * 3_600_000);
    const deadline = `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
    const rfq = await container.rfqs.saveDraft(staff('e2e-buyer'), null, { title: `Fixture award ${tag}`, categoryId: cat.id, description: '', terms: '', requiredBy: '', deadline, validityDays: '30', currency: 'KES', sealed: true, allowPartial: false, allowAlternatives: false, estimatedValue: '' }, [{ productId: '', description: 'Inverter 5kW', specification: '', quantity: '4', unit: 'each', requiredDate: '' }]);
    await container.rfqs.setInvitees(staff('e2e-buyer'), rfq.id, [vendorId], today);
    await container.rfqs.issue(staff('e2e-buyer'), rfq.id);
    const got = await container.rfqs.get(company.id, rfq.id);
    const lineId = got?.lines[0]?.id ?? '';
    await container.rfqPortal.saveDraft(actor, rfq.id, { paymentTerms: '30 days', deliveryTerms: '', validUntil: new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10), notes: '', lines: [{ rfqLineId: lineId, noBid: false, isAlternative: false, unitPrice: '950', quantity: '4', taxRate: '16', leadTimeDays: '14', brand: '', warranty: '', note: '' }] });
    await container.rfqPortal.submit(actor, rfq.id, company.id);
    await db.update(schema.rfqs).set({ deadline: new Date(Date.now() - 60_000), opensAt: new Date(Date.now() - 60_000) }).where(eq(schema.rfqs.id, rfq.id));
    await container.rfqs.closeDue(new Date());
    await container.rfqEvaluation.award(staff('e2e-buyer'), rfq.id, [{ rfqLineId: lineId, vendorId, quantity: '4' }], '');
    out.rfqId = rfq.id;
    out.number = got?.rfq.number;
    process.stdout.write(`FIXTURE ${JSON.stringify(out)}\n`);
    return;
  }

  if (mode === 'stocked' || mode === 'received') {
    const itemTypeId = `it_${tag}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const productId = `prod_${tag}`;
    const productName = `Fixture stock item ${tag}`;
    await db.insert(schema.products).values({ id: productId, sku: `FX-${tag}`.toUpperCase(), stockCode: `FXS-${tag}`.toUpperCase(), name: productName, slug: `fx-${tag}`, itemTypeId, price: '999', costPrice: '10', stockQuantity: 0 });
    const [p] = await db.select({ unitId: schema.products.baseUnitId }).from(schema.products).where(eq(schema.products.id, productId));
    const [u] = await db.select({ code: schema.unitsOfMeasure.code }).from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.id, p?.unitId ?? ''));
    const header = { vendorId, categoryId: cat.id, orderDate: today, expectedDate: '', currency: 'KES', paymentTerms: '30 days', deliveryTerms: '', notesToVendor: '', internalNotes: '', requiresAdvancePayment: false, noRfqReason: 'Fixture order' };
    const lines = [{ productId, description: productName, specification: '', quantity: '10', unit: u?.code ?? 'each', unitPrice: '100', discountPercent: '0', taxRate: '16', expectedDate: '' }];
    const draft = await container.purchaseOrders.saveDraft(staff('e2e-buyer'), null, header, lines, false);
    await container.purchaseOrders.submit(staff('e2e-buyer'), draft.id, { maySkipRfq: false, mayOverrideQualification: false });
    out.number = (await container.purchaseOrders.approve(staff('e2e-boss'), draft.id)).number;
    await container.purchaseOrders.send(staff('e2e-buyer'), draft.id);
    await container.purchaseOrders.recordConfirmation(staff('e2e-buyer'), draft.id, 'Phone', new Date());
    out.poId = draft.id;
    out.productId = productId;
    out.productName = productName;
    if (mode === 'received') {
      const got = await container.purchaseOrders.get(company.id, draft.id);
      const note = await container.rgns.saveDraft(staff('e2e-store'), null, draft.id, { receivedDate: today, deliveryNoteNo: `DN-${tag}`, vehicle: '', notes: '' }, [{ poLineId: got?.lines[0]?.id ?? '', delivered: '4', rejected: '', rejectReason: '' }]);
      out.rgnId = note.id;
      out.rgnNumber = (await container.rgns.post(staff('e2e-store'), note.id)).number;
      out.deliveryNote = `DN-${tag}`;
    }
    process.stdout.write(`FIXTURE ${JSON.stringify(out)}\n`);
    return;
  }

  const flagged = mode === 'sent_flagged' || mode === 'advance_pending';
  const header = { vendorId, categoryId: cat.id, orderDate: today, expectedDate: '', currency: 'KES', paymentTerms: '30 days', deliveryTerms: '', notesToVendor: '', internalNotes: '', requiresAdvancePayment: flagged, noRfqReason: 'Fixture order' };
  const lines = [{ productId: '', description: 'Inverter 5kW', specification: '', quantity: '4', unit: 'each', unitPrice: '1000', discountPercent: '0', taxRate: '16', expectedDate: '' }, { productId: '', description: 'Cable 6mm', specification: '', quantity: '100', unit: 'm', unitPrice: '2.50', discountPercent: '0', taxRate: '0', expectedDate: '' }];
  let buyer = 'e2e-buyer';
  if (mode === 'workflow') {
    // The engine records who asked, so the writer is a real person here, not a label.
    const [writer] = await db.insert(schema.users).values({ email: `e2e-wf-${tag}@e2e.test`, passwordHash: 'x', name: 'E2E Writer', role: 'manager' }).returning();
    if (writer === undefined) throw new Error('the writer was not made');
    buyer = writer.id;
    const { E2E_ADMIN_EMAIL } = await import('./constants');
    const [admin] = await db.select().from(schema.users).where(eq(schema.users.email, E2E_ADMIN_EMAIL));
    if (admin === undefined) throw new Error('the e2e admin does not exist');
    const actor = { type: 'user' as const, id: 'e2e-fixture' };
    const reason = { code: 'POLICY_CHANGE' };
    await container.approvalConfig.saveProfile(company.id, { userId: admin.id, limits: [] }, actor, reason);
    const wf = await container.approvalConfig.createWorkflow(company.id, { code: `W-${tag}`.slice(0, 30), name: `Order approvals ${tag}`, trigger: 'po.release' }, actor);
    await container.approvalConfig.saveDraft(company.id, wf.id, { conditions: { op: 'eq', field: 'vendor.id', value: vendorId }, steps: [{ sequence: 1, name: 'Admin', approver: { type: 'user', userId: admin.id } }] } as never, actor);
    await container.approvalConfig.publish(company.id, wf.id, actor, reason);
  }
  const draft = await container.purchaseOrders.saveDraft(staff(buyer), null, header, lines, true);
  await container.purchaseOrders.submit(staff(buyer), draft.id, { maySkipRfq: false, mayOverrideQualification: false });
  out.poId = draft.id;
  if (mode !== 'pending' && mode !== 'workflow') {
    const approved = await container.purchaseOrders.approve(staff('e2e-boss'), draft.id);
    out.number = approved.number;
    await container.purchaseOrders.send(staff('e2e-buyer'), draft.id);
    if (mode === 'amendment') {
      const got = await container.purchaseOrders.get(company.id, draft.id);
      await container.purchaseOrders.amend(staff('e2e-buyer'), draft.id, { header: { expectedDate: '', paymentTerms: '30 days', deliveryTerms: '', notesToVendor: '', requiresAdvancePayment: false }, lines: (got?.lines ?? []).map((l, i) => ({ id: l.id, productId: '', description: l.description, specification: '', quantity: l.quantity, unit: l.unit, unitPrice: i === 0 ? '950' : l.unitPrice, discountPercent: '0', taxRate: l.taxRate, expectedDate: '' })), reason: 'Price agreed down' }, false);
    }
    if (mode === 'advance_pending') {
      const adv = await container.advances.create(staff('e2e-buyer'), draft.id, { amount: '1000', dueDate: '', reason: 'Deposit to start work' });
      await container.advances.submit(staff('e2e-buyer'), adv.id);
      out.advanceId = adv.id;
    }
  }
  process.stdout.write(`FIXTURE ${JSON.stringify(out)}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
