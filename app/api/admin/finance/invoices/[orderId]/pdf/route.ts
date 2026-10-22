import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What the invoice service says in plain words about why an invoice cannot be issued yet; anything else stays out of the screen. */
const SAYABLE = /^(A tax invoice cannot be issued|Proforma invoice is not available)/;

/**
 * GET the tax invoice of an order that is in this company's customer ledger. Needs `orders:read`; an order with no invoice
 * in the ledger is simply not found. `?inline=1` shows it in the browser (used for printing); otherwise it downloads.
 */
export async function GET(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const inline = new URL(request.url).searchParams.get('inline') === '1';
  const result = await run('orders:read', { surface: 'finance/customer-ledger', action: inline ? 'print_invoice_pdf' : 'download_invoice_pdf' }, async (ctx) => {
    const container = getContainer();
    if (!(await container.finance.customerLedger.hasInvoice(ctx.companyId, orderId))) throw new FinanceError('NOT_FOUND', 'That invoice does not exist.');
    try {
      const invoice = await container.invoices.generatePdf(orderId, 'tax_invoice');
      return { fileName: invoice.filename, pdf: Buffer.from(invoice.pdfBase64, 'base64') };
    } catch (error: unknown) {
      if (error instanceof Error && SAYABLE.test(error.message)) throw new FinanceError('INVOICE_NOT_READY', error.message);
      console.error('[finance] invoice pdf', error);
      throw new FinanceError('INVOICE_FAILED', 'The invoice could not be prepared. Please try again.');
    }
  });
  if (!result.ok) {
    let status = result.code === 'NOT_FOUND' ? 404 : 400;
    if (result.forbidden === true) status = 403;
    return NextResponse.json({ ok: false, error: result.error }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  return new NextResponse(new Uint8Array(result.data.pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${result.data.fileName.replace(/[^A-Za-z0-9._-]+/g, '-')}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
