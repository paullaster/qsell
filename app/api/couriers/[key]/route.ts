import { headers } from 'next/headers';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { getContainer } from '@/server/di/container';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Where a courier's system pushes news of a parcel. The unguessable key in the address says which courier; the body must be signed
 * with the secret only that courier and we hold, so nobody else can move a delivery. A message that is not news is answered kindly
 * (and ignored) so the courier does not keep resending it. Never indexed, never cached.
 */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const h = await headers();
  const verdict = await getContainer().rateLimits.hit('courier_webhook_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
  if (!verdict.allowed) return Response.json({ message: waitMessage(verdict.retryAfterSeconds) }, { status: 429 });
  const raw = await req.text();
  const signature = req.headers.get('x-signature') ?? req.headers.get('x-hub-signature-256');
  const reply = await getContainer().courierSync.receivePush(key, raw, signature);
  return Response.json({ message: reply.message }, { status: reply.status, headers: { 'Cache-Control': 'no-store' } });
}
