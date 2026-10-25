/**
 * Helpers for the supplier invoice tests, run as a separate person from the signed-in test user (who links and checks, and so may not approve).
 *   tsx e2e/support/invoice-fixture.ts prepare                      stock in the books, and the input tax account set (idempotent)
 *   tsx e2e/support/invoice-fixture.ts approve <vendorInvoiceNo>    approves the invoice as `e2e-boss`
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
  throw new Error('usage: invoice-fixture prepare | approve <vendorInvoiceNo>');
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
