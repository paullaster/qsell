import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { sql } from 'drizzle-orm';

export async function GET(): Promise<NextResponse> {
  const start = Date.now();
  const checks: Record<string, { status: 'healthy' | 'unhealthy'; latencyMs?: number }> = {};

  // Database check
  try {
    const dbStart = Date.now();
    const container = getContainer();
    await container.db.execute(sql`SELECT 1`);
    checks.database = { status: 'healthy', latencyMs: Date.now() - dbStart };
  } catch {
    checks.database = { status: 'unhealthy' };
  }

  // Media storage is reported but deliberately NOT part of the overall status: a missing
  // upload setting must not make the container unhealthy and take the whole app down.
  let mediaReady: boolean;
  try {
    mediaReady = getContainer().media.uploadsReady();
  } catch {
    mediaReady = false;
  }

  // Overall status
  const allHealthy = Object.values(checks).every((c) => c.status === 'healthy');
  const totalLatency = Date.now() - start;

  return NextResponse.json(
    {
      status: allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      latency: totalLatency,
      checks,
      media: { uploadsReady: mediaReady },
      version: process.env.npm_package_version ?? 'unknown',
      environment: process.env.NODE_ENV ?? 'unknown',
    },
    {
      status: allHealthy ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    }
  );
}
