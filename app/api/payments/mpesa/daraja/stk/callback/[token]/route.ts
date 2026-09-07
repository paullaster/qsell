import { getContainer } from '@/server/di/container';
import type { PaymentProviderCode } from '@/server/domains/payments/types';

async function handle(
  providerCode: PaymentProviderCode,
  callbackToken: string,
  request: Request,
) {
  const { payments } = getContainer();
  const result = await payments.handleProviderCallback({
    providerCode,
    callbackToken,
    request,
  });
  return Response.json(result.body, { status: result.httpStatus });
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  return handle('mpesa_daraja', token, request);
}
