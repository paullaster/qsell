import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, users } from '@/server/db/drizzle/schema';
import type { ReportScope } from '../types';

/** The words for a scope, as shown on a report ("All branches", a branch name, or that none is assigned). */
export function scopeLabel(scope: ReportScope): string {
  if (scope.kind === 'all') return 'All branches';
  if (scope.kind === 'branch') return scope.branchName;
  return 'No branch assigned';
}

/**
 * Who sees which branch: users with `reports:all_branches` see the whole company (or one branch they pick);
 * everyone else is pinned to their own branch. A user with no branch and no company-wide right sees nothing
 * rather than everything.
 */
export async function resolveReportScope(
  db: DrizzleDb,
  userId: string,
  allBranches: boolean,
  requested: string | undefined,
): Promise<ReportScope> {
  if (allBranches) {
    if (requested !== undefined && requested !== '') {
      const [b] = await db
        .select({ id: branches.id, name: branches.name })
        .from(branches)
        .where(eq(branches.id, requested))
        .limit(1);
      if (b !== undefined) return { kind: 'branch', branchId: b.id, branchName: b.name };
    }
    return { kind: 'all' };
  }
  const [row] = await db
    .select({ branchId: users.branchId, name: branches.name })
    .from(users)
    .leftJoin(branches, eq(branches.id, users.branchId))
    .where(eq(users.id, userId))
    .limit(1);
  if (row?.branchId === undefined || row.branchId === null || row.branchId === '') {
    return { kind: 'none' };
  }
  return { kind: 'branch', branchId: row.branchId, branchName: row.name ?? 'Your branch' };
}
