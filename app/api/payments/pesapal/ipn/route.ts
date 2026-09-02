import { PesapalService } from '@/server/domains/payments/pesapal/pesapalService';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const url = new URL(request.url);
    const orderTrackingId =
      body.OrderTrackingId || body.orderTrackingId || url.searchParams.get('OrderTrackingId') || '';
    const merchantReference =
      body.OrderMerchantReference ||
      body.merchantReference ||
      url.searchParams.get('OrderMerchantReference') ||
      '';
    const status = body.status || body.Status || 'COMPLETED';

    const result = await PesapalService.processIpn(
      String(orderTrackingId),
      String(merchantReference),
      String(status),
    );
    return Response.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'IPN failed';
    return Response.json({ success: false, message }, { status: 400 });
  }
}

export async function GET(request: Request) {
  return await POST(request);
}
