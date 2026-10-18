import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET the bank payment file exactly as it was made, to upload to the bank. Needs `refund_files:download`; every download is
 * counted and kept with the person's name, and a file whose content no longer matches its fingerprint is refused.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await run('refund_files:download', { surface: 'finance/refunds/files/detail', action: 'download' }, async (ctx) => await getContainer().finance.refundFiles.download(ctx, id));
  if (!result.ok) return NextResponse.json(result, { status: result.forbidden ? 403 : 400 });
  const { content, mime, fileName, sha256 } = result.data;
  return new NextResponse(content, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'X-File-Sha256': sha256,
    },
  });
}
