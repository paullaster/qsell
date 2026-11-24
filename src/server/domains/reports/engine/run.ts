import type { AccessControlService } from '@/server/domains/access-control/engine';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { catalogueVersion } from '../catalogue/version';
import type { ReportDefinition } from '../registry/definition';
import { REPORTS, findReport, visibleReports } from '../registry';
import type { ExportTable } from '../export/table';
import { ResultCache } from './cache';

/**
 * The one door through which a report is produced. It checks the viewer's permissions before any read, lets the
 * report's executor compute under the viewer's own permission set, shares and caches identical requests, enforces
 * the time limit, and returns the result with the facts every report must carry (as of, tier, definitions version).
 * Failures come back as data, never as a thrown error, because server-action errors are masked in production.
 */

export type RunErrorCode = 'unknown_report' | 'forbidden' | 'bad_params' | 'timeout' | 'failed';

export interface RunMeta {
  code: string;
  /** The moment the answer was produced (a cached answer keeps the time it was made). */
  asOf: string;
  tier: ReportDefinition['tier'];
  /** The version of the measure catalogue the answer was worked out under. */
  definitionsVersion: string;
  /** True when this answer came from the cache or from a read that was already running. */
  cached: boolean;
  /** True when the executor had to cut rows at the report's `maxRows`. */
  truncated: boolean;
  /** What the report declares about proof against the books; `checked` stays false until the tie-out job exists (R-1). */
  tieOut: { declared: ReportDefinition['tieOut']['kind']; checked: false };
}

export type RunResult<T> =
  | {
      ok: true;
      data: T;
      meta: RunMeta;
      /** The parameters as the report read them (never the raw request). */
      params: unknown;
      table?: ExportTable;
    }
  | { ok: false; code: RunErrorCode; error: string };

export interface ExecutionContext<P> {
  userId: string;
  params: P;
  /** Which of the executor's `permissions` the viewer holds, decided once by the runner. */
  allowed: ReadonlySet<PermissionKey>;
  now: Date;
  /** The most rows to return; an executor that has more reports `truncated: true`. */
  maxRows: number;
  /** True when the caller is an export and needs the answer as a table as well. */
  wantTable: boolean;
}

export interface Execution<T> {
  data: T;
  /** The answer as a table, when `wantTable` was asked and the report can be exported. */
  table?: ExportTable;
  truncated?: boolean;
  /** When the answer was really produced, if the executor keeps its own cache. Defaults to now. */
  asOf?: string;
  /** True when the executor served this from its own cache. */
  cached?: boolean;
}

/** The report-specific part: read the parameters, name the permissions that change the answer, compute. */
export interface ReportExecutor<P, T> {
  code: string;
  /** Turn what a browser sent into parameters, or refuse it in words. */
  readParams(raw: unknown): { ok: true; params: P } | { ok: false; error: string };
  /** Permissions that change what the viewer sees. The runner resolves them once and passes them in. */
  permissions: readonly PermissionKey[];
  execute(ctx: ExecutionContext<P>): Promise<Execution<T>>;
  /**
   * Set to let the runner cache this report's answers for that many milliseconds. Leave unset when the executor
   * already caches (the overview does), so an answer is never cached twice.
   */
  runnerCacheMs?: number;
}

export interface ReportAuditEntry {
  userId: string;
  reportCode: string;
  action: 'run' | 'export';
  params: unknown;
  definitionsVersion: string;
  rowCount: number | null;
  truncated: boolean;
  /** csv, xlsx or pdf for a download. */
  format?: 'csv' | 'xlsx' | 'pdf';
  /** SHA-256 of the downloaded file. */
  contentHash?: string;
}

/** Where audited runs and every download are written (the database-backed one is in `audit/report-audit-service.ts`). */
export interface ReportAuditSink {
  record(entry: ReportAuditEntry): Promise<void>;
}

