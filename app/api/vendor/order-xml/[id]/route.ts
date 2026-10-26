import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { portal } from '@/server/domains/vendors/portal-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One of the vendor's own orders as a UBL 2.1 Order. The vendor comes from the session; any other order is "not found". */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await portal('order_xml', async (me) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return await getContainer().edi.orderXml(me.companyId, id, me.vendorId).catch(() => null);
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: result.signedOut === true ? 401 : 400, headers: { 'Cache-Control': 'no-store' } });
  if (result.data === null) return NextResponse.json({ ok: false, error: 'That order does not exist.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(result.data.xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${result.data.fileName}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' } });
}
