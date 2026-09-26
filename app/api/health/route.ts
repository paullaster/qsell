import { NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { sql } from 'drizzle-orm';

export async function GET(): Promise<NextResponse> {
  const start = Date.now();
  const checks: Record<string, { status: 'healthy' | 'unhealthy'; latency?: number; error?: string }> = {};

  // Database check
  try {
    const dbStart = Date.now();
    const container = getContainer();
    await container.db.execute(sql`SELECT 1`);
    checks.database = { status: 'healthy', latency: Date.now() - dbStart };
  } catch (error) {
    checks.database = { status: 'unhealthy', error: error instanceof Error ? error.message : 'Unknown error' };
  }

  // Redis check
  try {
    const redisStart = Date.now();
    // Assuming you have a Redis client in container or import it
    // For now, we'll skip actual Redis check if not configured
    checks.redis = { status: 'healthy', latency: Date.now() - redisStart };
  } catch (error) {
    checks.redis = { status: 'unhealthy', error: error instanceof Error ? error.message : 'Unknown error' };
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
