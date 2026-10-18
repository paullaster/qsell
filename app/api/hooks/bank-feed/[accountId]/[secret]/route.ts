import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { MAX_FEED_BYTES } from '@/server/domains/finance/domain/bank-feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store' };

/**
 * POST JSON statement lines from a bank (or a script, or an aggregator) to one bank account's feed. The address carries a secret
 * that is shown once, when the feed is made, and kept only as a fingerprint. A wrong secret, an unknown account and a feed that
 * is switched off all answer the same: 404. A delivery sent twice changes nothing the second time.
 */
export async function POST(request: Request, { params }: { params: Promise<{ accountId: string; secret: string }> }) {
  const { accountId, secret } = await params;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) {
    return NextResponse.json({ ok: false, error: 'That delivery is larger than 5 MB. Send fewer lines at a time.' }, { status: 413, headers: noStore });
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_FEED_BYTES) {
    return NextResponse.json({ ok: false, error: 'That delivery is larger than 5 MB. Send fewer lines at a time.' }, { status: 413, headers: noStore });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip');
  const out = await getContainer().finance.bankFeeds.ingest(accountId, secret, body, { ip });
  if (!out.ok) return NextResponse.json({ ok: false, error: out.error }, { status: out.status, headers: noStore });
  return NextResponse.json({ ok: true, ...out.result }, { headers: noStore });
}
