import { DarajaService } from '@/server/domains/payments/mpesa/darajaService';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await DarajaService.processCallback(body);
    return Response.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Callback failed';
    return Response.json({ success: false, message }, { status: 400 });
  }
}
