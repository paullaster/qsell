import { getContainer } from '@/server/di/container';
import { readIngest, reply } from '@/server/domains/payments/engine/http-ingest';
import type { HookKind } from '@/server/domains/payments/engine/payment-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = new Set<HookKind>(['c2b-validate', 'c2b-confirm', 'result', 'timeout', 'bill', 'express', 'pull']);

/**
 * Where Safaricom (and other platforms) call a provider: payments made straight to a paybill or till,
 * and the results and timeouts of requests we made. The secret in the address belongs to the provider.
 */
export async function POST(req: Request, ctx: { params: Promise<{ providerId: string; kind: string; secret: string }> }) {
  const { providerId, kind, secret } = await ctx.params;
  if (!KINDS.has(kind as HookKind) || !/^[0-9a-f-]{36}$/i.test(providerId)) return Response.json({ ResultCode: 1, ResultDesc: 'Unknown' }, { status: 404 });
  const input = await readIngest(req);
  return reply(await getContainer().paymentEngine.ingestHook({ ...input, providerId, kind: kind as HookKind, secret }));
}
