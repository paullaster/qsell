import { desc, ilike, or, sql } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { applicationErrorLogs } from '@/server/db/drizzle/schema';

export interface ApplicationErrorInput {
  source: string;
  errorName: string;
  message: string;
  stack?: string | null;
  digest?: string | null;
  path?: string | null;
  method?: string | null;
  routePath?: string | null;
  routeType?: string | null;
  runtime?: string | null;
  requestId?: string | null;
  userAgent?: string | null;
  actorUserId?: string | null;
  context?: Record<string, unknown>;
}

const limitText = (value: string | null | undefined, limit: number) =>
  value == null ? null : value.slice(0, limit);

export async function recordApplicationError(input: ApplicationErrorInput): Promise<void> {
  try {
    await drizzleDb.insert(applicationErrorLogs).values({
      source: limitText(input.source, 80) ?? 'server',
      errorName: limitText(input.errorName, 300) ?? 'Error',
      message: limitText(input.message, 8000) ?? 'Unknown application error',
      stack: limitText(input.stack, 30000),
      digest: limitText(input.digest, 300),
      path: limitText(input.path, 2000),
      method: limitText(input.method, 32),
      routePath: limitText(input.routePath, 1000),
      routeType: limitText(input.routeType, 100),
      runtime: limitText(input.runtime, 80),
      requestId: limitText(input.requestId, 300),
      userAgent: limitText(input.userAgent, 1000),
      actorUserId: input.actorUserId ?? null,
      context: input.context ?? {},
    });
  } catch (loggingError) {
    // Preserve a copy in container logs if the database itself is unavailable.
    console.error('[application-errors] failed to persist an application error', loggingError);
  }
}

export async function listApplicationErrors(input: {
  page?: number;
  pageSize?: number;
  search?: string;
}) {
  const requestedPage = Math.floor(input.page ?? 1);
  const requestedPageSize = Math.floor(input.pageSize ?? 25);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const pageSize = Number.isFinite(requestedPageSize)
    ? Math.min(100, Math.max(1, requestedPageSize))
    : 25;
  const search = input.search?.trim().slice(0, 300);
  const where = search
    ? or(
        ilike(applicationErrorLogs.message, `%${search}%`),
        ilike(applicationErrorLogs.errorName, `%${search}%`),
        ilike(applicationErrorLogs.digest, `%${search}%`),
        ilike(applicationErrorLogs.path, `%${search}%`),
        ilike(applicationErrorLogs.routePath, `%${search}%`),
      )
    : undefined;
  const [rows, [{ total }]] = await Promise.all([
    drizzleDb
      .select()
      .from(applicationErrorLogs)
      .where(where)
      .orderBy(desc(applicationErrorLogs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    drizzleDb
      .select({ total: sql<number>`count(*)` })
      .from(applicationErrorLogs)
      .where(where),
  ]);
  return { rows, total, page, pageSize };
}
