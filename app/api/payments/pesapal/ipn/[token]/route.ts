import { getContainer } from '@/server/di/container';
import { readIngest, reply } from '@/server/domains/payments/engine/http-ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The address payments started before the payment engine were given. It leads to the same place as the new one. */
async function handle(req: Request, params: Promise<{ token: string }>) {
  const { token } = await params;
  const input = await readIngest(req);
  return reply(await getContainer().paymentEngine.ingestAttemptCallback({ ...input, token }));
}

export const POST = (req: Request, ctx: { params: Promise<{ token: string }> }) => handle(req, ctx.params);
export const GET = (req: Request, ctx: { params: Promise<{ token: string }> }) => handle(req, ctx.params);