export const NO_AUDIT: ReportAuditSink = { record: () => Promise.resolve() };

/** Reports that reveal personal, bank or pay data are audited on every run; cost and ordinary reports are not. */
const AUDITED = new Set<ReportDefinition['sensitivity']>(['personal', 'bank', 'pay']);

const CACHE_ENTRIES = 200;

/** One run, with its parameters already read: what is left is to execute it for a viewer. */
export interface PreparedRun {
  params: unknown;
  execute(ctx: Omit<ExecutionContext<unknown>, 'params'>): Promise<Execution<unknown>>;
}

/**
 * An executor with its parameter type closed over, so the runner can hold executors of different reports in one list
 * without losing type safety inside each one. Build it with `registerExecutor`.
 */
export interface RegisteredExecutor {
  code: string;
  permissions: readonly PermissionKey[];
  runnerCacheMs?: number;
  prepare(raw: unknown): { ok: true; run: PreparedRun } | { ok: false; error: string };
}

export function registerExecutor<P, T>(executor: ReportExecutor<P, T>): RegisteredExecutor {
  return {
    code: executor.code,
    permissions: executor.permissions,
    ...(executor.runnerCacheMs === undefined ? {} : { runnerCacheMs: executor.runnerCacheMs }),
    prepare: (raw) => {
      const read = executor.readParams(raw);
      if (!read.ok) return read;
      return {
        ok: true,
        run: {
          params: read.params,
          execute: (ctx) => executor.execute({ ...ctx, params: read.params }),
        },
      };
    },
  };
}

export class ReportRunner {
  private readonly executors = new Map<string, RegisteredExecutor>();
  private readonly caches = new Map<string, ResultCache<Execution<unknown>>>();

  constructor(
    private readonly deps: {
      access: Pick<AccessControlService, 'can'>;
      executors: readonly RegisteredExecutor[];
      audit?: ReportAuditSink;
      clock?: () => Date;
      /** The registry to serve; defaults to the platform's own. Tests pass a small one. */
      reports?: readonly ReportDefinition[];
    },
  ) {
    for (const e of deps.executors) this.executors.set(e.code, e);
  }

  /** The registry entry for a code, or nothing. */
  definition(code: string): ReportDefinition | undefined {
    return this.find(code);
  }

  private get reports(): readonly ReportDefinition[] {
    return this.deps.reports ?? REPORTS;
  }

  private find(code: string): ReportDefinition | undefined {
    return this.deps.reports === undefined
      ? findReport(code)
      : this.reports.find((r) => r.code === code);
  }

  /** The reports this person may open, with every permission checked once. */
  async list(userId: string): Promise<ReportDefinition[]> {
    const keys = [...new Set(this.reports.flatMap((r) => r.permissions))];
    const held = await this.holding(userId, keys);
    return this.deps.reports === undefined
      ? visibleReports(held)
      : this.reports.filter((r) => r.permissions.every((p) => held.has(p)));
  }

