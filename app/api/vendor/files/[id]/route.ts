import { getContainer } from '@/server/di/container';
import { PortalAccessError, requirePortalVendor } from '@/server/domains/vendors/portal-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A vendor opens one of its own files. Anyone else's, a made-up id and a signed-out caller all get the same "not found". */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const me = await requirePortalVendor();
    if (!UUID.test(id)) return new Response('Not found', { status: 404 });
    const company = await getContainer().companySettings.ensureSeeded();
    const file = await getContainer().vendorFiles.read(company.id, id, me.vendorId);
    if (file === null) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(file.data), {
      headers: {
        'Content-Type': file.mime,
        'Content-Disposition': `inline; filename="${file.fileName}"`,
        'Content-Length': String(file.data.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof PortalAccessError) return new Response('Not found', { status: 404 });
    throw error;
  }
}
