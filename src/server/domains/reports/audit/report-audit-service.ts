import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { reportAudit, users, type ReportAuditRow } from '@/server/db/drizzle/schema';
import { asRecord } from '../engine/params';
import type { ReportAuditEntry, ReportAuditSink } from '../engine/run';

const PAGE = 50;
const MAX_PAGE = 200;

export interface AuditListFilter {
  reportCode?: string;
  userId?: string;
  action?: 'run' | 'export';
}

export interface AuditPage {
  rows: ReportAuditRow[];
  /** Pass this back as `before` for the next page; null when there are no more. */
  next: number | null;
}

/**
 * Who ran or downloaded a sensitive report, and when. Rows are only ever added (the database refuses a change or a
 * delete). It serves as the runner's audit sink and the export service's, and as the list on the Report activity
 * screen, read a page at a time by the row number so a page costs the same however deep it is.
 */
export class ReportAuditService implements ReportAuditSink {
  constructor(
    private readonly db: DrizzleDb,
    private readonly companyId: () => Promise<string>,
  ) {}

  /** The names of these people, in one query, for showing who did something. A person no longer in the system is simply absent. */
  async namesOf(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)].filter((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    );
    if (unique.length === 0) return new Map();
    const found = await this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, unique));
    return new Map(found.map((u) => [u.id, u.name]));
  }

  async record(entry: ReportAuditEntry): Promise<void> {
    await this.db.insert(reportAudit).values({
      companyId: await this.companyId(),
      userId: entry.userId,
      reportCode: entry.reportCode,
      action: entry.action,
      // Only typed parameters are ever passed here; anything that is not a plain object is stored as empty.
      params: asRecord(entry.params),
      format: entry.format ?? null,
      rowCount: entry.rowCount,
      truncated: entry.truncated,
      contentHash: entry.contentHash ?? null,
      definitionsVersion: entry.definitionsVersion,
    });
  }

  /** Newest first. `limit` is capped; `before` is the `next` of the previous page. */
  async list(
    filter: AuditListFilter = {},
    options: { limit?: number; before?: number } = {},
  ): Promise<AuditPage> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? PAGE), 1), MAX_PAGE);
    const companyId = await this.companyId();
    const rows = await this.db
      .select()
      .from(reportAudit)
      .where(
        and(
          eq(reportAudit.companyId, companyId),
          filter.reportCode === undefined
            ? undefined
            : eq(reportAudit.reportCode, filter.reportCode),
          filter.userId === undefined ? undefined : eq(reportAudit.userId, filter.userId),
          filter.action === undefined ? undefined : eq(reportAudit.action, filter.action),
          options.before === undefined ? undefined : lt(reportAudit.id, options.before),
        ),
      )
      .orderBy(desc(reportAudit.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { rows: page, next: rows.length > limit && last !== undefined ? last.id : null };
  }
}
