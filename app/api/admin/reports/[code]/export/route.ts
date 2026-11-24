import { NextResponse } from 'next/server';
import { requireStaff } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import type { ExportErrorCode } from '@/server/domains/reports/export/export-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUS: Record<ExportErrorCode, number> = {
  forbidden: 403,
  unknown_report: 404,
  bad_format: 400,
  bad_params: 400,
  not_exportable: 400,
  too_large: 413,
  timeout: 504,
  failed: 500,
};

/**
 * GET a report as a file: `/api/admin/reports/<code>/export?format=csv|xlsx|pdf&<the report's own parameters>`.
 * The person must be signed-in staff, hold `reports:export` and the report's own permissions; the file is made on the
 * spot, recorded with who took it and its fingerprint, and never stored. Anything the report does not understand in the
 * address is ignored by the report's own parameter reader.
 */
export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  let userId: string;
  try {
    userId = await requireStaff();
  } catch {
    return NextResponse.json({ ok: false, error: 'Please sign in again.' }, { status: 401 });
  }
  const { code } = await params;
  const query = new URL(request.url).searchParams;
  const format = query.get('format');
  const reportParams: Record<string, string> = {};
  for (const [key, value] of query.entries()) {
    if (key !== 'format') reportParams[key] = value;
  }

  const result = await getContainer().reportExport.export(userId, code, reportParams, format);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: STATUS[result.code] });
  }
  return new NextResponse(new Uint8Array(result.content), {
    status: 200,
    headers: {
      'Content-Type': result.mime,
      'Content-Disposition': `attachment; filename="${result.fileName}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'X-File-Sha256': result.sha256,
    },
  });
}
