/**
 * Makes what a request-for-quotation test needs. Run with the e2e environment:
 *   tsx e2e/support/rfq-fixture.ts <tag> <vendorIdsCommaSeparated> category|issued|quoted|closed
 * `category` is an open category with the given (approved) vendors qualified in it; `issued` adds a request issued to them;
 * `quoted` adds a sent quote from the first vendor (second vendor quotes lower, third higher when there are more);
 * `closed` is `quoted` with the deadline passed, so the quotes are open. Prints one JSON line.
 */
export {};

const MODES = ['category', 'issued', 'quoted', 'closed'];

async function main(): Promise<void> {
  const [tag, vendorList, mode] = process.argv.slice(2);
  if (tag === undefined || vendorList === undefined || mode === undefined || !MODES.includes(mode)) throw new Error(`usage: rfq-fixture <tag> <vendorIds> ${MODES.join('|')}`);
  const vendorIds = vendorList.split(',').filter((v) => v !== '');
  const { getContainer } = await import('@/server/di/container');
  const { drizzleDb: db } = await import('@/server/db/drizzle/client');
  const schema = await import('@/server/db/drizzle/schema');
  const { eq } = await import('drizzle-orm');
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const staff = (id: string) => ({ companyId: company.id, actor: { type: 'user' as const, id }, origin: { surface: 'e2e', action: 'fixture' } });
  const today = new Date().toISOString().slice(0, 10);
  const categoryName = `Fixture RFQ category ${tag}`;
  const cat = await container.categories.save(company.id, null, { code: `RQ_${tag}`.toUpperCase().slice(0, 30), name: categoryName, description: '', parentId: '', validityMonths: '24', windowFrom: '', windowTo: '', passMarkPercent: '', fourEyes: true, showTotalScore: false, showPassMark: false, showQuestionScores: false, showEvaluatorComments: false });
  await container.categories.setStatus(company.id, cat.id, 'open');
  const owners = new Map<string, { vendorId: string; userId: string; portalRole: 'owner' }>();
  for (const vendorId of vendorIds) {
    const [link] = await db.select().from(schema.vendorUsers).where(eq(schema.vendorUsers.vendorId, vendorId));
    if (link === undefined) throw new Error('a vendor has no owner');
    const actor = { vendorId, userId: link.userId, portalRole: 'owner' as const };
    owners.set(vendorId, actor);
    const { ids } = await container.prequal.apply(actor, company.id, [cat.id], today);
    await container.prequal.submit(actor, ids[0] ?? '');
    await container.prequalReview.take(staff('e2e-evaluator'), ids[0] ?? '');
    await container.prequalReview.approve(staff('e2e-decider'), ids[0] ?? '', { maxOrderValue: '', note: '' }, today);
  }
  const out: Record<string, unknown> = { categoryId: cat.id, categoryName };
  if (mode !== 'category') {
    const deadline = new Date(Date.now() + 72 * 3_600_000);
    const two = (n: number) => String(n).padStart(2, '0');
    const local = `${String(deadline.getFullYear())}-${two(deadline.getMonth() + 1)}-${two(deadline.getDate())}T${two(deadline.getHours())}:${two(deadline.getMinutes())}`;
    const draft = await container.rfqs.saveDraft(staff('e2e-buyer'), null, {
      title: `Fixture request ${tag}`, categoryId: cat.id, description: 'Supply and deliver', terms: '', requiredBy: '', deadline: local, validityDays: '30', currency: 'KES', sealed: true, allowPartial: false, allowAlternatives: false, estimatedValue: '',
    }, [
      { productId: '', description: 'Inverter 5kW', specification: '', quantity: '4', unit: 'each', requiredDate: '' },
      { productId: '', description: 'Cable 6mm', specification: '', quantity: '100', unit: 'm', requiredDate: '' },
    ]);
    await container.rfqs.setInvitees(staff('e2e-buyer'), draft.id, vendorIds, today);
    const issued = await container.rfqs.issue(staff('e2e-buyer'), draft.id);
    const got = await container.rfqs.get(company.id, draft.id);
    const lines = got?.lines ?? [];
    out.rfqId = draft.id;
    out.number = issued.number;
    out.title = `Fixture request ${tag}`;
    out.lineA = lines[0]?.id;
    out.lineB = lines[1]?.id;
    if (mode === 'quoted' || mode === 'closed') {
      const validUntil = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
      const prices: [string, string][] = [['1000', '2'], ['900', '3'], ['1100', '2.5']];
      for (const [i, vendorId] of vendorIds.entries()) {
        const actor = owners.get(vendorId);
        const [a, b] = prices[i] ?? ['1200', '3'];
        if (actor === undefined) continue;
        const line = (id: string, qty: string, price: string) => ({ rfqLineId: id, noBid: false, isAlternative: false, unitPrice: price, quantity: qty, taxRate: '0', leadTimeDays: '14', brand: '', warranty: '', note: '' });
        await container.rfqPortal.saveDraft(actor, draft.id, { paymentTerms: '30 days', deliveryTerms: '', validUntil, notes: '', lines: [line(String(out.lineA), '4', a), line(String(out.lineB), '100', b)] });
        await container.rfqPortal.submit(actor, draft.id, company.id);
      }
    }
    if (mode === 'closed') {
      await db.update(schema.rfqs).set({ deadline: new Date(Date.now() - 60_000), opensAt: new Date(Date.now() - 60_000) }).where(eq(schema.rfqs.id, draft.id));
      await container.rfqs.closeDue(new Date());
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
