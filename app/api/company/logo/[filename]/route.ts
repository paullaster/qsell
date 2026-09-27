import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ filename: string }> },
) {
  const { filename } = await params;
  if (!/^logo-\d+(?:-[a-f0-9-]+)?\.(png|jpg|webp|svg)$/i.test(filename)) {
    return new Response('Not found', { status: 404 });
  }

  const extension = path.extname(filename).slice(1).toLowerCase();
  try {
    const bytes = await readFile(
      path.join(process.cwd(), 'public', 'uploads', 'company', filename),
    );
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': MIME_TYPES[extension]!,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
