import { getContainer } from '@/server/di/container';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const { payments } = getContainer();
  const result = await payments.handleProviderCallback({
    providerCode: 'jenga_hq',
    callbackToken: token,
    request,
  });
  return Response.json(result.body, { status: result.httpStatus });
}
