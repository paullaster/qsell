import { describe, expect, it } from 'vitest';
import { has } from '@/lib/values';

/**
 * Load check for the vendor reports (design doc §22, V-8). Opt-in because it writes a lot: set LOAD_TEST=1 with TEST_DATABASE_URL
 * pointing at a throwaway database built from the migrations. It builds a company with 2,000 vendors, 60,000 ledger entries and
 * 12,000 orders of three lines, 12,000 posted goods notes and 12,000 booked invoices with matched lines, then times each report against a budget and checks the plans do not scan whole tables for one
 * company's rows.
 */
const url = process.env.TEST_DATABASE_URL;
const enabled = has(url) && process.env.LOAD_TEST === '1';
const BUDGET_MS = Number(process.env.LOAD_BUDGET_MS ?? '3000');

describe.skipIf(!enabled)('vendor reports under load (database)', () => {
  it('stay inside their time budget on a large company', async () => {
    process.env.DATABASE_URL = url;
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const { drizzleDb: db } = await import('@/server/db/drizzle/client');
    const { sql } = await import('drizzle-orm');
    const schema = await import('@/server/db/drizzle/schema');
    const { VendorInsightsService } = await import('./insights-service');
    const { PayablesReportService } = await import('./payables-report-service');
    const { getContainer } = await import('@/server/di/container');

    const [company] = await db.insert(schema.companySettings).values({ legalName: 'LOAD', tradingName: 'LOAD', email: 'load@example.test', phone: '1', streetAddress: 's', city: 'c', countyOrState: 'x', postalCode: '1', kraPin: 'P' }).returning();
    const companyId = company?.id ?? '';
    await db.execute(sql`INSERT INTO vendors (company_id, number, legal_name, email, status) SELECT ${companyId}::uuid, 'LV-' || g, 'Load vendor ' || g, 'v' || g || '@load.test', 'active' FROM generate_series(1, 2000) g`);
    await db.execute(sql`INSERT INTO procurement_categories (company_id, code, name) VALUES (${companyId}::uuid, 'LOAD', 'Load')`);
    await db.execute(sql`
      INSERT INTO vendor_ledger_entries (company_id, vendor_id, document_type, document_no, amount, remaining_amount, currency, posting_date, due_date)
      SELECT ${companyId}::uuid, v.id, 'invoice', 'L-' || v.rn || '-' || g, -1000 - g, -1000 - g, 'KES', current_date - (g * 3), current_date - (g * 3) + 30
      FROM (SELECT id, row_number() OVER () rn FROM vendors WHERE company_id = ${companyId}::uuid) v, generate_series(1, 30) g`);
    await db.execute(sql`
      INSERT INTO purchase_orders (company_id, vendor_id, category_id, order_date, currency, status, number)
      SELECT ${companyId}::uuid, v.id, (SELECT id FROM procurement_categories WHERE company_id = ${companyId}::uuid LIMIT 1), current_date - g, 'KES', 'draft', 'LP-' || v.rn || '-' || g
      FROM (SELECT id, row_number() OVER () rn FROM vendors WHERE company_id = ${companyId}::uuid) v, generate_series(1, 6) g`);
    await db.execute(sql`
      INSERT INTO purchase_order_lines (po_id, position, description, quantity, unit_price, line_total, received_quantity)
      SELECT p.id, g, 'Line ' || g, 10, 100, 1000, g
      FROM purchase_orders p, generate_series(1, 3) g WHERE p.company_id = ${companyId}::uuid`);
    // Goods notes, written as drafts with their lines and then posted (the database refuses lines on a posted note).
    await db.execute(sql`
      INSERT INTO rgns (company_id, po_id, vendor_id, received_date, delivery_note_no, status)
      SELECT company_id, id, vendor_id, current_date - (row_number() OVER () % 300)::int, 'DN-' || id, 'draft' FROM purchase_orders WHERE company_id = ${companyId}::uuid`);
    await db.execute(sql`
      INSERT INTO rgn_lines (rgn_id, po_line_id, delivered, accepted, rejected, reject_reason)
      SELECT r.id, (SELECT l.id FROM purchase_order_lines l WHERE l.po_id = r.po_id ORDER BY l.position LIMIT 1), 10, 9, 1, 'damaged' FROM rgns r WHERE r.company_id = ${companyId}::uuid`);
    await db.execute(sql`UPDATE rgns SET status = 'posted', posted_at = now() WHERE company_id = ${companyId}::uuid`);
    // Supplier invoices with matched lines, and the booked invoices made from them.
    await db.execute(sql`
      INSERT INTO supplier_invoices (company_id, vendor_id, po_id, vendor_invoice_no, currency, invoice_date)
      SELECT company_id, vendor_id, id, 'SI-' || id, 'KES', current_date - (row_number() OVER () % 300)::int FROM purchase_orders WHERE company_id = ${companyId}::uuid`);
    await db.execute(sql`
      INSERT INTO supplier_invoice_lines (invoice_id, position, po_line_id, description, unit, quantity, unit_price, net_amount, tax_amount)
      SELECT i.id, 1, (SELECT l.id FROM purchase_order_lines l WHERE l.po_id = i.po_id ORDER BY l.position LIMIT 1), 'Line', 'each', 10, 100, 1000, 160 FROM supplier_invoices i WHERE i.company_id = ${companyId}::uuid`);
    await db.execute(sql`
      INSERT INTO supplier_invoice_matches (invoice_line_id, status)
      SELECT l.id, CASE WHEN row_number() OVER () % 5 = 0 THEN 'exception' ELSE 'ok' END FROM supplier_invoice_lines l JOIN supplier_invoices i ON i.id = l.invoice_id WHERE i.company_id = ${companyId}::uuid`);
    await db.execute(sql`
      INSERT INTO purchase_invoices (company_id, number, supplier_invoice_id, vendor_id, vendor_invoice_no, currency, invoice_date, posting_date, subtotal, tax_total, total, register_id, ledger_entry_id)
      SELECT company_id, 'PI-' || id, id, vendor_id, vendor_invoice_no, 'KES', invoice_date, invoice_date, 1000, 160, 1160 + (row_number() OVER () % 40), gen_random_uuid(), gen_random_uuid() FROM supplier_invoices WHERE company_id = ${companyId}::uuid`);
    // Lines are written while the orders are drafts; the database refuses line changes once an order is released.
    await db.execute(sql`UPDATE purchase_orders SET status = 'sent' WHERE company_id = ${companyId}::uuid`);
    await db.execute(sql`ANALYZE vendors`);
    await db.execute(sql`ANALYZE vendor_ledger_entries`);
    await db.execute(sql`ANALYZE purchase_orders`);
    await db.execute(sql`ANALYZE purchase_order_lines`);
    for (const table of ['rgns', 'rgn_lines', 'supplier_invoices', 'supplier_invoice_lines', 'supplier_invoice_matches', 'purchase_invoices']) await db.execute(sql.raw(`ANALYZE ${table}`));

    const insights = new VendorInsightsService(db);
    const payables = new PayablesReportService(db, getContainer().finance.vendorLedger, getContainer().payablesFx);
    const range = { from: '2000-01-01', to: '2999-12-31' };
    const timed: Record<string, number> = {};
    const time = async (name: string, fn: () => Promise<unknown>) => {
      const start = performance.now();
      await fn();
      timed[name] = Math.round(performance.now() - start);
    };
    await time('ageing', () => payables.ageing(companyId, '2026-10-25'));
    await time('commitments', () => insights.commitments(companyId));
    await time('performance', () => insights.performance(companyId, range));
    await time('purchases', () => insights.purchases(companyId, range));
    await time('watchList', () => insights.watchList(companyId, range));
    console.warn('[load] milliseconds', JSON.stringify(timed));
    for (const [name, ms] of Object.entries(timed)) expect(ms, `${name} took ${String(ms)} ms`).toBeLessThan(BUDGET_MS);
    expect((await insights.commitments(companyId)).lines).toHaveLength(2000);
  }, 600_000);
});
