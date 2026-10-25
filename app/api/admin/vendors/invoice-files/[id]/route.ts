import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Staff open the scan or a delivery note of a supplier invoice. Needs `supplier_invoices:read`; only files that belong to an invoice open here. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await run('supplier_invoices:read', { surface: 'invoices/files', action: 'download' }, async (ctx) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new FinanceError('NOT_FOUND', 'That file does not exist.');
    const file = await getContainer().supplierInvoices.openFile(ctx, id);
    if (file === null) throw new FinanceError('NOT_FOUND', 'That file does not exist.');
    return file;
  });
  if (!result.ok) {
    let status = result.code === 'NOT_FOUND' ? 404 : 400;
    if (result.forbidden === true) status = 403;
    return NextResponse.json({ ok: false, error: result.error }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  const { data, mime, fileName } = result.data;
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `inline; filename="${fileName}"`,
      'Content-Length': String(data.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Cache-Control': 'private, no-store',
    },
  });
}
