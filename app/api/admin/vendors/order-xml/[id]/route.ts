import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** An approved order as a UBL 2.1 Order, for the buyer's own use. Needs `purchase_orders:read`. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await run('purchase_orders:read', { surface: 'po/xml', action: 'download' }, async (ctx) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return await getContainer().edi.orderXml(ctx.companyId, id);
  });
  if (!result.ok || result.data === null) {
    let status = 400;
    if (!result.ok && result.forbidden === true) status = 403;
    else if (result.ok || result.code === 'NOT_FOUND') status = 404;
    return NextResponse.json({ ok: false, error: result.ok ? 'That order does not exist.' : result.error }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(result.data.xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${result.data.fileName}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } });
}
