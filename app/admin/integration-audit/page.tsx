// @ts-nocheck
import { AdminIntegrationAuditClient } from '@/components/admin/AdminIntegrationAuditClient';
import { getContainer } from '@/server/di/container';
import { integrationAuditLog } from '@/server/db/drizzle/schema';
import { desc, and, eq, sql } from 'drizzle-orm';

async function fetchLogs(page = 1, pageSize = 25): Promise<{
  data: any[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const container = getContainer();
  const db = container.db;

  const whereClause = undefined; // No filters in initial load

  const [data, [{ value: total }]] = await Promise.all([
    db
      .select()
      .from(integrationAuditLog)
      .where(whereClause)
      .orderBy(desc(integrationAuditLog.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ value: sql<number>`count(*)` })
      .from(integrationAuditLog)
      .where(whereClause),
  ]);

  return { data, total, page, pageSize };
}

export default async function IntegrationAuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    pageSize?: string;
    provider?: string;
    operation?: string;
    direction?: string;
    status?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
  }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(params.pageSize ?? '25')));
  const provider = params.provider ?? undefined;
  const operation = params.operation ?? undefined;
  const direction = params.direction ?? undefined;
  const status = params.status ?? undefined;
  const search = params.search ?? undefined;
  const dateFrom = params.dateFrom ?? undefined;
  const dateTo = params.dateTo ?? undefined;

  const container = getContainer();
  const db = container.db;

  const conditions: any[] = [];

  if (provider) conditions.push(eq(integrationAuditLog.provider, provider) as any);
  if (operation) conditions.push(eq(integrationAuditLog.operation, operation) as any);
  if (direction) conditions.push(eq(integrationAuditLog.direction, direction) as any);
  if (status) {
    if (status === 'success') conditions.push(sql`${integrationAuditLog.statusCode} >= 200 AND ${integrationAuditLog.statusCode} < 300`);
    else if (status === 'client_error') conditions.push(sql`${integrationAuditLog.statusCode} >= 400 AND ${integrationAuditLog.statusCode} < 500`);
    else if (status === 'server_error') conditions.push(sql`${integrationAuditLog.statusCode} >= 500`);
    else if (status === 'failed') conditions.push(sql`${integrationAuditLog.errorCode} IS NOT NULL`);
  }
  if (search) {
    conditions.push(
      sql`(${integrationAuditLog.correlationId} ILIKE ${'%' + search + '%'} OR ${integrationAuditLog.url} ILIKE ${'%' + search + '%'} OR ${integrationAuditLog.errorCode} ILIKE ${'%' + search + '%'} OR ${integrationAuditLog.errorMessage} ILIKE ${'%' + search + '%'})`
    );
  }
  if (dateFrom) conditions.push(sql`${integrationAuditLog.createdAt} >= ${new Date(dateFrom)}`);
  if (dateTo) conditions.push(sql`${integrationAuditLog.createdAt} <= ${new Date(dateTo)}`);

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [data, [{ value: total }]] = await Promise.all([
    db
      .select()
      .from(integrationAuditLog)
      .where(whereClause)
      .orderBy(desc(integrationAuditLog.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ value: sql<number>`count(*)` })
      .from(integrationAuditLog)
      .where(whereClause),
  ]);

  const logsPromise = Promise.resolve({ data, total, page, pageSize });

  return <AdminIntegrationAuditClient logsPromise={logsPromise} />;
}