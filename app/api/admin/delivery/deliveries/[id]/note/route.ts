import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { orders } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { runDelivery } from '@/server/domains/delivery/action-support';
import { buildDeliveryNote, deliveryNoteFileName } from '@/server/domains/delivery/delivery-note';
import { DeliveryError } from '@/server/domains/delivery/errors';
import { renderDeliveryNotePdf } from '@/server/adapters/pdf/pdfkit-delivery-note.adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET the delivery note of a delivery, as a PDF. Needs `deliveries:read`; the company is set on the server, so a delivery of another
 * company is simply not found. A draft or cancelled delivery has no note. `?inline=1` shows it in the browser (to print); otherwise
 * it downloads.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const inline = new URL(request.url).searchParams.get('inline') === '1';
  const result = await runDelivery('deliveries:read', async (ctx) => {
    if (!UUID.test(id)) throw new DeliveryError('That delivery could not be found.', 'NOT_FOUND');
    const c = getContainer();
    const view = await c.deliveryDocuments.get(ctx.companyId, id);
    if (view === null) throw new DeliveryError('That delivery could not be found.', 'NOT_FOUND');
    const [order] = await drizzleDb.select({ phone: orders.customerPhone, address: orders.shippingAddress }).from(orders).where(eq(orders.id, view.orderId));
    const street = typeof order?.address.street === 'string' && order.address.street.trim() !== '' ? order.address.street.trim() : null;
    const note = buildDeliveryNote(view, { customerPhone: order?.phone ?? null, street }, await c.companySettings.getProfile(), new Date().toISOString().slice(0, 10));
    return { fileName: deliveryNoteFileName(view.number), pdf: await renderDeliveryNotePdf(note) };
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
