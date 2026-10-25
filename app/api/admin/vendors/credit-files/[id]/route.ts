import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Staff open the credit note a vendor attached. Needs `credit_memos:read`; only files that belong to a credit memo open here. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await run('credit_memos:read', { surface: 'credit_memos/files', action: 'download' }, async (ctx) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new FinanceError('NOT_FOUND', 'That file does not exist.');
    const file = await getContainer().creditMemos.openFile(ctx, id);
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
