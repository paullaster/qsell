import { getContainer } from '@/server/di/container';
import { readIngest, reply } from '@/server/domains/payments/engine/http-ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Where a payment platform tells us about one payment we started (M-Pesa Express, Pesapal and the like).
 * The address carries that payment's own secret. What arrives is written down and only used to decide
 * where to look: the payment is counted once the platform itself has confirmed it.
 */
async function handle(req: Request, params: Promise<{ token: string }>) {
  const { token } = await params;
  const input = await readIngest(req);
  return reply(await getContainer().paymentEngine.ingestAttemptCallback({ ...input, token }));
}

export const POST = (req: Request, ctx: { params: Promise<{ token: string }> }) => handle(req, ctx.params);
export const GET = (req: Request, ctx: { params: Promise<{ token: string }> }) => handle(req, ctx.params);
