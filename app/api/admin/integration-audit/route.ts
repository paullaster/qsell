// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server';
import { getContainer } from '@/server/di/container';
import { integrationAuditLog } from '@/server/db/drizzle/schema';
import { eq, desc, and, sql } from 'drizzle-orm';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number(searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize') ?? '25')));
  const provider = searchParams.get('provider') ?? undefined;
  const operation = searchParams.get('operation') ?? undefined;
  const direction = searchParams.get('direction') ?? undefined;
  const status = searchParams.get('status') ?? undefined;
  const search = searchParams.get('search') ?? undefined;
  const dateFrom = searchParams.get('dateFrom') ?? undefined;
  const dateTo = searchParams.get('dateTo') ?? undefined;

  const container = getContainer();
  const db = container.db;

  const conditions = [] as any[];

  if (provider) conditions.push(eq(integrationAuditLog.provider, provider) as any);
  if (operation) conditions.push(eq(integrationAuditLog.operation, operation) as any);
  if (direction) conditions.push(eq(integrationAuditLog.direction, direction) as any);
  if (status) {
    if (status === 'success') conditions.push(sql`${integrationAuditLog.statusCode} >= 200 AND ${integrationAuditLog.statusCode} < 300` as any);
    else if (status === 'client_error') conditions.push(sql`${integrationAuditLog.statusCode} >= 400 AND ${integrationAuditLog.statusCode} < 500` as any);
    else if (status === 'server_error') conditions.push(sql`${integrationAuditLog.statusCode} >= 500` as any);
    else if (status === 'failed') conditions.push(sql`${integrationAuditLog.errorCode} IS NOT NULL` as any);
  }
  if (search) {
    conditions.push(
      sql`(${integrationAuditLog.correlationId} ILIKE ${'%' + search + '%'} OR ${integrationAuditLog.url} ILIKE ${'%' + search + '%'} OR ${integrationAuditLog.errorCode} ILIKE ${'%' + search + '%'} OR ${integrationAuditLog.errorMessage} ILIKE ${'%' + search + '%'})` as any
    );
  }
  if (dateFrom) conditions.push(sql`${integrationAuditLog.createdAt} >= ${new Date(dateFrom)}` as any);
  if (dateTo) conditions.push(sql`${integrationAuditLog.createdAt} <= ${new Date(dateTo)}` as any);

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

  return NextResponse.json({ data, total, page, pageSize });
}
