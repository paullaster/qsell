import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { buildReceiptDocument, receiptFileName } from '@/server/domains/finance/receivables/receipt-document';
import { renderReceiptPdf } from '@/server/adapters/pdf/pdfkit-receipt.adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET the PDF of a posted (or reversed) receipt. Needs `receipts:read`; the company is set on the server, so a receipt of
 * another company is simply not found. `?inline=1` shows it in the browser (used for printing); otherwise it downloads.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inline = new URL(request.url).searchParams.get('inline') === '1';
  const result = await run('receipts:read', { surface: 'finance/receipts', action: inline ? 'print_pdf' : 'download_pdf' }, async (ctx) => {
    const container = getContainer();
    const detail = await container.finance.receipts.detail(ctx.companyId, id);
    if (!detail) throw new FinanceError('NOT_FOUND', 'That receipt does not exist.');
    const document = buildReceiptDocument(detail, await container.companySettings.getProfile());
    return { fileName: receiptFileName(document.number), pdf: await renderReceiptPdf(document, new Date().toISOString().slice(0, 10)) };
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
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${result.data.fileName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}
