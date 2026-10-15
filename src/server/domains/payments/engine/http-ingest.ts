import type { IngestReply } from './payment-engine';
import { firstFilled } from '@/lib/values';

/** What an inbound request looked like, in the form the engine records. */
export async function readIngest(req: Request) {
  const rawText = req.method === 'GET' ? '' : await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const sourceIp = firstFilled(forwarded, req.headers.get('x-real-ip'));
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  const query = Object.fromEntries(new URL(req.url).searchParams.entries());
  return { rawText, headers, sourceIp, https: proto === 'https', method: req.method, query };
}

export const reply = (r: IngestReply) => Response.json(r.body, { status: r.httpStatus });
