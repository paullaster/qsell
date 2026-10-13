import { getContainer } from '@/server/di/container';
import { readIngest, reply } from '@/server/domains/payments/engine/http-ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pesapal notifications sent to an address with no secret in it (as registered before payments had their
 * own addresses). Nothing here is believed: the notification is written down, the payment it names is
 * found by Pesapal's tracking id, and that payment is counted only after Pesapal itself confirms it.
 */
async function handle(req: Request) {
  const input = await readIngest(req);
  let body: Record<string, unknown> = {};
  try {
    body = input.rawText ? (JSON.parse(input.rawText) as Record<string, unknown>) : {};
  } catch {
    body = {};
  }
  const trackingId = String(body.OrderTrackingId ?? body.orderTrackingId ?? input.query.OrderTrackingId ?? '');
  if (!trackingId) return Response.json({ success: false, message: 'No order tracking id' }, { status: 400 });
  return reply(await getContainer().paymentEngine.ingestAttemptCallback({ ...input, trackingId }));
}

export const POST = handle;
export const GET = handle;