  /**
   * Produce a report. With `{ table: true }` (an export) the answer also carries its table, so the file writers draw
   * exactly what the screen would show.
   */
  async run<T = unknown>(
    code: string,
    raw: unknown,
    userId: string,
    options: { table?: boolean } = {},
  ): Promise<RunResult<T>> {
    const wantTable = options.table === true;
    const def = this.find(code);
    const executor = this.executors.get(code);
    if (def === undefined || executor === undefined) {
      return { ok: false, code: 'unknown_report', error: 'That report does not exist.' };
    }

    // Refuse before anything is read: the viewer must hold every permission the report needs.
    const needed = [...new Set([...def.permissions, ...executor.permissions])];
    const allowed = await this.holding(userId, needed);
    if (!def.permissions.every((p) => allowed.has(p))) {
      return { ok: false, code: 'forbidden', error: 'You do not have access to this report.' };
    }

    const prepared = executor.prepare(raw);
    if (!prepared.ok) return { ok: false, code: 'bad_params', error: prepared.error };
    const params = prepared.run.params;

    const now = (this.deps.clock ?? (() => new Date()))();
    const work = () =>
      prepared.run.execute({ userId, allowed, now, maxRows: def.maxRows, wantTable });

    try {
      const { execution, cached } = await this.withLimits(
        def,
        executor,
        params,
        userId,
        allowed,
        wantTable,
        work,
      );
      const meta: RunMeta = {
        code: def.code,
        asOf: execution.asOf ?? now.toISOString(),
        tier: def.tier,
        definitionsVersion: catalogueVersion(),
        cached: cached || execution.cached === true,
        truncated: execution.truncated === true,
        tieOut: { declared: def.tieOut.kind, checked: false },
      };
      await this.audit(def, userId, params, meta);
      return {
        ok: true,
        data: execution.data as T,
        meta,
        params,
        ...(execution.table === undefined ? {} : { table: execution.table }),
      };
    } catch (error) {
      if (error instanceof TimedOut) {
        return {
          ok: false,
          code: 'timeout',
          error: 'This report took too long. Narrow the period or the branch and try again.',
        };
      }
      console.error(`[reports.run] ${def.code} failed`, error);
      return {
        ok: false,
        code: 'failed',
        error: 'This report could not be produced just now. Please try again.',
      };
    }
  }

  // ---------- internals ----------

  private async holding(
    userId: string,
    keys: readonly PermissionKey[],
  ): Promise<Set<PermissionKey>> {
    const checks = await Promise.all(
      keys.map(async (k) => [k, await this.deps.access.can(userId, k)] as const),
    );
    return new Set(checks.filter(([, ok]) => ok).map(([k]) => k));
  }

  private async withLimits(
    def: ReportDefinition,
    executor: RegisteredExecutor,
    params: unknown,
    userId: string,
    allowed: ReadonlySet<PermissionKey>,
    wantTable: boolean,
    work: () => Promise<Execution<unknown>>,
  ): Promise<{ execution: Execution<unknown>; cached: boolean }> {
    const limited = () => withTimeout(work(), def.timeoutMs);
    const ttl = executor.runnerCacheMs;
    if (ttl === undefined) return { execution: await limited(), cached: false };

    let cache = this.caches.get(def.code);
    if (cache === undefined) {
      cache = new ResultCache<Execution<unknown>>(ttl, CACHE_ENTRIES, () =>
        (this.deps.clock ?? (() => new Date()))().getTime(),
      );
      this.caches.set(def.code, cache);
    }
    // The key carries everything that changes the answer, including the viewer's permissions and the catalogue
    // version, so one person's answer is never served to someone allowed less.
    const key = JSON.stringify([
      params,
      [...allowed].sort(),
      catalogueVersion(),
      userScopeKey(def, userId),
      wantTable,
    ]);
    const { value, source } = await cache.getOrCompute(key, limited);
    return { execution: value, cached: source !== 'fresh' };
  }

  private async audit(
    def: ReportDefinition,
    userId: string,
    params: unknown,
    meta: RunMeta,
  ): Promise<void> {
    if (!AUDITED.has(def.sensitivity)) return;
    try {
      await (this.deps.audit ?? NO_AUDIT).record({
        userId,
        reportCode: def.code,
        action: 'run',
        params,
        definitionsVersion: meta.definitionsVersion,
        rowCount: null,
        truncated: meta.truncated,
      });
    } catch (error) {
      // An audit failure is reported loudly but never blocks a read the person is allowed to make.
      console.error(`[reports.run] audit of ${def.code} failed`, error);
    }
  }
}

/** A report whose answer depends on who asks beyond their permissions (their own branch) is cached per person. */
function userScopeKey(def: ReportDefinition, userId: string): string {
  return def.scope === 'company' ? '' : userId;
}

class TimedOut extends Error {}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimedOut());
    }, ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
