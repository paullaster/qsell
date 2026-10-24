import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Staff open a file a vendor uploaded. Needs `vendors:view_documents`; every opening is written to the vendor's history. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await run('vendors:view_documents', { surface: 'vendors/documents', action: 'download' }, async (ctx) => {
    const container = getContainer();
    const file = await container.vendorFiles.openForStaff(ctx, id);
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
